import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { categoryForId } from '../design-system/tokens.js';
import WidgetRoot from './WidgetRoot.jsx';
import { widgetApi } from './useWidgetWindow.js';

/* tPlanner Today Widget.
 *
 * It renders the read-only projection that the React renderer pushes to main: rows carry
 * { uid, title, start, due, completed, checklist, note, colorId, dateKey, repeats, pending }
 * with epoch-millisecond times and null for an absent time. Ticking a task is an INTENT —
 * main relays it to the renderer, which owns the canonical store. This window never persists
 * anything and never assumes an intent applied.
 */

const DOWS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** Completed-section fold state survives a restart, same key and default as before. */
const COLLAPSED_KEY = 'widget_completed_collapsed';
/** Below this remaining time a scheduled task is 即将到期 rather than 稍后. */
const SOON_WINDOW_MS = 5 * 60 * 1000;
/** Re-render cadence so 即将到期/已逾期 stays accurate between projections. */
const CLOCK_TICK_MS = 30 * 1000;

const SECTIONS = [
    { key: 'current', label: '即将到期' },
    { key: 'upcoming', label: '稍后' },
    { key: 'past', label: '已逾期' },
    { key: 'unscheduled', label: '无时间' },
];

const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const fmtTime = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtDate = (d) => `${d.getMonth() + 1}月${d.getDate()}日 · ${DOWS[d.getDay()]}`;
const todayKeyOf = (now) => `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
const hasTime = (value) => value !== null && value !== undefined;

/** A task's deadline is DUE when present, otherwise DTSTART. Never invented. */
const dueAt = (row) => row.due ?? row.start ?? null;

function statusFor(row, nowTs) {
    const deadline = dueAt(row);
    if (deadline === null) return 'unscheduled';
    if (deadline < nowTs) return 'past';
    if (deadline - nowTs <= SOON_WINDOW_MS) return 'soon';
    return 'future';
}

// Today = today's date key, or anything already overdue and unfinished. `dateKey` is computed
// once by the renderer with the user's display timezone, so this window never re-derives a
// date and cannot disagree with the main window.
function rowsForToday(rows, now) {
    const nowTs = now.getTime();
    const today = todayKeyOf(now);
    return rows.filter((row) => {
        if (row.dateKey === today) return true;
        const deadline = dueAt(row);
        return deadline !== null && deadline < nowTs && !row.completed;
    }).sort((a, b) => {
        const left = dueAt(a);
        const right = dueAt(b);
        if (left === null) return right === null ? String(a.title).localeCompare(String(b.title)) : 1;
        if (right === null) return -1;
        return left - right;
    });
}

function groupToday(todays, nowTs) {
    const groups = { current: [], upcoming: [], past: [], done: [], unscheduled: [] };
    todays.forEach((row) => {
        // Completed tasks go to a dedicated "done" group.
        if (row.completed) { groups.done.push(row); return; }
        const status = statusFor(row, nowTs);
        if (status === 'unscheduled') groups.unscheduled.push(row);
        else if (status === 'past') groups.past.push(row);
        else if (status === 'soon') groups.current.push(row);
        else groups.upcoming.push(row);
    });
    return groups;
}

function EmptyState({ icon, text, spin = false, error = false, role }) {
    return (
        <div className={`empty${error ? ' error' : ''}`} role={role}>
            <div className={`empty-icon${spin ? ' spin' : ''}`} aria-hidden="true">{icon}</div>
            <div className="empty-text">{text}</div>
        </div>
    );
}

function TaskRow({ row, nowTs, api }) {
    // Subtask folding is per row and now survives a re-render. The vanilla renderer rebuilt
    // the whole list on every projection and every 30s tick, which silently re-expanded
    // every checklist the user had folded away.
    const [subtasksOpen, setSubtasksOpen] = useState(true);

    const status = statusFor(row, nowTs);
    const completed = Boolean(row.completed);
    const checklist = row.checklist || [];
    const hasChecklist = checklist.length > 0;
    const doneCount = checklist.filter((item) => item.completed).length;
    const allDone = hasChecklist ? doneCount === checklist.length : true;
    // Block the parent toggle until every checklist item is done.
    const blocked = hasChecklist && !allDone && !completed;

    const category = categoryForId(row.colorId);
    const label = row.title || '无标题任务';
    const timeLabel = !hasTime(row.start)
        ? (hasTime(row.due) ? `截止 ${fmtTime(row.due)}` : '无时间')
        : (hasTime(row.due) ? `${fmtTime(row.start)} – ${fmtTime(row.due)}` : fmtTime(row.start));

    return (
        <div
            className={`item task${completed ? ' done' : ''}${!completed && status === 'past' ? ' past' : ''}`}
            data-category-id={category.id}
            style={{
                '--category-accent': category.accent,
                '--category-foreground': category.foreground,
                '--category-background': category.background,
                '--category-border': category.border,
            }}
        >
            <button
                type="button"
                className="task-check"
                role="checkbox"
                aria-checked={completed}
                aria-label={blocked
                    ? `请先完成所有子任务：${label}`
                    : `${completed ? '取消完成：' : '完成：'}${label}`}
                title={blocked ? '请先完成所有子任务' : ''}
                disabled={blocked}
                onClick={(event) => {
                    event.stopPropagation();
                    if (!blocked) api?.toggleTask(row.uid);
                }}
            >
                <span className="check-mark" aria-hidden="true">{completed ? '✓' : ''}</span>
            </button>

            <div className="item-body">
                <div className="item-row1">
                    <span className="item-title" title={row.title || ''}>{row.title || '(无标题)'}</span>
                    {hasChecklist && (
                        <button
                            type="button"
                            className={`progress-badge${allDone ? ' done-all' : ''}`}
                            aria-expanded={subtasksOpen}
                            aria-label={`子任务：已完成 ${doneCount} 项，共 ${checklist.length} 项；收起或展开`}
                            onClick={(event) => { event.stopPropagation(); setSubtasksOpen((open) => !open); }}
                        >{doneCount}/{checklist.length}</button>
                    )}
                    {completed
                        ? <span className="item-tag done">完成</span>
                        : status === 'soon'
                            ? <span className="item-tag soon">即将</span>
                            : status === 'past'
                                ? <span className="item-tag past">已逾期</span>
                                : null}
                    {row.pending ? <span className="item-tag soon">待上传</span> : null}
                </div>

                <div className="item-row1">
                    <span className="item-time">{timeLabel}</span>
                    {row.note ? <span className="item-note" title={row.note}>{row.note}</span> : null}
                </div>

                {hasChecklist && (
                    <div className="subtask-list" style={subtasksOpen ? undefined : { display: 'none' }}>
                        {checklist.map((sub) => (
                            <button
                                key={sub.id}
                                type="button"
                                className="subtask-item"
                                role="checkbox"
                                aria-checked={Boolean(sub.completed)}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    api?.toggleSubtask(row.uid, sub.id);
                                }}
                            >
                                <span className="check-mark" aria-hidden="true">{sub.completed ? '✓' : ''}</span>
                                <span className={`subtask-text${sub.completed ? ' done' : ''}`}>{sub.text || ''}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function TodayWidget() {
    const api = widgetApi();
    // null = no projection has arrived yet, which is the loading state.
    const [rows, setRows] = useState(null);
    const [now, setNow] = useState(() => new Date());
    const [collapsed, setCollapsedState] = useState(() => localStorage.getItem(COLLAPSED_KEY) !== 'false');

    const setCollapsed = useCallback((value) => {
        setCollapsedState(value);
        localStorage.setItem(COLLAPSED_KEY, value ? 'true' : 'false');
    }, []);

    // A projection replaces local state wholesale and re-reads the clock, exactly like the
    // vanilla render pass did.
    const applyRows = useCallback((list) => {
        setRows(Array.isArray(list) ? list.slice() : []);
        setNow(new Date());
    }, []);

    useEffect(() => {
        if (!api) return undefined;
        let live = true;
        const accept = (list) => { if (live) applyRows(list); };
        // Initial pull from main (the renderer pushes an update as soon as it has one).
        api.getEvents().then(accept).catch(() => accept([]));
        const off = api.onEvents(accept);
        return () => { live = false; off?.(); };
    }, [api, applyRows]);

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
        return () => clearInterval(timer);
    }, []);

    const refresh = useCallback(() => {
        if (!api) return;
        api.getEvents().then(applyRows).catch(() => applyRows([]));
    }, [api, applyRows]);

    const ready = rows !== null;
    const nowTs = now.getTime();
    const todays = useMemo(() => (rows ? rowsForToday(rows, now) : []), [rows, now]);
    const groups = useMemo(() => groupToday(todays, nowTs), [todays, nowTs]);
    const taskDone = todays.filter((row) => row.completed).length;

    let body;
    if (!api) {
        // Preload not loaded — say so clearly instead of rendering an empty note.
        body = <EmptyState role="alert" error icon="!" text="暂时无法加载今日安排，请重新打开便签。" />;
    } else if (!ready) {
        body = <EmptyState role="status" spin icon="↻" text="加载中…" />;
    } else if (todays.length === 0) {
        body = <EmptyState icon="✓" text="今天没有安排，享受清闲吧" />;
    } else {
        body = (
            <>
                {SECTIONS.map((section) => {
                    const list = groups[section.key];
                    if (list.length === 0) return null;
                    return (
                        <Fragment key={section.key}>
                            <div className="group-label">{section.label}<span className="count">{list.length}</span></div>
                            {list.map((row) => <TaskRow key={row.uid} row={row} nowTs={nowTs} api={api} />)}
                        </Fragment>
                    );
                })}

                {groups.done.length > 0 && (
                    <>
                        <button
                            type="button"
                            className="group-label group-toggle"
                            aria-expanded={!collapsed}
                            aria-controls="completed-items"
                            onClick={() => setCollapsed(!collapsed)}
                        >已完成 <span className="count">{groups.done.length}</span><span aria-hidden="true">{collapsed ? '▶' : '▼'}</span></button>
                        <div id="completed-items" style={collapsed ? { display: 'none' } : undefined}>
                            {groups.done.map((row) => <TaskRow key={row.uid} row={row} nowTs={nowTs} api={api} />)}
                        </div>
                    </>
                )}
            </>
        );
    }

    return (
        <WidgetRoot
            title={ready ? fmtDate(now) : '今日'}
            subtitle={!ready ? '今日事件' : (todays.length === 0 ? '今日空闲' : `今日 ${todays.length} 项`)}
            bodyId="list"
            bodyLabel="今日安排"
            onRefresh={refresh}
            stats={ready
                ? <><span>任务 {taskDone}/{todays.length}</span><span>· {fmtTime(now)}</span></>
                : <span>--</span>}
        >
            {body}
        </WidgetRoot>
    );
}
