import { useState, useMemo, useEffect } from 'react';
import { format, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { useTranslation } from 'react-i18next';
import { Repeat, CalendarClock, Inbox as InboxIcon, NotebookPen } from 'lucide-react';
import { TaskCheckbox, TaskProgress, categoryForId } from '../design-system';
import { getDateLocale } from '../utils/dateLocale';
import NoteEditor from './NoteEditor';

function timeLabel(row, timeZone) {
    if (row.kind === 'note') return '';
    const zone = timeZone || undefined;
    const render = (value) => {
        try {
            return formatInTimeZone(new Date(value), zone || Intl.DateTimeFormat().resolvedOptions().timeZone, 'HH:mm');
        } catch {
            return format(new Date(value), 'HH:mm');
        }
    };
    const dayKey = (value) => {
        try {
            return formatInTimeZone(new Date(value), zone || Intl.DateTimeFormat().resolvedOptions().timeZone, 'yyyy-MM-dd');
        } catch {
            return format(new Date(value), 'yyyy-MM-dd');
        }
    };
    if (row.start === null && row.due === null) return '';
    if (row.start !== null && row.due !== null) {
        return dayKey(row.start) === dayKey(row.due)
            ? `${render(row.start)} – ${render(row.due)}`
            : `${render(row.start)} → ${dayKey(row.due)} ${render(row.due)}`;
    }
    if (row.due !== null) return `⏰ ${render(row.due)}`;
    return render(row.start);
}

function TaskItem({ row, timeZone, onOpen, onToggleComplete, onToggleChecklist, onContextMenu, selectedIds }) {
    const { t } = useTranslation();
    const category = categoryForId(row.colorId);
    const checkboxTitle = row.checklist.length > 0 && row.checklistDone !== row.checklist.length
        ? t('event.subtaskBlocked', { done: row.checklistDone, total: row.checklist.length })
        : row.title;
    const label = timeLabel(row, timeZone);

    return (
        <div
            className={`task-item${row.completed ? ' task-item--completed' : ''}${selectedIds?.has(row.uid) ? ' task-item--selected' : ''}`}
            style={{ borderLeftColor: category.accent }}
            onClick={() => onOpen(row)}
            onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event, row); }}
        >
            <TaskCheckbox
                completed={row.completed}
                disabled={row.checklist.length > 0 && row.checklistDone !== row.checklist.length && !row.completed}
                title={checkboxTitle}
                onToggle={(completed) => onToggleComplete(row, completed)}
            />
            <div className="task-item__body">
                <div className="task-item__row">
                    <span className={`task-item__title${row.completed ? ' task-item__title--completed' : ''}`}>{row.title}</span>
                    {row.checklist.length > 0 && <TaskProgress done={row.checklistDone} total={row.checklist.length} />}
                    {row.repeats && (
                        <span className="task-item__badge" title={row.recurrenceText}>
                            <Repeat size={11} />
                        </span>
                    )}
                    {row.pending && <span className="task-item__badge task-item__badge--pending">{t('sync.pendingBadge')}</span>}
                    {row.conflicted && <span className="task-item__badge task-item__badge--conflict">{t('sync.conflictBadge')}</span>}
                </div>
                <div className="task-item__row task-item__row--meta">
                    {label && <span className="task-item__time">{label}</span>}
                    {!row.scheduled && row.due === null && <span className="task-item__time task-item__time--muted">{t('task.noTime')}</span>}
                    {row.note && <span className="task-item__note">{row.note.split('\n')[0]}</span>}
                </div>
                {row.checklist.length > 0 && (
                    <div className="task-item__checklist">
                        {row.checklist.map((item) => (
                            <button
                                type="button"
                                key={item.id}
                                className="task-item__checklist-row"
                                onClick={(event) => { event.stopPropagation(); onToggleChecklist(row, item.id, !item.completed); }}
                            >
                                <TaskCheckbox
                                    completed={item.completed}
                                    title={item.text}
                                    className="task-item__checklist-box"
                                    onToggle={(completed) => onToggleChecklist(row, item.id, completed)}
                                />
                                <span className={`task-item__checklist-text${item.completed ? ' task-item__checklist-text--done' : ''}`}>{item.text}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function NoteRow({ dayKey, value, onSaveNote, locale, t }) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(value || '');

    useEffect(() => { setDraft(value || ''); }, [value]);

    const label = dayKey ? format(parseISO(dayKey), 'EEEE, d MMMM', { locale }) : t('journal.label');

    return (
        <div className={`note-row${draft.trim() ? ' note-row--filled' : ''}`}>
            <button type="button" className="note-row__header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
                <NotebookPen size={13} />
                <span className="note-row__label">{t('journal.label')}</span>
                <span className="note-row__day">{label}</span>
            </button>
            {open && (
                <div className="note-row__body">
                    <NoteEditor
                        value={draft}
                        onChange={setDraft}
                        onCommit={(text) => onSaveNote(dayKey, text)}
                        placeholder={t('journal.placeholder')}
                    />
                </div>
            )}
        </div>
    );
}

function Group({ title, icon, rows, children, empty }) {
    return (
        <section className="task-group">
            <header className="task-group__header">
                {icon}
                <h2 className="task-group__title">{title}</h2>
                {rows && <span className="task-group__count">{rows.length}</span>}
            </header>
            {children}
            {empty}
        </section>
    );
}

/**
 * The whole Task UI: Notes, Inbox, Today and the date view.
 *
 * It renders read-only rows produced by `src/syncV5/document.js`. It never classifies a
 * record, never invents a time and never holds a second task model.
 */
export default function TaskList({
    mode,
    todayRows,
    inboxRows,
    dateGroups,
    noteByDay,
    timeZone,
    onOpen,
    onToggleComplete,
    onToggleChecklist,
    onSaveNote,
    onContextMenu,
    selectedIds,
}) {
    const { t, i18n } = useTranslation();
    const locale = getDateLocale(i18n.language);

    const renderRows = (rows) => rows.map((row) => (
        <TaskItem
            key={row.uid}
            row={row}
            timeZone={timeZone}
            onOpen={onOpen}
            onToggleComplete={onToggleComplete}
            onToggleChecklist={onToggleChecklist}
            onContextMenu={onContextMenu}
            selectedIds={selectedIds}
        />
    ));

    const emptyState = (
        <p className="task-group__empty">{t('task.empty')}</p>
    );

    if (mode === 'inbox') {
        return (
            <div className="task-list">
                <Group
                    title={t('task.inbox')}
                    icon={<InboxIcon size={14} />}
                    rows={inboxRows}
                    empty={inboxRows.length === 0 ? emptyState : null}
                >
                    {renderRows(inboxRows)}
                </Group>
            </div>
        );
    }

    if (mode === 'today') {
        const todayKey = format(new Date(), 'yyyy-MM-dd');
        return (
            <div className="task-list">
                <Group
                    title={t('task.today')}
                    icon={<CalendarClock size={14} />}
                    rows={todayRows}
                    empty={todayRows.length === 0 ? emptyState : null}
                >
                    {renderRows(todayRows)}
                </Group>
                <NoteRow
                    dayKey={todayKey}
                    value={noteByDay.get(todayKey)?.document.description ?? ''}
                    onSaveNote={onSaveNote}
                    locale={locale}
                    t={t}
                />
            </div>
        );
    }

    return (
        <div className="task-list">
            {dateGroups.length === 0 && inboxRows.length === 0 && emptyState}
            {dateGroups.map((group) => (
                <Group
                    key={group.dayKey}
                    title={format(parseISO(group.dayKey), 'EEEE, d MMMM', { locale })}
                    icon={<CalendarClock size={14} />}
                    rows={group.rows}
                >
                    {renderRows(group.rows)}
                    <NoteRow
                        dayKey={group.dayKey}
                        value={noteByDay.get(group.dayKey)?.document.description ?? ''}
                        onSaveNote={onSaveNote}
                        locale={locale}
                        t={t}
                    />
                </Group>
            ))}
            {inboxRows.length > 0 && (
                <Group
                    title={t('task.inbox')}
                    icon={<InboxIcon size={14} />}
                    rows={inboxRows}
                >
                    {renderRows(inboxRows)}
                </Group>
            )}
        </div>
    );
}

export { TaskItem, timeLabel };
