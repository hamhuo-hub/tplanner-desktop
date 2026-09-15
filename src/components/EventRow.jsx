import { format, areIntervalsOverlapping, max, min, addMinutes } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import EventBlock from './EventBlock';
import { MarkdownPreview } from './NoteEditor';
import { useTranslation } from 'react-i18next';
import { getDateLocale } from '../utils/dateLocale';
import { useState, useRef, useEffect, useMemo } from 'react';
import { marked } from 'marked';
import { assignOverlapGroupLanes, computeCascadeLayout } from '../utils/laneLayout';
import { timeline } from '../design-system';

export default function EventRow({ date, events, onEventClick, onAddEvent, highlight, onDragStart, dragState, clashes, displayTimezone, onToggleTaskComplete, journalText, onContextMenu, selectedIds }) {
    const { t, i18n } = useTranslation();
    const locale = getDateLocale(i18n.language);

    // ── Day boundaries in the DISPLAY timezone ──────────────────────────────
    // Using fromZonedTime so that "Apr 24" always means Apr 24 00:00–23:59
    // in the selected timezone, not in the browser's local timezone.
    const tz = displayTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dateStr = format(date, 'yyyy-MM-dd'); // always local-date label (Apr 24)
    const dayStart = fromZonedTime(`${dateStr}T00:00:00`, tz);
    const dayEnd   = fromZonedTime(`${dateStr}T23:59:59.999`, tz);

    // Only records with an instant land on the time axis. A record with no DTSTART/DUE has
    // no position here and is deliberately absent rather than drawn at midnight.
    const dayEventsRaw = events.filter(e => e.start instanceof Date && !Number.isNaN(e.start.getTime())
        && areIntervalsOverlapping({ start: e.start, end: e.end }, { start: dayStart, end: dayEnd }));

    // Clamp & sort
    const processedRegularEvents = dayEventsRaw.map(e => ({
        ...e, originalStart: e.start, originalEnd: e.end,
        start: max([e.start, dayStart]), end: min([e.end, dayEnd])
    })).sort((a, b) => a.start - b.start);

    // ── Lane assignment ───────────────────────────────────────────────────
    // Completed tasks are rendered as background "shadows": history stays visible without
    // pretending to still occupy the day's schedule.
    const completedTasks  = processedRegularEvents.filter(e => e.completed);
    const activeEvents    = processedRegularEvents.filter(e => !e.completed);

    // ── Cascade geometry (TPlanner's rotated Google algorithm) ─────────────
    // Columns are LOCAL to overlap groups, and the conflict axis is vertical:
    // column i starts at i × eventSummaryHeight and bottom-aligns with column 0,
    // so a later column covers the body of earlier columns while each event's
    // fixed 27px summary zone (overlapReveal = eventSummaryHeight) stays
    // visible. The event area grows only with the day's maximum column count —
    // an isolated afternoon event keeps the full height even after a 3-way
    // morning clash.
    const { assigned: activeWithLane, groups: laneGroups } = assignOverlapGroupLanes(activeEvents);
    const { rows: cascadeRows, eventAreaHeight, maxColumns } = computeCascadeLayout({
        assigned: activeWithLane,
        groups: laneGroups,
        tokens: timeline,
    });

    // V5 has no background "status band" record kind, so there is no top strip: the event
    // area owns the whole row height.
    const statusStripPx = 0;
    const rowHeightPx = eventAreaHeight;

    const finalRegularEvents = [
        // Active events (no reminders) in their cascade columns
        ...activeWithLane.map((ev, idx) => {
            const { topPx, heightPx } = cascadeRows[idx];
            return {
                ...ev,
                isShadow: false,
                isConflicting: clashes ? clashes.some(c => c.eventId === ev.id) : false,
                laneTopPx:    statusStripPx + topPx,
                laneHeightPx: heightPx,
            };
        }),
        // Completed tasks as shadows — always behind, full column 0 geometry
        ...completedTasks.map(ev => ({
            ...ev,
            isShadow: true,
            laneIdx:       0,
            isConflicting: false,
            laneTopPx:    statusStripPx + timeline.eventGap,
            laneHeightPx: eventAreaHeight - 2 * timeline.eventGap,
        })),
    ];

    const isWeekend = date.getDay() === 0 || date.getDay() === 6;

    // ── Journal hover popup ──────────────────────────────────────────────
    const [journalOpen, setJournalOpen] = useState(false);
    const dateColRef = useRef(null);
    const popupRef = useRef(null);

    const renderedMarkdown = useMemo(() => {
        const result = marked.parse(journalText || '', { async: false, breaks: true });
        return typeof result === 'string' ? result : '';
    }, [journalText]);

    // Close popup when clicking outside
    useEffect(() => {
        if (!journalOpen) return;
        const handler = (e) => {
            if (!popupRef.current?.contains(e.target) && !dateColRef.current?.contains(e.target)) {
                setJournalOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [journalOpen]);
    const handleGridClick = (e) => {
        if (e.target.closest('.event-block')) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const clickMinutes = Math.round((24 * 60 * (e.clientX - rect.left) / rect.width) / 10) * 10;
        const clickDate = new Date(dayStart);
        clickDate.setMinutes(clickMinutes);
        onAddEvent?.(clickDate, addMinutes(clickDate, 60));
    };

    return (
        <div id={`row-${format(date, 'yyyy-MM-dd')}`}
             className={`event-row ${isWeekend ? 'event-row--weekend' : 'event-row--weekday'}`}
             style={{ minHeight: rowHeightPx, position: 'relative', zIndex: journalOpen ? 50 : 'auto' }}
        >
            {/* Date Column */}
            <div
                className="event-row-date"
                ref={dateColRef}
                style={{ cursor: 'pointer' }}
                onClick={() => setJournalOpen(v => !v)}
                title={t('journal.label')}
            >
                <span className="event-row-date-dow">{format(date, 'EEE', { locale })}</span>
                <span className={`event-row-date-num${isWeekend ? ' event-row-date-num--weekend' : ''}`}>
                    {format(date, 'd')}
                    <span className="event-row-date-month">
                        {format(date, 'MMM', { locale })}
                    </span>
                </span>
                {/* Dot indicator when journal has content */}
                {journalText && (
                    <span className="event-row-journal-dot" />
                )}

                {/* Journal popup — WYSIWYG: transparent textarea overlays live preview */}
                {journalOpen && (
                    <div
                        ref={popupRef}
                        onClick={e => e.stopPropagation()}
                        className="journal-popup"
                        style={{
                            position: 'absolute',
                            left: '100%',
                            top: 0,
                            zIndex: 200,
                            width: 280,
                            display: 'flex',
                            flexDirection: 'column',
                        }}
                    >
                        {/* Header */}
                        <span className="journal-popup__header">
                            {format(date, i18n.language === 'zh' ? 'M月d日' : 'MMM d', { locale })} · {t('journal.label')}
                        </span>

                        {/* Read-only markdown preview */}
                        <MarkdownPreview className="journal-md-preview journal-popup__preview"
                            html={renderedMarkdown} placeholder={t('journal.placeholder')} />
                    </div>
                )}
            </div>

            {/* Grid */}
            <div className="event-row-grid" onClick={handleGridClick}>

                {/* Hour lines */}
                {Array.from({ length: 24 }).map((_, i) => (
                    <div key={i} className="hour-line" style={{ left: `${(i / 24) * 100}%` }} />
                ))}

                {/* Column boundary lines at each header step (full row width) */}
                {maxColumns > 1 && Array.from({ length: maxColumns - 1 }).map((_, i) => {
                    const topPx = statusStripPx + (i + 1) * timeline.eventSummaryHeight;
                    return (
                        <div key={`lane-sep-${i}`} style={{
                            position: 'absolute', left: 0, right: 0,
                            top: `${topPx}px`, height: '1px',
                            background: 'var(--tp-semantic-color-border-subtle)',
                            pointerEvents: 'none', zIndex: 5,
                        }} />
                    );
                })}

                {/* Clash highlight */}
                {highlight && highlight.type !== 'today' && areIntervalsOverlapping(
                    { start: highlight.start, end: highlight.end }, { start: dayStart, end: dayEnd }
                ) && (() => {
                    const hStart = max([highlight.start, dayStart]);
                    const hEnd   = min([highlight.end,   dayEnd]);
                    if (hEnd <= hStart) return null;
                    // 同样必须相对 dayStart（已按 displayTimezone 锚定）做纯毫秒偏移，
                    // 不能用 getHours()/getMinutes()（本地时区 getter）——否则冲突高亮
                    // 会和真实色块错位，见幽灵预览同款 bug。
                    const startMins = (hStart.getTime() - dayStart.getTime()) / 60000;
                    const endMins   = (hEnd.getTime()   - dayStart.getTime()) / 60000;
                    return (
                        <div className="highlight-clash"
                            style={{ position: 'absolute', left: `${(startMins / 1440) * 100}%`, width: `${((endMins - startMins) / 1440) * 100}%`, top: `${statusStripPx}px`, bottom: 0, zIndex: 10, pointerEvents: 'none' }}
                        />
                    );
                })()}

                {/* Today highlight */}
                {highlight?.type === 'today' && areIntervalsOverlapping(
                    { start: highlight.start, end: highlight.end }, { start: dayStart, end: dayEnd }
                ) && (
                    <div className="highlight-today" style={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none', borderRadius: 2 }} />
                )}

                {/* Regular events — lane-positioned, no overlap */}
                {finalRegularEvents.map(event => {
                    const isDragging = dragState?.event?.id === event.id;
                    return (
                        <EventBlock
                            key={event.id}
                            event={event}
                            isConflicting={event.isConflicting}
                            isShadow={event.isShadow}
                            isSelected={selectedIds?.has(event.id)}
                            displayTimezone={displayTimezone}
                            onClick={() => onEventClick(events.find(ev => ev.id === event.id) || event)}
                            onToggleTaskComplete={onToggleTaskComplete}
                            onDragStart={e => !event.isShadow && onDragStart(event, e.clientX, e.clientY, date)}
                            onContextMenu={(e, ev) => onContextMenu?.(e, events.find(o => o.id === ev.id) || ev)}
                            style={{
                                position: 'absolute',
                                top:    `${event.laneTopPx}px`,
                                height: `${event.laneHeightPx}px`,
                                zIndex: event.isShadow ? 5 : 10 + event.laneIdx,
                                opacity: isDragging ? 0 : 1,
                                pointerEvents: isDragging ? 'none' : 'auto',
                            }}
                        />
                    );
                })}

                {/* Drag ghost */}
                {dragState?.snapStart && dragState?.snapEnd && (() => {
                    if (!areIntervalsOverlapping({ start: dayStart, end: dayEnd }, { start: dragState.snapStart, end: dragState.snapEnd })) return null;
                    const rangeStart = max([dayStart, dragState.snapStart]);
                    const rangeEnd   = min([dayEnd,   dragState.snapEnd]);
                    // 必须相对 dayStart（已按 displayTimezone 锚定）做纯毫秒偏移计算，
                    // 不能用 getHours()/getMinutes()——那是浏览器本地时区的 getter，
                    // 当 displayTimezone 与本地时区不同时，幽灵预览会和真实色块错位。
                    const startMins  = (rangeStart.getTime() - dayStart.getTime()) / 60000;
                    let   endMins    = (rangeEnd.getTime()   - dayStart.getTime()) / 60000;
                    if (endMins === 0 && rangeEnd > rangeStart) endMins = 1440;
                    return (
                        <EventBlock
                            event={{ ...dragState.event, start: dragState.snapStart, end: dragState.snapEnd }}
                            isConflicting={false}
                            displayTimezone={displayTimezone}
                            onClick={() => {}}
                            style={{
                                left: `${(startMins / 1440) * 100}%`,
                                width: `${((endMins - startMins) / 1440) * 100}%`,
                                top: `${statusStripPx + timeline.eventGap}px`, height: `${eventAreaHeight - timeline.eventGap - timeline.eventSummaryHeight}px`, zIndex: 50, position: 'absolute',
                                opacity: 1, border: '2px dashed var(--tp-semantic-color-focus)',
                            }}
                        />
                    );
                })()}
            </div>
        </div>
    );
}
