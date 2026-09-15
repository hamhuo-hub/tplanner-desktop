import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { Plus, Languages, Printer, Download, LogOut, FileText, LayoutList, CalendarDays } from 'lucide-react';
import TaskList from './components/TaskList';
import Timeline from './components/Timeline';
import AddEventModal from './components/AddEventModal';
import EventDetailsModal from './components/EventDetailsModal';
import ClashBanner from './components/ClashBanner';
import OverdueBanner from './components/OverdueBanner';
import ReminderBanner from './components/ReminderBanner';
import TitleBar from './components/TitleBar';
import ZoomControl from './components/ZoomControl';
import LanSync from './components/LanSync';
import DebugPanel from './components/DebugPanel';
import ContextMenu from './components/ContextMenu';
import LoginScreen from './components/LoginScreen';
import { checkForClashes, calculateTimelineRange } from './utils/dateUtils';
import { TIMEZONES } from './utils/constants';
import useSyncV5 from './hooks/useSyncV5';
import { clearSession, storedSession } from './syncV5/session.js';
import {
    dateGroups, duplicateTask, inboxRows, noteRows, noteUpdate, rowsOnDay, todayRows, viewRows, withChecklist,
} from './syncV5/document.js';
import { downloadIcs, exportToIcs } from './syncV5/ics.js';
import { exportElectronProjection, showTodayWidget } from './syncV5/platform.js';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
const CLOSED_EDITOR = { open: false, row: null, dayKey: null };

/** The three views the product keeps, plus the editor's create target. */
const VIEWS = ['today', 'inbox', 'date'];

function PlannerApp({ session, onSignOut }) {
    const { t, i18n } = useTranslation();
    const sync = useSyncV5(session);
    const [travelTimezone, setTravelTimezone] = useState(() => globalThis.localStorage?.getItem('tplanner_travel_timezone') || '');
    const [mode, setMode] = useState('date');
    const [dateMode, setDateMode] = useState('list');
    const [viewRange, setViewRange] = useState(() => calculateTimelineRange([], new Date()));
    const [editor, setEditor] = useState(CLOSED_EDITOR);
    const [selectedUid, setSelectedUid] = useState(null);
    const [contextMenu, setContextMenu] = useState(null);
    const [notice, setNotice] = useState('');
    const [highlight, setHighlight] = useState(null);
    const lastPushRef = useRef('');
    const lastNoteRef = useRef('');

    const { documents } = sync;
    const options = useMemo(() => ({ timeZone: travelTimezone }), [travelTimezone]);
    const todayKey = format(new Date(), 'yyyy-MM-dd');

    /**
     * One projection, four read-only views. `viewRows` reads the canonical jCal arrays;
     * nothing below re-models a task.
     */
    const view = useMemo(() => {
        const all = viewRows(documents, options);
        const tasks = all.filter((row) => row.kind === 'task');
        return {
            tasks,
            notes: noteRows(documents, options),
            today: todayRows(tasks, todayKey),
            inbox: inboxRows(tasks),
            dated: dateGroups(tasks, todayKey),
        };
    }, [documents, options, todayKey]);

    const scheduled = useMemo(
        () => view.tasks.filter((row) => row.start instanceof Date && !Number.isNaN(row.start.getTime())),
        [view.tasks],
    );
    const clashes = useMemo(() => checkForClashes(view.tasks), [view.tasks]);
    const journals = useMemo(() => {
        const map = {};
        for (const [dayKey, row] of view.notes) map[dayKey] = row.document.description ?? '';
        return map;
    }, [view.notes]);

    const selectedRow = useMemo(
        () => (selectedUid ? view.tasks.find((row) => row.uid === selectedUid) ?? null : null),
        [selectedUid, view.tasks],
    );

    const highlightRange = useCallback((range) => {
        setHighlight(range);
        setTimeout(() => setHighlight(null), 3000);
    }, []);

    // ── Electron shell projection (widget / tray) ─────────────────────────────
    // The renderer owns the canonical store, so main receives a read-only projection and
    // reports widget interactions back as intents. This is not a second data model.
    useEffect(() => {
        if (!isElectron) return;
        const payload = view.tasks.map((row) => ({
            uid: row.uid,
            title: row.title,
            start: row.start,
            due: row.due,
            completed: row.completed,
            checklist: row.checklist,
            note: row.note,
            colorId: row.colorId,
            repeats: row.repeats,
            pending: row.pending,
            dateKey: row.dateKey,
        }));
        const serialized = JSON.stringify(payload);
        if (serialized === lastPushRef.current) return;
        lastPushRef.current = serialized;
        exportElectronProjection(payload);
    }, [view.tasks]);

    // Daily note projection for the Electron notes widget (canonical VJOURNAL text only).
    useEffect(() => {
        if (!isElectron || !window.electronAPI?.publishNote) return;
        const note = view.notes.get(todayKey);
        const payload = { dayKey: todayKey, text: note?.document.description ?? '' };
        const serialized = JSON.stringify(payload);
        if (serialized === lastNoteRef.current) return;
        lastNoteRef.current = serialized;
        window.electronAPI.publishNote(payload);
    }, [view.notes, todayKey]);

    /** Canonical daily-note write: an emptied note is removed instead of stored empty. */
    const writeNote = useCallback(async (dayKey, text) => {
        const uid = `journal:${dayKey}`;
        const entry = documents.find((document) => document.uid === uid) ?? null;
        const existing = entry?.calendar ? viewRows([entry], options)[0].document : null;
        const update = noteUpdate(dayKey, text, existing);
        if (!update) return;
        if (update.operation === 'delete') await sync.removeDocument(uid);
        else await sync.persist(update.document);
    }, [documents, options, sync]);

    // Note widget saves arrive as intents and go through the same store write path.
    useEffect(() => {
        if (!isElectron || !window.electronAPI?.onNoteIntent) return undefined;
        const off = window.electronAPI.onNoteIntent(({ dayKey, text }) => {
            if (typeof text !== 'string' || !dayKey) return;
            writeNote(dayKey, text).catch((error) => console.error('[syncV5] note intent failed', error));
        });
        return () => off?.();
    }, [writeNote]);

    // ── Widget intents ────────────────────────────────────────────────────────
    useEffect(() => {
        if (!isElectron || !window.electronAPI?.onTaskIntent) return undefined;
        const off = window.electronAPI.onTaskIntent(({ uid, completed, checklist }) => {
            const entry = documents.find((document) => document.uid === uid);
            if (!entry) return;
            const row = viewRows([entry], options)[0];
            if (!row) return;
            try {
                let document = row.document;
                if (Array.isArray(checklist)) document = withChecklist(document, checklist);
                if (typeof completed === 'boolean') document = document.withCompleted(completed);
                sync.persist(document);
            } catch (error) {
                console.error('[syncV5] widget intent failed', error);
            }
        });
        return () => off?.();
    }, [documents, options, sync]);

    const handleTimezoneChange = (event) => {
        const value = event.target.value;
        setTravelTimezone(value);
        if (value) globalThis.localStorage?.setItem('tplanner_travel_timezone', value);
        else globalThis.localStorage?.removeItem('tplanner_travel_timezone');
    };

    const flash = (message) => {
        setNotice(message);
        setTimeout(() => setNotice(''), 4000);
    };

    const saveDocument = useCallback((document) => sync.persist(document), [sync]);

    const runSave = async (operation) => {
        try {
            await operation();
        } catch (error) {
            flash(error?.message || t('messages.saveError', '保存失败，请重试'));
        }
    };

    const handleToggleComplete = (row, completed) => runSave(
        () => saveDocument(row.document.withCompleted(completed)),
    );

    const handleToggleChecklist = (row, itemId, completed) => runSave(() => {
        const items = row.checklist.map((item) => (item.id === itemId ? { ...item, completed } : item));
        let document = withChecklist(row.document, items);
        const allDone = items.length > 0 && items.every((item) => item.completed);
        if (allDone) document = document.withCompleted(true);
        else if (row.completed) document = document.withCompleted(false);
        return saveDocument(document);
    });

    const handleDelete = (row) => runSave(async () => {
        await sync.removeDocument(row.uid);
        if (selectedUid === row.uid) setSelectedUid(null);
    });

    const handleDuplicate = (row) => runSave(
        () => saveDocument(duplicateTask(row.document, `${row.title}${t('event.copySuffix')}`)),
    );

    /**
     * Reschedule from the timeline. This is an explicit user action, so writing DTSTART/DUE
     * is the requested edit — never an invented date.
     */
    const handleTimelineUpdate = (updates) => runSave(async () => {
        for (const update of updates) {
            const row = view.tasks.find((item) => item.uid === (update.uid ?? update.id));
            if (!row) continue;
            const start = update.start instanceof Date ? update.start.getTime() : update.start;
            let due = update.end instanceof Date ? update.end.getTime() : update.end;
            if (!Number.isFinite(start)) continue;
            if (!Number.isFinite(due) || due <= start) due = start + 60 * 60 * 1000;
            await saveDocument(row.document.withSchedule(start, due));
        }
    });

    /** Checklist toggles coming from the details editor, expressed as one canonical edit. */
    const handleDetailsSave = (draft, meta) => runSave(async () => {
        const row = meta?.original ?? view.tasks.find((item) => item.uid === draft.uid);
        if (!row) return;
        let document = withChecklist(row.document, draft.checklist ?? row.checklist);
        document = document.withCompleted(Boolean(draft.completed));
        await saveDocument(document);
    });

    const handleSaveNote = (dayKey, text) => runSave(() => writeNote(dayKey, text));

    const handleExportIcs = () => {
        const payload = exportToIcs(documents.map((entry) => entry.calendar));
        if (!payload) {
            flash(t('messages.nothingToExport'));
            return;
        }
        downloadIcs(payload);
    };

    const handleExportJson = () => {
        const payload = JSON.stringify(documents.map((entry) => entry.calendar), null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'tplanner-jcal.json';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const toggleLanguage = () => {
        i18n.changeLanguage(i18n.language === 'en' ? 'zh' : 'en');
    };

    const openAdd = (startValue = undefined, dayKey = null) => {
        setEditor({ open: true, row: null, dayKey, defaultDate: startValue ?? null });
    };

    const openEditor = (row) => setEditor({ open: true, row, dayKey: null, defaultDate: null });

    const handleTodayButton = () => {
        const now = new Date();
        setMode('date');
        setDateMode('timeline');
        setViewRange(calculateTimelineRange(scheduled, now));
        highlightRange({ type: 'today', start: new Date(now.setHours(0, 0, 0, 0)), end: new Date(now.setHours(23, 59, 59, 999)) });
    };

    return (
        <div className="app-container" style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--clr-bg)', overflow: 'hidden' }}>
            {isElectron && <TitleBar />}

            <header className="app-header">
                <div className="app-header-left">
                    {!isElectron && <h1 className="app-header-title">{t('app.title')}</h1>}
                    <button onClick={handleTodayButton} className="btn btn--ghost" id="btn-today">{t('nav.today')}</button>
                    {VIEWS.filter((id) => id !== 'today').map((id) => (
                        <button
                            key={id}
                            onClick={() => setMode(id)}
                            className={`btn ${mode === id ? 'btn--primary' : 'btn--ghost'}`}
                            id={`btn-view-${id}`}
                        >
                            {id === 'inbox' ? t('nav.inbox') : t('nav.dateView')}
                        </button>
                    ))}
                    <button
                        onClick={() => setMode('today')}
                        className={`btn ${mode === 'today' ? 'btn--primary' : 'btn--ghost'}`}
                        id="btn-view-today"
                    >
                        {t('task.today')}
                    </button>
                    {mode === 'date' && (
                        <button
                            className="btn btn--ghost"
                            id="btn-toggle-date-mode"
                            title={t('nav.switchLayout')}
                            onClick={() => setDateMode(dateMode === 'timeline' ? 'list' : 'timeline')}
                        >
                            {dateMode === 'timeline' ? <LayoutList size={13} /> : <CalendarDays size={13} />}
                        </button>
                    )}
                </div>

                <div className="app-header-right">
                    <div className="tz-select-wrap" title={t('app.displayTimezone')}>
                        <CalendarDays size={13} />
                        <select value={travelTimezone} onChange={handleTimezoneChange} className="tz-select" id="tz-select">
                            {TIMEZONES.map((zone) => (
                                <option key={zone.value} value={zone.value}>
                                    {t(`timezones.${zone.value ? zone.value.replace('/', '_') : 'default'}`, zone.label)}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button onClick={toggleLanguage} className="btn btn--ghost" title={t('app.switchLanguage')} id="btn-lang">
                        <Languages size={13} />
                        {i18n.language === 'en' ? '中文' : 'EN'}
                    </button>

                    <button onClick={() => window.print()} className="btn btn--ghost" title={t('app.printCalendar')} id="btn-print">
                        <Printer size={13} />
                    </button>

                    <button onClick={handleExportIcs} className="btn btn--ghost" title={t('actions.exportIcs')} id="btn-export-ics">
                        <Download size={13} />
                    </button>

                    <button onClick={handleExportJson} className="btn btn--ghost" title={t('actions.exportBackup')} id="btn-export-json">
                        <FileText size={13} />
                    </button>

                    <ZoomControl />

                    <LanSync sync={sync} onOpenRecord={(uid) => setSelectedUid(uid)} />

                    <button className="btn btn--ghost" id="btn-signout" title={t('app.signOut')} onClick={onSignOut}>
                        <LogOut size={13} />
                    </button>

                    <button onClick={() => openAdd()} className="btn btn--primary" id="btn-add-task">
                        <Plus size={13} />
                        {t('actions.addTask')}
                    </button>
                </div>
            </header>

            <main style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px', minHeight: 0, gap: '8px' }}>
                <div className="calendar-banners">
                    <ReminderBanner
                        events={view.tasks}
                        travelTimezone={travelTimezone}
                        onHighlight={(range) => { highlightRange(range); setMode('date'); setDateMode('timeline'); }}
                    />
                    <OverdueBanner
                        events={view.tasks}
                        travelTimezone={travelTimezone}
                        onHighlight={(range) => { highlightRange(range); setSelectedUid(rowsOnDay(view.tasks, format(range.start, 'yyyy-MM-dd'))[0]?.uid ?? null); }}
                    />
                    <ClashBanner
                        clashes={clashes}
                        events={view.tasks}
                        travelTimezone={travelTimezone}
                        onHighlight={(range) => { highlightRange(range); setMode('date'); setDateMode('timeline'); }}
                    />
                </div>

                {mode === 'date' && dateMode === 'timeline' ? (
                    <Timeline
                        startDate={viewRange.start}
                        endDate={viewRange.end}
                        events={scheduled}
                        clashes={clashes}
                        highlight={highlight}
                        travelTimezone={travelTimezone}
                        journals={journals}
                        onEventClick={(row) => setSelectedUid(row.uid)}
                        onAddEvent={(start) => openAdd(start)}
                        onUpdateEvent={handleTimelineUpdate}
                        onToggleTaskComplete={(id, completed) => {
                            const row = view.tasks.find((item) => item.uid === id);
                            if (row) handleToggleComplete(row, completed);
                        }}
                        onSaveJournal={handleSaveNote}
                        onContextMenu={(event, row) => setContextMenu({ x: event.clientX, y: event.clientY, row })
                        }
                        onLoadPrev={() => setViewRange((previous) => ({ ...previous, start: new Date(previous.start.getTime() - 14 * 86400000) }))}
                        onLoadNext={() => setViewRange((previous) => ({ ...previous, end: new Date(previous.end.getTime() + 14 * 86400000) }))}
                        selectedIds={new Set()}
                        onSelectionChange={() => {}}
                    />
                ) : (
                    <div className="task-list-scroll">
                        <TaskList
                            mode={mode === 'today' ? 'today' : mode === 'inbox' ? 'inbox' : 'date'}
                            todayRows={view.today}
                            inboxRows={view.inbox}
                            dateGroups={view.dated.groups}
                            noteByDay={view.notes}
                            timeZone={travelTimezone}
                            onOpen={(row) => setSelectedUid(row.uid)}
                            onToggleComplete={handleToggleComplete}
                            onToggleChecklist={handleToggleChecklist}
                            onSaveNote={handleSaveNote}
                            onContextMenu={(event, row) => setContextMenu({ x: event.clientX, y: event.clientY, row })}
                        />
                    </div>
                )}
            </main>

            <AddEventModal
                isOpen={editor.open}
                onClose={() => setEditor(CLOSED_EDITOR)}
                onSave={saveDocument}
                defaultDate={editor.defaultDate}
                initialEvent={editor.row}
                events={view.tasks}
            />

            <EventDetailsModal
                event={selectedRow}
                travelTimezone={travelTimezone}
                onClose={() => setSelectedUid(null)}
                onDelete={(row) => handleDelete(row)}
                onEdit={openEditor}
                onSave={handleDetailsSave}
            />

            {isElectron && <DebugPanel />}

            {notice && <div className="app-toast" role="status">{notice}</div>}

            {isElectron && (
                <button
                    className="btn btn--ghost"
                    style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 8000 }}
                    title={t('app.todayWidget')}
                    onClick={() => showTodayWidget()}
                >
                    {t('app.todayWidget')}
                </button>
            )}

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    row={contextMenu.row}
                    onClose={() => setContextMenu(null)}
                    onCopy={handleDuplicate}
                    onDelete={handleDelete}
                />
            )}
        </div>
    );
}

export default function App() {
    // A stored session is reused immediately: local durability must never depend on the
    // server being reachable at startup (docs/sync-v5.md).
    const [session, setSession] = useState(storedSession);

    if (!session) {
        return <LoginScreen onConnected={setSession} onLogout={undefined} />;
    }

    return (
        <PlannerApp
            session={session}
            onSignOut={() => { clearSession(); setSession(null); }}
        />
    );
}
