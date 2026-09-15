import { lightTokens } from '../design-assets/tokens/generated/tplanner-light.mjs';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, screen } = require('electron');
const path  = require('path');
const fs    = require('fs');

// ── Constants ──────────────────────────────────────────────────────────────
const IS_DEV = process.env.NODE_ENV === 'development' || !app.isPackaged;
// vite-plugin-electron injects the actual dev server URL (with dynamic port) via env var
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'] || 'http://localhost:5173';
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_STATE = { width: 1280, height: 800, x: undefined, y: undefined, maximized: false };

// Widget state lives in its own file so changes don't churn STATE_FILE.
const WIDGET_STATE_FILE  = path.join(app.getPath('userData'), 'widget-state.json');
const APP_USER_MODEL_ID = 'com.tplanner.app';

// ── Linux autostart helpers ────────────────────────────────────────────────
// app.setLoginItemSettings is unreliable on Linux (especially AppImage).
// We manage the XDG autostart desktop file directly instead.
const LINUX_AUTOSTART_DIR  = path.join(app.getPath('home'), '.config', 'autostart');
const LINUX_AUTOSTART_FILE = path.join(LINUX_AUTOSTART_DIR, 'tplanner.desktop');

function getLinuxExecPath() {
    // APPIMAGE env var is set by the AppImage runtime; fall back to execPath for deb/other
    return process.env.APPIMAGE || process.execPath;
}

function getLinuxAutostart() {
    try { return fs.existsSync(LINUX_AUTOSTART_FILE); } catch { return false; }
}

function setLinuxAutostart(enable) {
    try {
        if (enable) {
            fs.mkdirSync(LINUX_AUTOSTART_DIR, { recursive: true });
            const execPath = getLinuxExecPath();
            const desktop = [
                '[Desktop Entry]',
                'Type=Application',
                'Name=tPlanner',
                `Exec=${execPath} --hidden`,
                'Hidden=false',
                'NoDisplay=false',
                'X-GNOME-Autostart-enabled=true',
            ].join('\n') + '\n';
            fs.writeFileSync(LINUX_AUTOSTART_FILE, desktop, 'utf8');
        } else {
            if (fs.existsSync(LINUX_AUTOSTART_FILE)) fs.unlinkSync(LINUX_AUTOSTART_FILE);
        }
    } catch (e) {
        console.error('[autostart] failed:', e);
    }
}

// Persistent app identity so Windows toast notifications group / persist.
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

// ── Pending theme install (from double-click before window is ready) ───────
let pendingThemeFile = null;

// ── Widget / events cache state ────────────────────────────────────────────
let widgetWindow = null;
let widgetVisibleByUser = null; // null = unset → respect saved preference
let notesWindow = null;

const NOTES_STATE_FILE = path.join(app.getPath('userData'), 'notes-state.json');
function loadNotesState() {
    try {
        if (fs.existsSync(NOTES_STATE_FILE))
            return { width: 300, height: 400, alwaysOnTop: true, visible: false, ...JSON.parse(fs.readFileSync(NOTES_STATE_FILE, 'utf8')) };
    } catch (e) { /* ignore */ }
    return { width: 300, height: 400, alwaysOnTop: true, visible: false };
}
function saveNotesState(patch) {
    const current = loadNotesState();
    writeAsync(NOTES_STATE_FILE, JSON.stringify({ ...current, ...patch }));
}
/**
 * Read-only projection of the renderer's canonical V5 store.
 *
 * Main is a shell: it renders the widget window and the tray, and forwards widget
 * interactions back to the renderer as intents. It deliberately owns NO task model, no
 * event cache and no notification scheduler — the client's single source of truth is the
 * jCal document in the renderer's IndexedDB store.
 */
let taskProjection = [];
let noteProjection = { dayKey: null, text: '' };

// ── Window State ───────────────────────────────────────────────────────────
function loadWindowState() {
    try {
        if (fs.existsSync(STATE_FILE))
            return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    } catch (e) { /* ignore */ }
    return { ...DEFAULT_STATE };
}

// ── 异步写工具（所有持久化都走这里，绝不阻塞主进程） ─────────────────────────
function writeAsync(filePath, data) {
    fs.writeFile(filePath, data, (err) => {
        if (err) console.error('[IO]', filePath, err.message);
    });
}

function saveWindowState(win) {
    try {
        const isMax  = win.isMaximized();
        const bounds = isMax ? {} : win.getBounds();
        writeAsync(STATE_FILE, JSON.stringify({ ...bounds, maximized: isMax }));
    } catch (e) { /* ignore */ }
}

// ── Main Window ────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;

function createWindow() {
    const state = loadWindowState();

    mainWindow = new BrowserWindow({
        width: state.width,
        height: state.height,
        x: state.x,
        y: state.y,
        minWidth: 900,
        minHeight: 600,
        frame: false,
        transparent: false,
        backgroundColor: lightTokens.semantic.color.canvas,
        titleBarStyle: 'hidden',
        icon: getIconPath(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
        show: false,
    });

    if (state.maximized) mainWindow.maximize();

    if (IS_DEV) {
        mainWindow.loadURL(VITE_DEV_SERVER_URL);
        // mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();

        // Restore saved zoom factor (stored by renderer in localStorage,
        // but we apply it here via webContents for immediate effect)
        try {
            const zoomFile = path.join(app.getPath('userData'), 'zoom.json');
            if (fs.existsSync(zoomFile)) {
                const { factor } = JSON.parse(fs.readFileSync(zoomFile, 'utf8'));
                if (factor && typeof factor === 'number') {
                    mainWindow.webContents.setZoomFactor(Math.max(0.5, Math.min(2.0, factor)));
                }
            }
        } catch (e) { /* ignore */ }

        // If a .tptheme file was double-clicked before the window was ready,
        // send it now that the renderer is up.
        if (pendingThemeFile) {
            sendThemeToRenderer(pendingThemeFile);
            pendingThemeFile = null;
        }
    });

    mainWindow.on('close', () => saveWindowState(mainWindow));

    // Minimize to tray instead of closing (like WeChat)
    mainWindow.on('close', (e) => {
        if (tray) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
    setupMaximizeListeners();
}

// ── Widget Window (Microsoft-Sticky-Notes-style today reminder) ────────────
function loadWidgetState() {
    const def = { x: undefined, y: undefined, width: 280, height: 420, alwaysOnTop: true, visible: true };
    try {
        if (fs.existsSync(WIDGET_STATE_FILE))
            return { ...def, ...JSON.parse(fs.readFileSync(WIDGET_STATE_FILE, 'utf8')) };
    } catch (e) { /* ignore */ }
    return def;
}

function saveWidgetState(partial) {
    try {
        const current = loadWidgetState();
        writeAsync(WIDGET_STATE_FILE, JSON.stringify({ ...current, ...partial }));
    } catch (e) { /* ignore */ }
}

function ensureOnScreen(bounds) {
    // Snap the window back into a visible display if the user unplugged the
    // monitor it was on. Otherwise BrowserWindow opens off-screen.
    if (bounds.x == null || bounds.y == null) return bounds;
    const target = { x: bounds.x, y: bounds.y, width: bounds.width || 280, height: bounds.height || 420 };
    const displays = screen.getAllDisplays();
    for (const d of displays) {
        const wa = d.workArea;
        if (target.x >= wa.x && target.y >= wa.y &&
            target.x + target.width  <= wa.x + wa.width &&
            target.y + target.height <= wa.y + wa.height) return target;
    }
    // Fallback: top-right of primary display
    const primary = screen.getPrimaryDisplay().workArea;
    return {
        x: primary.x + primary.width  - target.width  - 24,
        y: primary.y + 24,
        width:  target.width,
        height: target.height,
    };
}

function createWidgetWindow() {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.show();
        widgetWindow.focus();
        return;
    }

    const state = loadWidgetState();
    const bounds = ensureOnScreen({ x: state.x, y: state.y, width: state.width, height: state.height });

    widgetWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: 240,
        minHeight: 280,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: state.alwaysOnTop,
        skipTaskbar: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: true,
        icon: getIconPath(),
        webPreferences: {
            preload: path.join(__dirname, 'widget-preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
        show: false,
    });

    widgetWindow.loadFile(path.join(__dirname, 'widget.html'));

    widgetWindow.once('ready-to-show', () => {
        widgetWindow.show();
        // Kick off initial render with the latest projection the renderer pushed.
        widgetWindow.webContents.send('widget:events', taskProjection);
    });

    const persistBounds = () => {
        if (!widgetWindow || widgetWindow.isDestroyed()) return;
        const b = widgetWindow.getBounds();
        saveWidgetState({ x: b.x, y: b.y, width: b.width, height: b.height });
    };
    widgetWindow.on('moved', persistBounds);
    widgetWindow.on('resized', persistBounds);

    widgetWindow.on('close', (e) => {
        // Hide instead of destroy so the user can re-open from the tray
        // without losing state. Real teardown happens when the app quits.
        if (!app.isQuitting) {
            e.preventDefault();
            widgetWindow.hide();
            widgetVisibleByUser = false;
            saveWidgetState({ visible: false });
        }
    });

    widgetWindow.on('closed', () => { widgetWindow = null; });

    rebuildTrayMenu();
}

// ── Notes Widget Window ────────────────────────────────────────────────────
function createNotesWindow() {
    if (notesWindow && !notesWindow.isDestroyed()) {
        notesWindow.show();
        notesWindow.focus();
        return;
    }

    const state = loadNotesState();
    const bounds = ensureOnScreen({ x: state.x, y: state.y, width: state.width, height: state.height });

    notesWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: 200,
        minHeight: 200,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: state.alwaysOnTop !== false,
        skipTaskbar: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: true,
        icon: getIconPath(),
        webPreferences: {
            preload: path.join(__dirname, 'notes-widget-preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
        show: false,
    });

    notesWindow.loadFile(path.join(__dirname, 'notes-widget.html'));

    notesWindow.once('ready-to-show', () => {
        notesWindow.show();
        notesWindow.webContents.send('note:updated', noteProjection);
    });

    const persistBounds = () => {
        if (!notesWindow || notesWindow.isDestroyed()) return;
        const b = notesWindow.getBounds();
        saveNotesState({ x: b.x, y: b.y, width: b.width, height: b.height });
    };
    notesWindow.on('moved',   persistBounds);
    notesWindow.on('resized', persistBounds);

    notesWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            notesWindow.hide();
            saveNotesState({ visible: false });
        }
    });
    notesWindow.on('closed', () => { notesWindow = null; });

    rebuildTrayMenu();
}

// ── Icon ───────────────────────────────────────────────────────────────────
function getIconPath() {
    // On Linux nativeImage can't reliably decode .ico — prefer .png
    const isPng = process.platform === 'linux';
    const candidates = isPng
        ? [
            path.join(__dirname, '../icon.png'),
            path.join(__dirname, '../public/icon.png'),
            path.join(app.getAppPath(), 'icon.png'),
            // fallback to ico if no png found
            path.join(__dirname, '../icon.ico'),
            path.join(__dirname, '../public/icon.ico'),
          ]
        : [
            path.join(__dirname, '../icon.ico'),
            path.join(__dirname, '../public/icon.ico'),
            path.join(app.getAppPath(), 'icon.ico'),
          ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

// ── System Tray ────────────────────────────────────────────────────────────
function rebuildTrayMenu() {
    if (!tray) return;
    const widgetOpen  = widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible();
    const autoLaunch = process.platform === 'linux'
        ? getLinuxAutostart()
        : app.getLoginItemSettings().openAtLogin;
    const notesOpen = notesWindow && !notesWindow.isDestroyed() && notesWindow.isVisible();
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开 tPlanner', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        {
            label: widgetOpen ? '隐藏任务便签' : '显示任务便签',
            click: () => {
                if (widgetOpen) {
                    widgetWindow.hide();
                    widgetVisibleByUser = false;
                    saveWidgetState({ visible: false });
                } else {
                    createWidgetWindow();
                    widgetVisibleByUser = true;
                    saveWidgetState({ visible: true });
                }
                rebuildTrayMenu();
            },
        },
        {
            label: '今日随笔',
            click: () => {
                if (mainWindow) {
                    if (mainWindow.isMinimized()) mainWindow.restore();
                    mainWindow.show();
                    mainWindow.focus();
                }
            },
        },
        {
            label: notesOpen ? '隐藏随笔便签' : '显示随笔便签',
            click: () => {
                if (notesOpen) {
                    notesWindow.hide();
                    saveNotesState({ visible: false });
                } else {
                    createNotesWindow();
                    saveNotesState({ visible: true });
                }
                rebuildTrayMenu();
            },
        },
        { type: 'separator' },
        {
            label: '开机自动启动',
            type: 'checkbox',
            checked: autoLaunch,
            click: () => {
                const next = !autoLaunch;
                if (process.platform === 'linux') {
                    setLinuxAutostart(next);
                } else {
                    app.setLoginItemSettings({ openAtLogin: next, openAsHidden: true });
                }
                rebuildTrayMenu();
                mainWindow?.webContents.send('autoLaunch:changed', next);
            },
        },
        { type: 'separator' },
        { label: '退出', click: () => { app.isQuitting = true; tray.destroy(); tray = null; app.quit(); } },
    ]));
}

function createTray() {
    const iconPath = getIconPath();
    if (!iconPath) {
        console.warn('[tray] No icon found — skipping tray');
        return;
    }
    if (IS_DEV) console.log('[tray] icon path:', iconPath);

    let trayIcon;
    if (process.platform === 'linux') {
        // On Linux, pass the path directly so libappindicator handles sizing.
        // Passing a nativeImage that has been resized can produce an empty image
        // on some GTK/AppIndicator stacks, which results in the placeholder "!" icon.
        trayIcon = iconPath;
    } else {
        trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('tPlanner');
    rebuildTrayMenu();
    tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ── .tptheme File Association ──────────────────────────────────────────────

/**
 * Read a .tptheme file and push it to the renderer via IPC.
 * Called both on macOS 'open-file' and from process.argv parsing on Windows.
 */
function handleThemeFile(filePath) {
    if (!filePath || !filePath.endsWith('.tptheme')) return;
    if (!fs.existsSync(filePath)) return;

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        // Validate JSON
        JSON.parse(content);

        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            sendThemeToRenderer(filePath);
        } else {
            // Queue it — will be sent after window is ready
            pendingThemeFile = filePath;
            if (mainWindow) mainWindow.show();
        }
    } catch (e) {
        dialog.showErrorBox('主题安装失败', `文件无效或损坏：\n${e.message}`);
    }
}

function sendThemeToRenderer(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        mainWindow?.webContents.send('theme:install', content);
    } catch (e) {
        console.error('[tptheme] Failed to read file:', e);
    }
}

// macOS: file opened while app is running
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    handleThemeFile(filePath);
});

// Windows: second instance with file argument
// (first instance is already running — receive argv from second)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, argv) => {
        // Bring window to front
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
        // Find .tptheme in argv
        const themeArg = argv.find(a => a.endsWith('.tptheme'));
        if (themeArg) handleThemeFile(themeArg);
    });
}

// ── IPC Handlers — Window Controls ────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close',  () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('window:quit',   () => { tray?.destroy(); tray = null; app.quit(); });

// ── Auto Launch ───────────────────────────────────────────────────────────
ipcMain.handle('app:getAutoLaunch', () => {
    if (process.platform === 'linux') return getLinuxAutostart();
    return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('app:setAutoLaunch', (_e, enable) => {
    if (process.platform === 'linux') {
        if (app.isPackaged) setLinuxAutostart(enable);
        return;
    }
    app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: true });
});

// ── DevTools / Debug ──────────────────────────────────────────────────────
ipcMain.on('devtools:toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
    } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
});
ipcMain.handle('devtools:getMemory', () => process.memoryUsage());
ipcMain.handle('devtools:getPerfInfo', () => ({
    processMemory: process.memoryUsage(),
    uptime: process.uptime(),
    platform: process.platform,
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
    cpuUsage: process.cpuUsage(),
}));

ipcMain.handle('app:version',     () => app.getVersion());
ipcMain.handle('app:isMaximized', () => mainWindow?.isMaximized() ?? false);

// ── IPC Handlers — Theme ───────────────────────────────────────────────────
/**
 * Renderer can ask main to open a file-picker for .tptheme files.
 * This is for users who prefer the menu over drag-and-drop.
 */
ipcMain.handle('theme:openFilePicker', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: '安装 tPlanner 主题',
        filters: [{ name: 'tPlanner Theme', extensions: ['tptheme'] }],
        properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return null;
    }
});

// ── IPC Handlers — Zoom / GUI Scale ───────────────────────────────────────
ipcMain.handle('app:setZoom', (_, factor) => {
    const clamped = Math.max(0.5, Math.min(2.0, Number(factor) || 1));
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.setZoomFactor(clamped);
    }
    // Persist for next startup
    try {
        const zoomFile = path.join(app.getPath('userData'), 'zoom.json');
        writeAsync(zoomFile, JSON.stringify({ factor: clamped }));
    } catch (e) { /* ignore */ }
    return clamped;
});

ipcMain.handle('app:getZoom', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        return mainWindow.webContents.getZoomFactor();
    }
    return 1.0;
});

function setupMaximizeListeners() {
    mainWindow?.on('maximize',   () => mainWindow?.webContents.send('window:maximized', true));
    mainWindow?.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false));
}

// ── IPC Handlers — Widget / Task projection ───────────────────────────────
/**
 * The renderer owns the canonical store and pushes its projection here. Main keeps it in
 * memory only to serve the widget window; nothing is persisted or re-modelled.
 */
ipcMain.on('tasks:projection', (_e, rows) => {
    if (!Array.isArray(rows)) return;
    taskProjection = rows;
    if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.webContents.send('widget:events', taskProjection);
    }
});

/** Widget renderer pulls the projection on init or by user request. */
ipcMain.handle('widget:getEvents', () => taskProjection);

ipcMain.on('widget:show', () => { createWidgetWindow(); rebuildTrayMenu(); });
ipcMain.on('widget:hide', () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
    saveWidgetState({ visible: false });
    rebuildTrayMenu();
});
ipcMain.on('widget:close', () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
    saveWidgetState({ visible: false });
    rebuildTrayMenu();
});
ipcMain.on('widget:openMain', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});
ipcMain.handle('widget:toggleAlwaysOnTop', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return false;
    const next = !widgetWindow.isAlwaysOnTop();
    widgetWindow.setAlwaysOnTop(next);
    saveWidgetState({ alwaysOnTop: next });
    return next;
});
ipcMain.handle('widget:isAlwaysOnTop', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return true;
    return widgetWindow.isAlwaysOnTop();
});

// ── Notes Widget IPC ──────────────────────────────────────────────────────
ipcMain.on('notes:close', () => {
    if (notesWindow && !notesWindow.isDestroyed()) notesWindow.hide();
    saveNotesState({ visible: false });
    rebuildTrayMenu();
});
ipcMain.on('notes:openMain', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});
ipcMain.handle('notes:toggleAlwaysOnTop', () => {
    if (!notesWindow || notesWindow.isDestroyed()) return true;
    const next = !notesWindow.isAlwaysOnTop();
    notesWindow.setAlwaysOnTop(next);
    saveNotesState({ alwaysOnTop: next });
    return next;
});
ipcMain.handle('notes:isAlwaysOnTop', () => {
    if (!notesWindow || notesWindow.isDestroyed()) return true;
    return notesWindow.isAlwaysOnTop();
});

/**
 * Widget interactions are INTENTS. Main never mutates a task: it forwards the request to
 * the renderer, which writes the canonical jCal document through the V5 store and pushes
 * an updated projection back.
 */
function sendTaskIntent(payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks:intent', payload);
    }
}

ipcMain.on('widget:toggleTask', (_e, uid) => {
    const row = taskProjection.find(item => item.uid === uid);
    if (!row) return;
    sendTaskIntent({ uid, completed: !row.completed });
});

ipcMain.on('widget:toggleSubtask', (_e, uid, subtaskId) => {
    const row = taskProjection.find(item => item.uid === uid);
    if (!row || !Array.isArray(row.checklist)) return;
    const checklist = row.checklist.map(item => (item.id === subtaskId ? { ...item, completed: !item.completed } : item));
    const allDone = checklist.length > 0 && checklist.every(item => item.completed);
    const anyUndone = checklist.some(item => !item.completed);
    sendTaskIntent({
        uid,
        checklist,
        completed: allDone ? true : anyUndone ? false : row.completed,
    });
});

// ── Daily note (canonical VJOURNAL, owned by the renderer) ────────────────
// Main holds only the text the renderer last pushed, so the notes widget can render it.
// Saving routes back to the renderer, which writes the canonical document.
ipcMain.handle('note:getCurrent', () => noteProjection);

ipcMain.on('note:projection', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return;
    noteProjection = { dayKey: payload.dayKey ?? null, text: payload.text ?? '' };
    const senderId = _e.sender.id;
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed() && win.webContents.id !== senderId) {
            win.webContents.send('note:updated', noteProjection);
        }
    });
});

ipcMain.on('note:save', (_e, payload) => {
    if (!payload || typeof payload.text !== 'string') return;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('note:intent', { dayKey: payload.dayKey ?? null, text: payload.text });
    }
});

// ── Sync (client-side config only; sync target is the fixed Cloudflare Tunnel URL) ──
const LAN_CONFIG_FILE = path.join(app.getPath('userData'), 'lan-sync.json');
const DEFAULT_LAN_CONFIG = { serverUrl: 'https://sync.hamhuo.top' };

function loadLanConfig() {
    try {
        if (fs.existsSync(LAN_CONFIG_FILE)) {
            const cfg = { ...DEFAULT_LAN_CONFIG, ...JSON.parse(fs.readFileSync(LAN_CONFIG_FILE, 'utf8')) };
            // 老版本只保存过 peerIp/port（IPv6 直连时代，地址已失效），统一迁移到固定服务器地址
            if (!cfg.serverUrl) cfg.serverUrl = DEFAULT_LAN_CONFIG.serverUrl;
            delete cfg.peerIp;
            delete cfg.port;
            return cfg;
        }
    } catch (e) { /* ignore */ }
    return { ...DEFAULT_LAN_CONFIG };
}

function saveLanConfig(cfg) {
    writeAsync(LAN_CONFIG_FILE, JSON.stringify(cfg));
}

ipcMain.handle('lan:getConfig', () => loadLanConfig());
ipcMain.on('lan:saveConfig', (_e, cfg) => saveLanConfig(cfg));

// ── App Lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
    // Check argv for .tptheme on first launch (Windows double-click)
    const themeArg = process.argv.find(a => a.endsWith('.tptheme'));
    if (themeArg) pendingThemeFile = themeArg;

    createWindow();
    createTray();

    // Restore widgets that were open last session.
    const widgetState = loadWidgetState();
    if (widgetState.visible) createWidgetWindow();
    const notesState = loadNotesState();
    if (notesState.visible) createNotesWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('before-quit', () => { app.isQuitting = true; });

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit();
});
