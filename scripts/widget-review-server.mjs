/** Offline review of the actual packaged widget renderers, with memory-only data. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const assetRoot = fileURLToPath(new URL('../dist-electron/', import.meta.url));
const host = '127.0.0.1';
const port = 4175;
// Today is a built React page now: its bundles are hashed and live under assets/. The notes
// widget is still copied verbatim out of electron/.
const assets = new Set([
  'widget.html', 'notes-widget.html', 'notes-widget.js',
  'notes-widget.css', 'shared-widget.css', 'widget-shared.mjs', 'marked.umd.js',
  'tplanner-light.css', 'tplanner-light.mjs', 'recurringTaskSelection.mjs',
]);
// One flat directory, one flat filename: encoded separators and traversal never reach fs.
const hashedAsset = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const fixture = String.raw`(() => {
  // Fix the clock to 14:00 on today's date so every state remains reviewable.
  const NativeDate = Date;
  const today = new NativeDate();
  today.setHours(14, 0, 0, 0);
  const fixedNow = today.getTime();
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  const memoryStorage = new Map([['widget_completed_collapsed', 'false']]);
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: key => memoryStorage.has(String(key)) ? memoryStorage.get(String(key)) : null,
    setItem: (key, value) => memoryStorage.set(String(key), String(value)),
    removeItem: key => memoryStorage.delete(String(key)),
    clear: () => memoryStorage.clear(),
    key: index => [...memoryStorage.keys()][index] ?? null,
    get length() { return memoryStorage.size; },
  } });
  // Today's dateKey, derived from the fixed clock so the widget and the fixture agree.
  const dayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  // The real projection carries epoch milliseconds and null for an absent time. ISO strings
  // here would make rowsForToday() drop every row and review an empty widget.
  const at = minutes => fixedNow + minutes * 60000;
  let pinned = true;
  const chrome = {
    isAlwaysOnTop: async () => pinned,
    toggleAlwaysOnTop: async () => (pinned = !pinned),
    openMain: () => {},
    close: () => {},
  };
  let events = [
    { uid: 'now', title: '进行中：准备今天的项目评审与跨端协作说明', colorId: 0, start: at(-20), due: at(3), note: '先完成子任务，再勾选整个任务', pending: false, repeats: null, dateKey: dayKey, checklist: [
      { id: 'sub-a', text: '检查统一令牌与中文长标题展示', completed: true },
      { id: 'sub-b', text: '复核键盘焦点、禁用边界和小窗缩放', completed: false },
    ] },
    { uid: 'later', title: '稍后：整理本周的评审结论', colorId: 1, start: at(60), due: at(90), pending: false, repeats: null, dateKey: dayKey },
    { uid: 'checklist-clear', title: '子任务全部完成，父任务可以勾选', colorId: 6, start: at(30), due: at(45), pending: false, repeats: null, dateKey: dayKey, checklist: [
      { id: 'sub-all-a', text: '两项都已完成', completed: true },
      { id: 'sub-all-b', text: '进度徽标应显示完成态', completed: true },
    ] },
    { uid: 'past', title: '已过：上午的文档整理，仍可标记完成', colorId: 2, start: at(-120), due: at(-90), pending: false, repeats: null, dateKey: dayKey },
    { uid: 'overdue-earlier-day', title: '昨日逾期且仍未完成，今日继续提醒', colorId: 3, start: null, due: at(-1400), pending: false, repeats: null, dateKey: '2000-01-01' },
    { uid: 'due-only', title: '只有截止时间，没有开始时间', colorId: 4, start: null, due: at(240), pending: false, repeats: null, dateKey: dayKey },
    { uid: 'unscheduled', title: '无时间：今天想做但没有具体时间', colorId: 5, start: null, due: null, pending: false, repeats: null, dateKey: dayKey },
    { uid: 'pending', title: '待上传：本地已改，等待同步确认', colorId: 7, start: at(120), due: at(150), pending: true, repeats: 'FREQ=DAILY', dateKey: dayKey },
    { uid: 'completed', title: '完成：已确认的浅色方案', colorId: 3, start: at(-10), due: at(10), completed: true, pending: false, repeats: null, dateKey: dayKey, checklist: [
      { id: 'sub-done', text: '完成条目与子项仍应清晰可读', completed: true },
    ] },
    // Completed on another day: rowsForToday() must keep it out, which is why it is here.
    { uid: 'completed-earlier-day', title: '昨天完成的任务不应出现在今日', colorId: 1, start: null, due: at(-1500), completed: true, pending: false, repeats: null, dateKey: '2000-01-01' },
    ...Array.from({ length: 8 }, (_, id) => ({
      uid: 'category-' + id, colorId: id,
      title: '分类 ' + id + ' · ' + ['蓝', '金', '玫瑰', '绿', '紫', '陶橙', '青', '灰'][id] + ' · 稳定的分类与浅色配对',
      start: at(300 + id * 20), due: at(315 + id * 20),
      note: id === 4 ? '长中文备注用于检查窄窗口换行，保留完整信息。' : '',
      pending: false, repeats: null, dateKey: dayKey,
    })),
  ];
  const eventListeners = new Set();
  const emitEvents = () => eventListeners.forEach(listener => listener(structuredClone(events)));
  window.widgetAPI = {
    ...chrome,
    getEvents: async () => structuredClone(events),
    onEvents: callback => { eventListeners.add(callback); return () => eventListeners.delete(callback); },
    toggleTask: uid => {
      events = events.map(event => event.uid === uid && (event.completed || !event.checklist?.some(sub => !sub.completed)) ? { ...event, completed: !event.completed } : event);
      emitEvents();
    },
    toggleSubtask: (uid, subId) => {
      events = events.map(event => event.uid === uid ? { ...event, checklist: event.checklist.map(sub => sub.id === subId ? { ...sub, completed: !sub.completed } : sub) } : event);
      emitEvents();
    },
  };
  // TODO(notes): this half still targets the pre-V5 notes surface — getJournals /
  // onJournalUpdated / saveJournal. electron/notes-widget-preload.js exposes
  // getCurrentNote / onNoteUpdated / saveNote, so the notes review page mounts with a dead
  // bridge. Fix it together with the notes widget migration.
  let note = '# 今日随手记\n\n把零散的灵感整理成清晰的下一步。点击这里可以编辑 Markdown，离开编辑区会保存到本页面的内存。\n\n## 评审关注点\n\n- [x] 正文使用系统字体\n- [ ] 长中文、窄窗口、焦点与滚动内容\n\n**重要想法**：任务状态与用户选择的分类颜色各自表达不同的信息。*这段文字用于检查斜体和辅助文字。*\n\n> 在小窗中也能读清楚，放大后允许自然换行，不截断重要内容。\n\n### 本地代码示例\n\n行内代码 ' + String.fromCharCode(96) + 'colorId' + String.fromCharCode(96) + ' 保持稳定。\n\n' + String.fromCharCode(96).repeat(3) + 'js\nconst categoryId = 4;\nconsole.log("今日灵感");\n' + String.fromCharCode(96).repeat(3) + '\n\n[查看文内链接](#notes-editor)\n\n---\n\n更多中文内容用于验证长文滚动和底部保存提示，继续输入不会修改真实日记。';
  const journalListeners = new Set();
  window.notesAPI = {
    ...chrome,
    getJournals: async () => ({ [dayKey]: { text: note, updatedAt: fixedNow } }),
    onJournalUpdated: callback => { journalListeners.add(callback); return () => journalListeners.delete(callback); },
    saveJournal: (_date, value) => { note = value; },
  };
})();`;

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = new URL(request.url, 'http://' + host + ':' + port).pathname;
    if (pathname === '/review-fixture.js') {
      response.writeHead(200, { 'Content-Type': mime['.js'], 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : fixture);
      return;
    }
    const name = pathname === '/' ? 'widget.html' : pathname.slice(1);
    // Explicit filename allowlist: encoded paths, separators and traversal never reach fs.
    if (!assets.has(name) && !hashedAsset.test(name)) { response.writeHead(404).end('Not found'); return; }
    let content = await readFile(resolve(assetRoot, name), 'utf8');
    if (name.endsWith('.html')) content = content.replace('</head>', '<script src="/review-fixture.js"></script>\n</head>');
    const extension = name.slice(name.lastIndexOf('.'));
    response.writeHead(200, { 'Content-Type': mime[extension], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Packaged widget assets unavailable. Build the project first.');
    console.error(error.message);
  }
}).listen(port, host, () => {
  console.log('Offline Today: http://' + host + ':' + port + '/widget.html');
  console.log('Offline Notes: http://' + host + ':' + port + '/notes-widget.html');
  console.log('Synthetic clock 14:00 today; memory-only events/notes; no IPC, network sync or real window actions.');
});
