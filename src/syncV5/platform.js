/**
 * Desktop platform boundary (Electron).
 *
 * The renderer owns the canonical V5 store. The main process is not allowed to keep a
 * second task model, so this module pushes a read-only projection for the Tray/widget
 * windows and receives their interactions back as intents. Widget callbacks carry real
 * milliseconds and plain checklist rows, never a private wire format.
 *
 * On the web there is no shell, and these calls are no-ops.
 */

export const ELECTRON_TASK_INTENT = 'widget:taskIntent';

export function isDesktop() {
    return typeof window !== 'undefined' && Boolean(window.electronAPI);
}

/** Pushes the current canonical projection to the Electron shell (widget + tray today list). */
export function exportElectronProjection(rows) {
    if (!isDesktop() || typeof window.electronAPI?.syncTaskProjection !== 'function') return false;
    window.electronAPI.syncTaskProjection(rows);
    return true;
}

/** Opens the today widget, when the shell provides one. */
export function showTodayWidget() {
    if (!isDesktop()) return false;
    window.electronAPI.showWidget?.();
    return true;
}
