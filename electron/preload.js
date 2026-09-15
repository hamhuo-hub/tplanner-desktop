const { contextBridge, ipcRenderer } = require('electron');

/**
 * Electron Preload — Secure contextBridge.
 * Exposes only whitelisted APIs to the renderer.
 */
contextBridge.exposeInMainWorld('electronAPI', {
    // ── Platform ─────────────────────────────────────────────────────────
    platform:   process.platform,
    isElectron: true,

    // ── Window Controls ───────────────────────────────────────────────────
    minimize:    () => ipcRenderer.send('window:minimize'),
    maximize:    () => ipcRenderer.send('window:maximize'),
    close:       () => ipcRenderer.send('window:close'),
    quit:        () => ipcRenderer.send('window:quit'),
    isMaximized: () => ipcRenderer.invoke('app:isMaximized'),

    onMaximizeChange: (callback) => {
        const handler = (_e, v) => callback(v);
        ipcRenderer.on('window:maximized', handler);
        return () => ipcRenderer.removeListener('window:maximized', handler);
    },

    // ── App Info ──────────────────────────────────────────────────────────
    getVersion: () => ipcRenderer.invoke('app:version'),

    // ── Theme API ─────────────────────────────────────────────────────────

    /**
     * Listen for theme installation events pushed from main process.
     * Triggered when the user double-clicks a .tptheme file.
     * @param {(jsonString: string) => void} callback
     */
    onThemeInstall: (callback) => {
        const handler = (_e, jsonString) => callback(jsonString);
        ipcRenderer.on('theme:install', handler);
        return () => ipcRenderer.removeListener('theme:install', handler);
    },

    /**
     * Open a native file picker to select a .tptheme file.
     * Returns the raw JSON string of the selected file, or null if cancelled.
     * @returns {Promise<string|null>}
     */
    openThemePicker: () => ipcRenderer.invoke('theme:openFilePicker'),

    // ── Zoom / GUI Scale ──────────────────────────────────────────────────────

    /**
     * Set the renderer zoom factor (0.5 – 2.0).
     * Delegates to webContents.setZoomFactor on the main process.
     */
    setZoom: (factor) => ipcRenderer.invoke('app:setZoom', factor),

    /**
     * Get the current renderer zoom factor.
     * @returns {Promise<number>}
     */
    getZoom: () => ipcRenderer.invoke('app:getZoom'),

    // ── Today-Widget / Shell projection ───────────────────────────────────
    /**
     * Push a read-only projection of the canonical V5 store to the shell. Main keeps no
     * task model of its own; `start`/`due` are epoch milliseconds (null when absent).
     */
    syncTaskProjection: (rows) => ipcRenderer.send('tasks:projection', rows),

    /** Widget interactions arrive as intents; the renderer persists them through the store. */
    onTaskIntent: (callback) => {
        const handler = (_e, payload) => callback(payload);
        ipcRenderer.on('tasks:intent', handler);
        return () => ipcRenderer.removeListener('tasks:intent', handler);
    },

    /** Show / hide the today widget on demand. */
    showWidget: () => ipcRenderer.send('widget:show'),
    hideWidget: () => ipcRenderer.send('widget:hide'),

    // ── Auto Launch ────────────────────────────────────────────────────────
    getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
    setAutoLaunch: (enable) => ipcRenderer.send('app:setAutoLaunch', enable),
    onAutoLaunchChanged: (cb) => {
        const h = (_e, v) => cb(v);
        ipcRenderer.on('autoLaunch:changed', h);
        return () => ipcRenderer.removeListener('autoLaunch:changed', h);
    },

    // ── DevTools / Debug ──────────────────────────────────────────────────
    toggleDevTools: () => ipcRenderer.send('devtools:toggle'),
    getPerfInfo:    () => ipcRenderer.invoke('devtools:getPerfInfo'),

    // ── LAN Sync ───────────────────────────────────────────────────────────
    getLanConfig:  () => ipcRenderer.invoke('lan:getConfig'),
    saveLanConfig: (cfg) => ipcRenderer.send('lan:saveConfig', cfg),

    // ── Daily note (canonical VJOURNAL, persisted by the renderer) ─────────
    getCurrentNote: () => ipcRenderer.invoke('note:getCurrent'),
    publishNote: (payload) => ipcRenderer.send('note:projection', payload),
    onNoteIntent: (callback) => {
        const handler = (_e, payload) => callback(payload);
        ipcRenderer.on('note:intent', handler);
        return () => ipcRenderer.removeListener('note:intent', handler);
    },
    saveNote: (payload) => ipcRenderer.send('note:save', payload),
    onNoteUpdated: (callback) => {
        const handler = (_e, payload) => callback(payload);
        ipcRenderer.on('note:updated', handler);
        return () => ipcRenderer.removeListener('note:updated', handler);
    },
});
