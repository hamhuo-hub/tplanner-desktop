const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload for the today-events sticky-note widget.
 * Exposes a minimal IPC surface used by widget.js.
 */
contextBridge.exposeInMainWorld('widgetAPI', {
    /** Pull the current task projection from main (Promise<TaskRow[]>). */
    getEvents: () => ipcRenderer.invoke('widget:getEvents'),

    /** Subscribe to projection updates pushed by main. */
    onEvents: (callback) => {
        const handler = (_e, list) => callback(list);
        ipcRenderer.on('widget:events', handler);
        return () => ipcRenderer.removeListener('widget:events', handler);
    },

    /** Bring the main tPlanner window forward. */
    openMain: () => ipcRenderer.send('widget:openMain'),

    /** Hide the widget (kept alive in tray). */
    close: () => ipcRenderer.send('widget:close'),

    /** Toggle / inspect always-on-top — Promise<boolean>. */
    toggleAlwaysOnTop: () => ipcRenderer.invoke('widget:toggleAlwaysOnTop'),
    isAlwaysOnTop:     () => ipcRenderer.invoke('widget:isAlwaysOnTop'),

    /**
     * Task interactions are INTENTS sent to the renderer, which owns the canonical store.
     * The widget never assumes the change applied until the new projection arrives.
     */
    toggleTask: (uid) => ipcRenderer.send('widget:toggleTask', uid),

    /** Toggle an individual checklist item (also an intent). */
    toggleSubtask: (uid, subtaskId) => ipcRenderer.send('widget:toggleSubtask', uid, subtaskId),
});
