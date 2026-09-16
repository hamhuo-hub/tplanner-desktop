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
    utc,
} from '../../sync-v5/jcal.mjs';
import { ruleText } from '../../sync-v5/jcal.mjs';

export { PRODID, CHECKLIST, COLOR, LIST_ID, JcalDocument, isJournalDocument };
export { task as buildTask, journal as buildNote };

const CONTENT = new Set(['vtodo', 'vjournal']);

/**
 * The master component inside a specific calendar array.
 *
 * Always resolve the master from the array you are about to mutate: `document.calendar`
 * returns a fresh copy on every read, so a component obtained from the document is NOT the
 * same object as one obtained from a local `calendar` variable.
 */
function masterOf(calendar) {
    return calendar[2].find((component) => CONTENT.has(component[0])
        && property(component, 'recurrence-id') === null);
}

/** The master component: the standard component that is not a recurrence exception. */
export function masterComponent(document) {
    return masterOf(document.calendar);
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

// ── Recurrence expansion (read-only) ─────────────────────────────────────────
//
// A repeating task is ONE canonical document, and docs/sync-v5.md requires readers to expand
// its occurrences locally instead of synchronising generated records. Per-instance state rides
// on the standard components RFC 5545 defines for exactly this: a RECURRENCE-ID exception
// carries "this occurrence is done", and EXDATE cancels one occurrence. Nothing here is ever
// written back as a stored fact.

export const MAX_TASK_RECURRENCE_COUNT = 50;

/** Occurrences are projected inside a window around now; the record itself stays unbounded. */
const OCCURRENCE_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/** Occurrence-scoped row id, mirroring the Android client's `uid@epochSecond` form. */
export function occurrenceKey(uid, instantMs) {
    return `${uid}@${Math.floor(instantMs / 1000)}`;
}

/** Zone offset of `utcMs` in `zone`, in milliseconds. */
function zoneOffsetMs(zone, utcMs) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day,
        +parts.hour, +parts.minute, +parts.second) - utcMs;
}

function localParts(zone, ms) {
    const shifted = new Date(ms + zoneOffsetMs(zone, ms));
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        second: shifted.getUTCSeconds(),
    };
}

function fromLocalParts(zone, parts) {
    const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const first = guess - zoneOffsetMs(zone, guess);
    return guess - zoneOffsetMs(zone, first);
}

/**
 * Advances the wall clock by `steps` periods. Recurrence is a calendar concept, so it moves in
 * local time: a daily 20:00 task stays at 20:00 across a DST change instead of drifting an hour.
 * Monthly steps clamp to the last valid day, so 31 Jan plus one month is 28/29 Feb.
 */
function stepLocal(anchorMs, frequency, steps, zone) {
    const parts = localParts(zone, anchorMs);
    if (steps === 0) return anchorMs;
    if (frequency === 'DAILY' || frequency === 'WEEKLY') {
        const days = frequency === 'DAILY' ? steps : steps * 7;
        const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
        return fromLocalParts(zone, {
            ...parts,
            year: shifted.getUTCFullYear(),
            month: shifted.getUTCMonth() + 1,
            day: shifted.getUTCDate(),
        });
    }
    const total = parts.year * 12 + (parts.month - 1) + steps;
    const year = Math.floor(total / 12);
    const month = (total % 12 + 12) % 12 + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return fromLocalParts(zone, { ...parts, year, month, day: Math.min(parts.day, lastDay) });
}

/** Instants cancelled with EXDATE on the master component. */
export function excludedInstants(document) {
    const result = new Set();
    for (const prop of masterComponent(document)[1]) {
        if (prop[0] !== 'exdate') continue;
        for (let slot = 3; slot < prop.length; slot += 1) {
            const ms = Date.parse(String(prop[slot]));
            if (Number.isFinite(ms)) result.add(ms);
        }
    }
    return result;
}

/** Per-occurrence completion carried by RECURRENCE-ID exception components. */
export function exceptionState(document) {
    const result = new Map();
    for (const component of exceptions(document)) {
        const at = Date.parse(String(property(component, 'recurrence-id')[3]));
        if (!Number.isFinite(at)) continue;
        result.set(at, property(component, 'status')?.[3] === 'COMPLETED');
    }
    return result;
}

/**
 * Occurrence instants of one document inside a window, inclusive of both ends.
 *
 * A rule this build cannot expand yields only DTSTART, so a rule written by another client is
 * still visible rather than silently disappearing.
 */
export function occurrenceInstants(document, { timeZone, windowStart, windowEnd } = {}) {
    const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const anchor = document.start;
    if (anchor === null) return [];
    const rule = document.recurrence;
    if (rule === null) return [anchor];
    const frequency = String(rule.freq ?? '').toUpperCase();
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) return [anchor];

    const interval = Number.isInteger(rule.interval) && rule.interval > 0 ? rule.interval : 1;
    const limit = Number.isInteger(rule.count) && rule.count > 0
        ? Math.min(rule.count, MAX_TASK_RECURRENCE_COUNT)
        : MAX_TASK_RECURRENCE_COUNT;
    const untilText = typeof rule.until === 'string' ? rule.until : null;
    const until = untilText === null ? null : Date.parse(untilText.endsWith('Z') ? untilText : `${untilText}Z`);
    const excluded = excludedInstants(document);
    const from = Number.isFinite(windowStart) ? windowStart : Date.now() - OCCURRENCE_WINDOW_MS;
    const to = Number.isFinite(windowEnd) ? windowEnd : Date.now() + OCCURRENCE_WINDOW_MS;

    const instants = [];
    for (let index = 0; index < limit; index += 1) {
        const at = stepLocal(anchor, frequency, index * interval, zone);
        if (until !== null && Number.isFinite(until) && at > until) break;
        if (at > to) break;
        if (at >= from && !excluded.has(at)) instants.push(at);
    }
    return instants;
}

/**
 * One row per occurrence for repeating tasks, one row per record for everything else.
 *
 * A record whose occurrences all fall outside the window keeps its master row: a projection
 * must never hide a record that exists.
 */
export function expandRows(rows, options = {}) {
    const expanded = [];
    for (const row of rows) {
        if (row.kind !== 'task' || !row.repeats || row.start === null) {
            expanded.push(row);
            continue;
        }
        const instants = occurrenceInstants(row.document, options);
        if (instants.length === 0) {
            expanded.push(row);
            continue;
        }
        const state = exceptionState(row.document);
        const duration = row.due === null ? 0 : row.due - row.start;
        for (const at of instants) {
            const due = row.due === null ? null : at + duration;
            const dayKey = dayKeyOf(due ?? at, row.timeZone);
            expanded.push({
                ...row,
                id: occurrenceKey(row.uid, at),
                occurrence: at,
                start: at,
                due,
                hasDue: due !== null,
                end: due ?? at,
                // An explicit exception wins; otherwise the record's own state applies.
                completed: state.has(at) ? state.get(at) : row.completed,
                dateKey: dayKey,
                dayKey,
            });
        }
    }
    return expanded;
}

/**
 * Marks one occurrence done (or not) with a RECURRENCE-ID exception of the same UID and kind.
 * Any previous exception for that instant is replaced, so toggling is idempotent.
 */
export function withOccurrenceCompleted(document, occurrenceMs, completed) {
    const calendar = document.calendar;
    const master = masterComponent(document);
    const components = calendar[2].filter((component) => {
        if (!CONTENT.has(component[0])) return true;
        const recurrenceId = property(component, 'recurrence-id');
        if (recurrenceId === null) return true;
        return Date.parse(String(recurrenceId[3])) !== occurrenceMs;
    });
    components.push([master[0], [
        p('uid', 'text', property(master, 'uid')[3]),
        p('dtstamp', 'date-time', property(master, 'dtstamp')[3]),
        p('recurrence-id', 'date-time', utc(occurrenceMs)),
        p('status', 'text', completed ? 'COMPLETED' : 'NEEDS-ACTION'),
        p('completed', 'date-time', utc(Date.now())),
    ], []]);
    const next = calendar.slice();
    next[2] = components;
    return new JcalDocument(next);
}

/** Cancels exactly one occurrence with EXDATE, leaving the rule and the rest intact. */
export function withOccurrenceExcluded(document, occurrenceMs) {
    const calendar = document.calendar;
    if (!excludedInstants(document).has(occurrenceMs)) {
        // Mutate the master of THIS array, never one from a second `document.calendar` read.
        masterOf(calendar)[1].push(p('exdate', 'date-time', utc(occurrenceMs)));
    }
    return new JcalDocument(calendar);
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
        /** Set by `expandRows` on a generated occurrence row; null on the record's own row. */
        occurrence: null,
        revision: entry.revision ?? 0,
        pending: Boolean(entry.pending),
        conflicted: Boolean(entry.conflicted),
    };
}

export function viewRows(entries, options = {}) {
    return entries.map((entry) => viewRow(entry, options));
}

/**
 * Task rows for the Inbox/Today/date/timeline views, with repeating tasks expanded into one
 * row per occurrence (see `expandRows`). Notes are excluded.
 */
export function taskRows(entries, options = {}) {
    return expandRows(viewRows(entries, options).filter((row) => row.kind === 'task'), options);
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
