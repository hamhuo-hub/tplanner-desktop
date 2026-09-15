/**
 * Read-only interpretation of the canonical jCal document for the Task UI.
 *
 * Everything here is derived from `sync-v5/jcal.mjs` and never stores a task fact of its
 * own: there is no Task/Event class, no `type` field, no mirrored columns. A view row is
 * just a projection of the jCal array with normalised Date objects and a date key so a
 * React list can render it. Editing goes through `JcalDocument.with*()` and returns a new
 * canonical document — the same object the store persists and the transport uploads.
 *
 * "An absent time stays absent": nothing in this module invents a date. Tasks without
 * DTSTART/DUE have `start === null`, `due === null` and `dateKey === null`, and only the
 * Inbox view shows them.
 */
import {
    CHECKLIST,
    COLOR,
    JcalDocument,
    LIST_ID,
    PRODID,
    isJournalDocument,
    journal,
    newUid,
    p,
    property,
    task,
} from '../../sync-v5/jcal.mjs';
import { ruleText } from '../../sync-v5/jcal.mjs';

export { PRODID, CHECKLIST, COLOR, LIST_ID, JcalDocument, isJournalDocument };
export { task as buildTask, journal as buildNote };

const CONTENT = new Set(['vtodo', 'vjournal']);

/** The master component: the standard component that is not a recurrence exception. */
export function masterComponent(document) {
    return document.calendar[2].find((component) => CONTENT.has(component[0])
        && property(component, 'recurrence-id') === null);
}

export function isTask(document) {
    return masterComponent(document)[0] === 'vtodo';
}

export function isNote(document) {
    return masterComponent(document)[0] === 'vjournal';
}

/** Recurrence exceptions of this document, as canonical components. */
export function exceptions(document) {
    return document.calendar[2].filter((component) => CONTENT.has(component[0])
        && property(component, 'recurrence-id') !== null);
}

/** Converts a canonical jCal array back into the immutable document class. */
export function toDocument(calendar) {
    return calendar instanceof JcalDocument ? calendar : new JcalDocument(calendar);
}

// ── Editing helpers: all of them return a NEW canonical document ───────────────

export function withTitle(document, value) {
    return document.withTitle(value);
}

export function withNote(document, value) {
    return document.withDescription(value);
}

export function withColor(document, value) {
    return document.withColorId(value);
}

export function withCompleted(document, value) {
    return document.withCompleted(value);
}

export function withChecklist(document, items) {
    return document.withChecklist(items);
}

/** `start`/`due` are epoch milliseconds; `start === null` clears the schedule entirely. */
export function withSchedule(document, start, due) {
    return document.withSchedule(start, due);
}

export function withRecurrence(document, rule) {
    if (rule === null || rule === undefined) return document.withoutRecurrence();
    if (!property(masterComponent(document), 'dtstart')) {
        throw new Error('重复任务需要开始时间');
    }
    return document.withRecurrence(rule);
}

/** RFC 5545-style rule summary for display; null when the record does not repeat. */
export function recurrenceText(document) {
    const rule = document.recurrence;
    return rule ? ruleText(rule) : null;
}

// ── Display projection ────────────────────────────────────────────────────────

/**
 * YYYY-MM-DD day key of an instant in the display timezone, without pulling a date
 * library into the model: Intl already knows the zone offsets.
 */
export function dayKeyOf(instantMs, timeZone) {
    if (instantMs === null || instantMs === undefined) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || undefined,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * One row per record for the Task UI.
 *
 * `document` stays attached so editors can mutate the canonical array losslessly; every
 * other field is a pure read of it. `due`/`hasDue` are the honest deadline fields; `end`
 * is the exclusive interval end used by timeline geometry and equals DTSTART when the
 * record has no DUE, so nothing invents a second time. `id` mirrors `uid` only because the
 * existing timeline components key on it.
 */
export function viewRow(entry, { timeZone } = {}) {
    const document = toDocument(entry.calendar);
    const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const note = isNote(document);
    const start = document.start;
    const due = document.due;
    const checklist = document.checklist;
    const dateKey = note
        ? (document.date ?? dayKeyOf(start, zone))
        : (dayKeyOf(due, zone) ?? dayKeyOf(start, zone));
    const uid = entry.uid ?? document.uid;
    return {
        uid,
        id: uid,
        document,
        kind: note ? 'note' : 'task',
        // Every record in the V5 store is a VTODO or a VJOURNAL. Recurrence exceptions are
        // components of the same record, so there is no second task kind to classify.
        type: note ? 'note' : 'task',
        title: document.title,
        note: document.description,
        completed: document.completed,
        checklist,
        checklistDone: checklist.filter((item) => item.completed).length,
        colorId: document.colorId,
        start,
        due,
        hasDue: due !== null,
        end: due ?? start,
        scheduled: document.scheduled,
        dateKey,
        dayKey: dateKey,
        timeZone: zone,
        repeats: document.recurrence !== null,
        recurrence: document.recurrence,
        recurrenceText: recurrenceText(document),
        exceptionCount: exceptions(document).length,
        revision: entry.revision ?? 0,
        pending: Boolean(entry.pending),
        conflicted: Boolean(entry.conflicted),
    };
}

export function viewRows(entries, options = {}) {
    return entries.map((entry) => viewRow(entry, options));
}

/** Task rows only, notes excluded — the Inbox/Today/date views work on tasks. */
export function taskRows(entries, options = {}) {
    return viewRows(entries, options).filter((row) => row.kind === 'task');
}

/**
 * Sort key for a task: DUE first (a deadline is what "today" means for a task), then
 * DTSTART, then the title. Unscheduled tasks keep the title order and stay last.
 */
export function compareRows(a, b) {
    const left = a.due ?? a.start;
    const right = b.due ?? b.start;
    if (left === null && right === null) return a.title.localeCompare(b.title);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return left - right;
    return a.title.localeCompare(b.title);
}

export function isOverdue(row, now = Date.now()) {
    if (row.kind !== 'task' || row.completed) return false;
    const deadline = row.due ?? row.start;
    return deadline !== null && deadline < now;
}

/** Unscheduled, unfinished tasks. The only place an absent time is displayed. */
export function inboxRows(rows) {
    return rows
        .filter((row) => row.kind === 'task' && !row.completed && !row.scheduled && row.due === null)
        .sort(compareRows);
}

/**
 * Today = tasks whose deadline or start falls on today, plus every earlier overdue
 * unfinished task (per docs/sync-v5.md, Today must include earlier overdue work).
 */
export function todayRows(rows, todayKey, now = Date.now()) {
    return rows
        .filter((row) => {
            if (row.kind !== 'task' || row.completed) return false;
            if (row.dateKey === null) return false;
            if (row.dateKey === todayKey) return true;
            return row.dateKey < todayKey || isOverdue(row, now);
        })
        .sort(compareRows);
}

/** Rows anchored on one day, used by the date view. */
export function rowsOnDay(rows, dayKey) {
    return rows.filter((row) => row.dateKey === dayKey).sort(compareRows);
}

/**
 * Date view: today's scheduled work, then everything later, grouped by day key.
 * Unscheduled tasks are returned separately so the view can point at the Inbox instead
 * of inventing a date for them.
 */
export function dateGroups(rows, todayKey) {
    const scheduled = rows
        .filter((row) => row.kind === 'task' && !row.completed && row.dateKey !== null && row.dateKey >= todayKey)
        .sort(compareRows);
    const groups = new Map();
    for (const row of scheduled) {
        if (!groups.has(row.dateKey)) groups.set(row.dateKey, []);
        groups.get(row.dateKey).push(row);
    }
    return {
        groups: [...groups.entries()].map(([dayKey, items]) => ({ dayKey, rows: items })),
        unscheduled: inboxRows(rows),
    };
}

/** One daily note row per day key, for the date view's note column. */
export function noteRows(entries, options = {}) {
    const notes = new Map();
    for (const entry of entries) {
        const row = viewRow(entry, options);
        if (row.kind !== 'note' || row.dateKey === null) continue;
        notes.set(row.dateKey, row);
    }
    return notes;
}

// ── Creation ──────────────────────────────────────────────────────────────────

/**
 * New unscheduled task document. `start`/`due` stay null unless the user gave a time,
 * and a `due` is only emitted when a `start` exists (jCal VTODO schedule semantics).
 */
export function createTask({ title, note = '', colorId = 0, start = null, due = null, checklist = [] }) {
    let document = task(title, { start, due, checklist });
    if (note) document = document.withDescription(note);
    if (colorId) document = document.withColorId(colorId);
    return document;
}

/**
 * Copy of one task under a NEW UID.
 *
 * The UID belongs only to the standard component, so it is rewritten there and the copy
 * carries no recurrence exceptions: a duplicated series starts as a single master record.
 * The result is validated by the JcalDocument constructor before it can be persisted.
 */
export function duplicateTask(document, title) {
    const calendar = document.withTitle(title).calendar;
    const master = calendar[2].find((component) => CONTENT.has(component[0])
        && property(component, 'recurrence-id') === null);
    master[1] = master[1].map((prop) => (prop[0] === 'uid' ? p('uid', 'text', newUid()) : prop));
    calendar[2] = calendar[2].filter((component) => !CONTENT.has(component[0])
        || property(component, 'recurrence-id') === null);
    return new JcalDocument(calendar);
}

/** New daily note (VJOURNAL with a DATE dtstart and the shared journal:YYYY-MM-DD UID). */
export function createNote(dayKey, text) {
    return journal(dayKey, text);
}

/**
 * Result of editing the daily note: either a canonical document to put, or a delete.
 * An emptied note is not a valid record to keep, so callers remove it instead of storing
 * an empty VJOURNAL that every device would have to carry.
 */
export function noteUpdate(dayKey, text, existingDocument = null) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '') {
        return existingDocument ? { operation: 'delete', uid: `journal:${dayKey}` } : null;
    }
    return { operation: 'put', document: journal(dayKey, text) };
}

/** A daily note has no "delete" flag: empty text removes the note everywhere. */
export function isEmptyNote(document) {
    return isNote(document) && (document.description ?? '').trim() === '';
}

/** True when a VJOURNAL document carries no text and should be dropped rather than uploaded. */
export function noteHasNoText(calendar) {
    const document = toDocument(calendar);
    if (!isNote(document)) return false;
    return (document.description ?? '').trim() === '';
}

export { p, property };
