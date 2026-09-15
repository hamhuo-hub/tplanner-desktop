/**
 * V5 export helpers.
 *
 * The rendering itself lives in `sync-v5/ics.mjs` (the frozen contract module). This file
 * only adds the browser/Electron side effect: producing a Blob and a download. There is no
 * second exporter and no second calendar model — documents go in, an .ics string comes out.
 *
 * Honest platform capability: browser JavaScript cannot write a system calendar, so this is
 * an explicit user-triggered export (docs/sync-v5.md "Watch and platform adapters").
 */
import { icsFilename, toIcs } from '../../sync-v5/ics.mjs';

export { icsFilename, toIcs };

/**
 * Renders one canonical document or a list of them.
 * @param {import('../../sync-v5/jcal.mjs').JcalDocument|Array} documents
 * @returns {string} RFC 5545 text payload
 */
export function exportToIcs(documents) {
    if (!documents) return '';
    const list = Array.isArray(documents) ? documents : [documents];
    if (list.length === 0) return '';
    return toIcs(list);
}

/** Triggers a browser download of the given .ics payload. */
export function downloadIcs(icsText, filename = icsFilename('tplanner')) {
    if (!icsText) return;
    const blob = new Blob([icsText], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
