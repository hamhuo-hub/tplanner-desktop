import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { ThemeProvider } from '@mui/material/styles';
import { LocalizationProvider } from '@mui/x-date-pickers';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { Plus, Globe, Languages, FileText, LogIn, RefreshCw, Eye } from 'lucide-react';
import '../design-assets/tokens/generated/tplanner-light.css';
import '../src/index.css';

const query = new URLSearchParams(location.search);
const profile = query.get('profile') === 'desktop' ? 'desktop' : 'web';
const clean = query.get('clean') === '1';
const RealDate = window.Date;
const fixtureNow = new RealDate('2026-09-08T10:30:00+08:00').getTime();
// Only this isolated review document freezes the clock. Production modules are unchanged.
window.Date = class ReviewDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixtureNow])); }
    static now() { return fixtureNow; }
};

if (profile === 'desktop') {
    const listeners = new Set();
    let maximized = false;
    // UI-only stub: no IPC, filesystem, synchronization or native window operations.
    window.electronAPI = Object.freeze({
        isMaximized: async () => maximized,
        onMaximizeChange: callback => { listeners.add(callback); return () => listeners.delete(callback); },
        maximize: () => { maximized = !maximized; listeners.forEach(callback => callback(maximized)); },
        minimize: () => {},
        close: () => {},
    });
}

// Import after the profile stub so the real MUI theme and token installer see the right platform.
const [
    { default: i18n }, { default: theme }, { installDesignTokens },
    { default: TaskList }, { default: Timeline }, { default: AddEventModal }, { default: EventDetailsModal },
    { default: NoteEditor }, { default: LoginScreen }, { default: TitleBar },
    { default: ClashBanner }, { default: OverdueBanner }, { default: ReminderBanner },
    { checkForClashes, calculateTimelineRange },
    { buildTask, buildNote, dateGroups, inboxRows, noteRows, todayRows, viewRows },
] = await Promise.all([
    import('../src/i18n'), import('../src/theme'), import('../src/design-system'),
    import('../src/components/TaskList'), import('../src/components/Timeline'), import('../src/components/AddEventModal'), import('../src/components/EventDetailsModal'),
    import('../src/components/NoteEditor'), import('../src/components/LoginScreen'), import('../src/components/TitleBar'),
    import('../src/components/ClashBanner'), import('../src/components/OverdueBanner'), import('../src/components/ReminderBanner'),
    import('../src/utils/dateUtils'),
    import('../src/syncV5/document.js'),
]);
installDesignTokens();
await i18n.changeLanguage(query.get('lang') === 'en' ? 'en' : 'zh');

const fixtureNote = '# 浅色工作记录\n\n长中文正文与 English metadata 共用系统字体。**重点内容**、*补充说明*与[站内链接](#review-notes)保持清晰。\n\n- [x] 已核对分类与文字配对\n- [ ] 检查键盘焦点和子任务阻塞\n\n> 已完成任务保持可读，用划线和图标表达状态。\n\n```js\nconst colorId = 3;\n```\n\n---\n\n支持行内编辑、全文分栏和 Markdown 清单。';
const at = (day, time) => new RealDate(`2026-09-${String(day).padStart(2, '0')}T${time}:00+08:00`).getTime();
const startDate = new Date(2026, 8, 7);
const endDate = new Date(2026, 8, 11);
const todayKey = '2026-09-08';
const currentDay = { type: 'today', start: at(8, '00:00'), end: at(9, '00:00') };

/** Fixtures are real canonical jCal documents, exactly what the V5 store projects. */
function makeFixtures() {
    const labels = ['蓝 · 需求梳理', '金 · 当前评审', '玫瑰 · 内容校对', '绿 · 午后计划', '紫 · 深度工作', '陶橙 · 长中文任务标题检验和跨端复核', '青 · 项目同步', '灰 · 收尾检查'];
    const documents = labels.map((title, colorId) => buildTask(title, {
        start: at(8, `${String(8 + (colorId % 4) * 2).padStart(2, '0')}:00`),
        due: at(8, `${String(10 + (colorId % 4) * 2).padStart(2, '0')}:00`),
    }).withColorId(colorId).withDescription(fixtureNote).calendar);
    return [
        ...documents,
        buildTask('任务 · 等待两个子项，当前不可完成', { start: at(8, '15:00'), due: at(8, '18:00') })
            .withColorId(5).withDescription(fixtureNote)
            .withChecklist([
                { id: 'sub-1', text: '已完成：核对统一令牌', completed: true },
                { id: 'sub-2', text: '待完成：检查 Web / Desktop 界面', completed: false },
                { id: 'sub-3', text: '待完成：长中文子任务内容应允许自然换行并完整显示', completed: false },
            ]).calendar,
        buildTask('已完成 · 保持整行可读', { start: at(8, '05:00'), due: at(8, '08:00') })
            .withColorId(6).withDescription(fixtureNote).withCompleted(true).calendar,
        buildTask('逾期 · 文案确认', { start: at(7, '10:00'), due: at(7, '14:00') }).withColorId(2).calendar,
        buildTask('冲突 · 与上面并行', { start: at(8, '09:00'), due: at(8, '11:00') }).withColorId(4).calendar,
        buildTask('无时间 · 只出现在收件箱，不获得任何日期').withColorId(3).calendar,
        buildTask('重复 · 每天 09:00 起', { start: at(8, '09:00'), due: at(8, '10:00') })
            .withColorId(1).withRecurrence({ freq: 'DAILY', count: 10 }).calendar,
        buildNote(todayKey, fixtureNote).calendar,
        buildNote('2026-09-09', '## 明日计划\n\n一段中文日记，验证浮层、正文与行高。').calendar,
    ];
}

function makeEntries() {
    return makeFixtures().map((calendar, index) => ({
        uid: `fixture-${index}`, revision: index + 1, pending: index % 3 === 0, conflicted: false, calendar,
    }));
}

function ReviewApp() {
    const { t } = useTranslation();
    const [entries, setEntries] = useState(makeEntries);
    const [view, setView] = useState(query.get('view') === 'login' ? 'login' : query.get('view') === 'notes' ? 'notes' : 'date');
    const [dateMode, setDateMode] = useState('list');
    const [editor, setEditor] = useState(query.get('view') === 'add' ? { open: true, row: null, defaultDate: at(8, '13:00') } : { open: false, row: null, defaultDate: null });
    const [selectedUid, setSelectedUid] = useState(query.get('view') === 'details' ? 'fixture-9' : null);
    const [timezone, setTimezone] = useState('Asia/Shanghai');
    const [note, setNote] = useState(fixtureNote);
    const [readOnly, setReadOnly] = useState(false);
    const [highlight, setHighlight] = useState(currentDay);
    const [message, setMessage] = useState('离线内存示例 · 固定时钟 2026-09-08 10:30 +08:00');

    const options = useMemo(() => ({ timeZone: timezone }), [timezone]);
    const projection = useMemo(() => {
        const all = viewRows(entries, options);
        const tasks = all.filter(row => row.kind === 'task');
        return {
            tasks,
            notes: noteRows(entries, options),
            today: todayRows(tasks, todayKey),
            inbox: inboxRows(tasks),
            dated: dateGroups(tasks, todayKey),
        };
    }, [entries, options]);
    const scheduled = useMemo(() => projection.tasks.filter(row => row.start instanceof Date && !Number.isNaN(row.start.getTime())), [projection.tasks]);
    const clashes = useMemo(() => checkForClashes(projection.tasks), [projection.tasks]);
    const journals = useMemo(() => {
        const map = {};
        for (const [dayKey, row] of projection.notes) map[dayKey] = row.document.description ?? '';
        return map;
    }, [projection.notes]);
    const range = useMemo(() => calculateTimelineRange(scheduled, new Date(2026, 8, 7)), [scheduled]);
    const selectedRow = projection.tasks.find(row => row.uid === selectedUid) || null;

    const writeCalendar = (calendar, uid) => {
        setEntries(previous => {
            const rest = previous.filter(entry => entry.uid !== uid);
            return [...rest, { uid, revision: rest.length + 1, pending: true, conflicted: false, calendar }];
        });
        setMessage(`已在内存写入 ${uid}，刷新恢复示例。`);
    };
    const saveDocument = document => writeCalendar(document.calendar, document.uid);
    const reset = () => { setEntries(makeEntries()); setNote(fixtureNote); setMessage('已恢复离线示例。'); };

    if (view === 'login') return <>
        <LoginScreen onConnected={() => setView('date')} />
        {!clean && <button className="btn" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000 }} onClick={() => setView('date')}>返回示例</button>}
    </>;

    return <div className="app-container" style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--clr-bg)', overflow: 'hidden' }}>
        {profile === 'desktop' && <TitleBar />}
        <header className="app-header">
            <div className="app-header-left">
                {profile !== 'desktop' && <h1 className="app-header-title">{t('app.title')}</h1>}
                <button className="btn btn--ghost" id="btn-today" onClick={() => { setView('date'); setDateMode('timeline'); setHighlight(currentDay); }}>{t('nav.today')}</button>
                {[['today', t('task.today')], ['inbox', t('nav.inbox')], ['date', t('nav.dateView')]].map(([id, label]) => (
                    <button key={id} className={`btn ${view === id ? 'btn--primary' : 'btn--ghost'}`} onClick={() => setView(id)}>{label}</button>
                ))}
                {view === 'date' && <button className="btn btn--ghost" id="btn-toggle-date-mode" onClick={() => setDateMode(dateMode === 'timeline' ? 'list' : 'timeline')}>{dateMode === 'timeline' ? '列表' : '时间轴'}</button>}
            </div>
            <div className="app-header-right">
                <div className="tz-select-wrap" title={t('app.displayTimezone')}>
                    <Globe size={13} />
                    <select className="tz-select" id="tz-select" value={timezone} onChange={event => setTimezone(event.target.value)}>
                        <option value="Asia/Shanghai">北京</option><option value="Europe/London">London</option><option value="Pacific/Auckland">Auckland</option>
                    </select>
                </div>
                <button className="btn btn--ghost" id="btn-lang" onClick={() => i18n.changeLanguage(i18n.language === 'zh' ? 'en' : 'zh')} title={t('app.switchLanguage')}><Languages size={13} />{i18n.language === 'zh' ? 'EN' : '中文'}</button>
                <button className="btn btn--ghost" onClick={() => setSelectedUid('fixture-9')} title="记录详情"><Eye size={13} /><span>详情</span></button>
                <button className="btn btn--ghost" onClick={() => setView(view === 'notes' ? 'date' : 'notes')}><FileText size={13} /><span>{view === 'notes' ? '任务视图' : '便签'}</span></button>
                <button className="btn btn--ghost" onClick={() => setView('login')}><LogIn size={13} /><span>连接</span></button>
                <button className="btn btn--primary" id="btn-add-task" onClick={() => setEditor({ open: true, row: null, defaultDate: at(8, '13:00') })}><Plus size={13} />{t('actions.addTask')}</button>
            </div>
        </header>
        {view === 'notes' ? <main id="review-notes" style={{ flex: 1, minHeight: 0, padding: 'var(--tp-profile-page-padding)', overflow: 'auto' }}>
            <section className="tp-panel" style={{ maxWidth: 960, margin: '0 auto', padding: 'var(--tp-semantic-spacing-section)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
                    <h2>{t('event.note')}</h2><button className="btn" aria-pressed={readOnly} onClick={() => setReadOnly(value => !value)}>{readOnly ? '切换编辑' : '只读预览'}</button>
                </div>
                <NoteEditor value={note} onChange={setNote} onCommit={() => setMessage('便签已在内存保存。')} readOnly={readOnly} />
            </section>
        </main> : <main style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 12, minHeight: 0, gap: 8 }}>
            <div className="calendar-banners">
                <ReminderBanner events={projection.tasks} travelTimezone={timezone} onHighlight={setHighlight} />
                <OverdueBanner events={projection.tasks} travelTimezone={timezone} onHighlight={setHighlight} />
                <ClashBanner clashes={clashes} events={projection.tasks} travelTimezone={timezone} onHighlight={setHighlight} />
            </div>
            {view === 'date' && dateMode === 'timeline' ? <Timeline startDate={range.startDate} endDate={range.endDate} events={scheduled} clashes={clashes} travelTimezone={timezone}
                highlight={highlight} journals={journals} onEventClick={row => setSelectedUid(row.uid)} onAddEvent={start => setEditor({ open: true, row: null, defaultDate: start })}
                onUpdateEvent={updates => updates.forEach(update => {
                    const row = projection.tasks.find(item => item.uid === (update.uid ?? update.id));
                    if (row) saveDocument(row.document.withSchedule(update.start instanceof Date ? update.start.getTime() : update.start, update.end instanceof Date ? update.end.getTime() : update.end));
                })}
                onToggleTaskComplete={(id, completed) => {
                    const row = projection.tasks.find(item => item.uid === id);
                    if (row) saveDocument(row.document.withCompleted(completed));
                }}
                onSaveJournal={(day, text) => setMessage(`已在内存保存 ${day} 的随笔。`)}
                onContextMenu={(_, row) => setSelectedUid(row.uid)}
                selectedIds={new Set()} onSelectionChange={() => {}} />
            : <div className="task-list-scroll">
                <TaskList mode={view === 'today' ? 'today' : view === 'inbox' ? 'inbox' : 'date'} todayRows={projection.today} inboxRows={projection.inbox}
                    dateGroups={projection.dated.groups} noteByDay={projection.notes} timeZone={timezone}
                    onOpen={row => setSelectedUid(row.uid)}
                    onToggleComplete={(row, completed) => saveDocument(row.document.withCompleted(completed))}
                    onToggleChecklist={(row, itemId, completed) => saveDocument(row.document.withChecklist(row.checklist.map(item => item.id === itemId ? { ...item, completed } : item)))}
                    onSaveNote={(day, text) => setMessage(`已在内存保存 ${day} 的随笔。`)} />
            </div>}
        </main>}
        {!clean && <footer style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '4px 12px', borderTop: '1px solid var(--clr-border)', background: 'var(--clr-surface)', fontSize: 'var(--tp-profile-meta-font-size)', color: 'var(--clr-text-dim)' }}>
            <span role="status" style={{ flex: 1 }}>{message}</span><span>{profile} · 8 分类 · jCal 夹具</span>
            <button className="btn btn--ghost" onClick={reset}><RefreshCw size={13} />恢复示例</button>
        </footer>}
        <AddEventModal isOpen={editor.open} onClose={() => setEditor({ open: false, row: null, defaultDate: null })} onSave={saveDocument}
            defaultDate={editor.defaultDate} initialEvent={editor.row} events={projection.tasks} />
        <EventDetailsModal event={selectedRow} travelTimezone={timezone} onClose={() => setSelectedUid(null)}
            onDelete={row => { setEntries(previous => previous.filter(entry => entry.uid !== row.uid)); setSelectedUid(null); }}
            onEdit={row => setEditor({ open: true, row, defaultDate: null })}
            onSave={(draft, meta) => {
                const row = meta?.original ?? projection.tasks.find(item => item.uid === draft.uid);
                if (row) saveDocument(row.document.withChecklist(draft.checklist ?? row.checklist).withCompleted(Boolean(draft.completed)));
            }} />
    </div>;
}

// Vite may re-evaluate this entry after a theme/CSS dependency changes.
// Reuse the existing React root across module replacements.
const reactRoot = import.meta.hot?.data.reactRoot ?? createRoot(document.getElementById('root'));
if (import.meta.hot) {
    import.meta.hot.dispose(data => { data.reactRoot = reactRoot; });
}

reactRoot.render(
    <I18nextProvider i18n={i18n}><ThemeProvider theme={theme}><LocalizationProvider dateAdapter={AdapterDateFns}>
        <ReviewApp />
    </LocalizationProvider></ThemeProvider></I18nextProvider>,
);
