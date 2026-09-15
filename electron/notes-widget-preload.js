const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notesAPI', {
    toggleAlwaysOnTop: () => ipcRenderer.invoke('notes:toggleAlwaysOnTop'),
    isAlwaysOnTop:     () => ipcRenderer.invoke('notes:isAlwaysOnTop'),
    close:             () => ipcRenderer.send('notes:close'),
    openMain:          () => ipcRenderer.send('notes:openMain'),

    /** Canonical daily note (VJOURNAL) text for one day key. */
    getCurrentNote: () => ipcRenderer.invoke('note:getCurrent'),
    /** Saving is an intent: the renderer writes the canonical document. */
    saveNote: (payload) => ipcRenderer.send('note:save', payload),
    onNoteUpdated: (callback) => {
        const handler = (_e, payload) => callback(payload);
        ipcRenderer.on('note:updated', handler);
        return () => ipcRenderer.removeListener('note:updated', handler);
    },
});
