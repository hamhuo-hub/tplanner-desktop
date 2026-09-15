/**
 * Sync V5 canonical document core: RFC 7265 jCal with RFC 5545 semantics.
 *
 * This module is the language-neutral contract. It is byte-compatible in behaviour with
 * the Kotlin implementation at shared/src/main/kotlin/com/hamhuo/tplanner/syncv5/JcalDocument.kt.
 * A document is immutable: every editor returns a new JcalDocument and never mutates the input.
 *
 * Shape:   ["vcalendar", [properties], [components]]
 * Property: [lowercaseName, parameters, lowercaseValueType, value]
 *
 * There is exactly one master vtodo/vjournal per document (plus optional recurrence
 * exceptions of the same kind/UID and any vtimezone components). Task facts live here and
 * nowhere else: transport metadata, SQL columns and adapters must not duplicate them.
 */

export const PRODID = '-//TPlanner//Sync V5//EN';
export const CHECKLIST = 'x-tplanner-checklist';
export const LIST_ID = 'x-tplanner-list-id';
export const COLOR = 'x-tplanner-color';

const NAME = /^[a-z0-9-]+$/;
const CONTENT = new Set(['vtodo', 'vjournal']);
const SINGLE = ['uid', 'dtstamp', 'summary', 'description', 'dtstart', 'due', 'status',
  'completed', 'rrule', CHECKLIST, LIST_ID, COLOR];

/** Property constructor. Parameters default to none; names are lowercase, values keep their case. */
export function p(name, type, value, parameters = {}) {
  return [name, parameters, type, value];
}

/** First property called `name` on a component, or null. */
export function property(component, name) {
  return component[1].find((prop) => prop[0] === name) ?? null;
}

/** Every property called `name` on a component. */
export function properties(component, name) {
  return component[1].filter((prop) => prop[0] === name);
}

export function utc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function offsetMs(tzid, utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    +parts.hour, +parts.minute, +parts.second) - utcMs;
}

function zonedToMs(text, tzid) {
  const [date, time] = text.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - offsetMs(tzid, guess);
  return guess - offsetMs(tzid, first);
}

/** Millisecond epoch of a date/date-time property. Date-only values are UTC midnight. */
export function instant(prop, tzid = null) {
  if (prop[2] === 'date') return Date.parse(`${prop[3]}T00:00:00Z`);
  if (prop[2] !== 'date-time') throw new Error(`Unsupported calendar time type: ${prop[2]}`);
  if (prop[3].endsWith('Z')) return Date.parse(prop[3]);
  const zone = tzid ?? prop[1].tzid;
  if (!zone) throw new Error('Timed value without TZID');
  return zonedToMs(prop[3], zone);
}

/** RFC 5545 RRULE text for a jCal recur object; used by the ICS exporter. */
export function ruleText(rule) {
  return Object.keys(rule).map((key) => {
    const raw = Array.isArray(rule[key]) ? rule[key].join(',') : String(rule[key]);
    const text = key === 'until' ? raw.replace(/-/g, '').replace(/:/g, '') : raw;
    return `${key.toUpperCase()}=${text}`;
  }).join(';');
}

function setProperty(component, name, type, value) {
  removeProperty(component, name);
  component[1].push(p(name, type, value));
}

function removeProperty(component, name) {
  component[1] = component[1].filter((prop) => prop[0] !== name);
}

/**
 * Structural + semantic validation. Throws on anything this build cannot represent.
 * Unknown standard and extension properties are preserved, never rejected.
 */
export function validate(root) {
  const walk = (component, depth) => {
    if (!Array.isArray(component) || component.length !== 3 || !NAME.test(component[0])) {
      throw new Error('Invalid jCal component');
    }
    if (depth > 8) throw new Error('Invalid jCal nesting');
    for (const prop of component[1]) {
      if (!Array.isArray(prop) || prop.length < 4 || !NAME.test(prop[0])) throw new Error('Invalid jCal property');
      if (typeof prop[1] !== 'object' || prop[1] === null || Array.isArray(prop[1])) throw new Error('Invalid jCal parameters');
      for (const key of Object.keys(prop[1])) {
        if (!NAME.test(key) || key === 'value') throw new Error('Invalid jCal parameter');
      }
      if (!NAME.test(prop[2])) throw new Error('Invalid jCal value type');
    }
    for (const child of component[2]) walk(child, depth + 1);
  };
  walk(root, 0);

  if (root[0] !== 'vcalendar') throw new Error('Document must be a VCALENDAR');
  if (property(root, 'version')?.[3] !== '2.0') throw new Error('VCALENDAR requires VERSION 2.0');
  if (!property(root, 'prodid')) throw new Error('VCALENDAR requires PRODID');

  const content = root[2].filter((component) => CONTENT.has(component[0]));
  if (content.length === 0) throw new Error('Missing task or note');
  const masters = content.filter((component) => property(component, 'recurrence-id') === null);
  if (masters.length !== 1) throw new Error('Exactly one master component is required');
  const master = masters[0];
  const uid = property(master, 'uid')?.[3] ?? '';
  if (!uid || uid.length > 1024) throw new Error('Invalid UID');

  for (const part of content) {
    if (property(part, 'uid')?.[3] !== uid) throw new Error('Component UID mismatch');
    if (part[0] !== master[0]) throw new Error('Mixed component kinds in one record');
    const stamp = property(part, 'dtstamp');
    if (!stamp || stamp[2] !== 'date-time' || !stamp[3].endsWith('Z')) throw new Error('Missing DTSTAMP');
    if (Number.isNaN(Date.parse(stamp[3]))) throw new Error('Invalid DTSTAMP');
    if (property(part, 'dtend')) throw new Error('VTODO uses DUE, not DTEND');
    for (const name of SINGLE) {
      if (properties(part, name).length > 1) throw new Error(`Duplicate property: ${name}`);
    }
    const start = property(part, 'dtstart');
    const due = property(part, 'due');
    for (const prop of [start, due]) if (prop) instant(prop);
    if (start && due) {
      if (start[2] !== due[2]) throw new Error('Mixed schedule value types');
      if (!(instant(due) > instant(start))) throw new Error('Invalid schedule');
    }
    const checklist = property(part, CHECKLIST);
    if (checklist) {
      if (checklist[2] !== 'text') throw new Error('Checklist must be TEXT');
      const rows = JSON.parse(checklist[3]);
      if (!Array.isArray(rows)) throw new Error('Invalid checklist');
      const ids = new Set();
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Invalid checklist id');
        ids.add(row.id);
        if (typeof row.text !== 'string') throw new Error('Invalid checklist text');
        if (typeof row.completed !== 'boolean') throw new Error('Invalid checklist state');
      }
    }
  }
}

export class JcalDocument {
  #encoded;

  constructor(calendar) {
    validate(calendar);
    this.#encoded = JSON.stringify(calendar);
  }

  /** A private copy of the canonical array; callers cannot mutate the document through it. */
  get calendar() {
    return JSON.parse(this.#encoded);
  }

  get #master() {
    return this.calendar[2].find((component) => CONTENT.has(component[0])
      && property(component, 'recurrence-id') === null);
  }

  #property(name) {
    return property(this.#master, name);
  }

  get uid() { return this.#property('uid')[3]; }
  get kind() { return this.#master[0]; }
  get title() { return this.#property('summary')?.[3] ?? ''; }
  get description() { return this.#property('description')?.[3] ?? ''; }
  get completed() { return this.#property('status')?.[3] === 'COMPLETED'; }
  get recurrenceId() { return null; }
  get start() { const prop = this.#property('dtstart'); return prop ? instant(prop) : null; }
  get due() { const prop = this.#property('due'); return prop ? instant(prop) : null; }
  /** Date-only day key (YYYY-MM-DD), only when DTSTART is a DATE value. */
  get date() { const prop = this.#property('dtstart'); return prop?.[2] === 'date' ? prop[3] : null; }
  get scheduled() { return this.#property('dtstart') !== null; }
  get colorId() { return Math.min(7, Math.max(0, Number(this.#property(COLOR)?.[3] ?? 0))); }
  get listId() { return this.#property(LIST_ID)?.[3] ?? ''; }
  get recurrence() { return this.#property('rrule')?.[3] ?? null; }
  get checklist() {
    const value = this.#property(CHECKLIST)?.[3];
    return value ? JSON.parse(value) : [];
  }

  #edit(change) {
    const next = this.calendar;
    const component = next[2].find((part) => CONTENT.has(part[0]) && property(part, 'recurrence-id') === null);
    change(component);
    setProperty(component, 'dtstamp', 'date-time', utc(Date.now()));
    return new JcalDocument(next);
  }

  withTitle(value) { return this.#edit((component) => setProperty(component, 'summary', 'text', String(value).trim())); }
  withDescription(value) { return this.#edit((component) => setProperty(component, 'description', 'text', String(value))); }
  withColorId(value) {
    const id = Math.min(7, Math.max(0, Math.trunc(value)));
    return this.#edit((component) => setProperty(component, COLOR, 'integer', id));
  }
  withCompleted(value) {
    return this.#edit((component) => {
      setProperty(component, 'status', 'text', value ? 'COMPLETED' : 'NEEDS-ACTION');
      if (value) setProperty(component, 'completed', 'date-time', utc(Date.now()));
      else removeProperty(component, 'completed');
    });
  }
  /** Array order is display order; there is no separate ordering field. */
  withChecklist(items) {
    const rows = items.map((row) => ({ id: row.id, text: row.text, completed: Boolean(row.completed) }));
    return this.#edit((component) => setProperty(component, CHECKLIST, 'text', JSON.stringify(rows)));
  }
  withSchedule(start, due) {
    return this.#edit((component) => {
      if (start === null || start === undefined) {
        removeProperty(component, 'dtstart');
        removeProperty(component, 'due');
        removeProperty(component, 'duration');
        return;
      }
      if (!(due > start)) throw new Error('结束时间必须晚于开始时间');
      setProperty(component, 'dtstart', 'date-time', utc(start));
      setProperty(component, 'due', 'date-time', utc(due));
      removeProperty(component, 'duration');
    });
  }
  /** Replaces only DTSTART and leaves the schedule untouched; DATE values stay date-only. */
  withDate(day) {
    return this.#edit((component) => setProperty(component, 'dtstart', 'date', day));
  }
  withRecurrence(rule) {
    return this.#edit((component) => {
      if (rule === null || rule === undefined) removeProperty(component, 'rrule');
      else {
        if (!property(component, 'dtstart')) throw new Error('重复任务需要开始时间');
        setProperty(component, 'rrule', 'recur', rule);
      }
    });
  }
  /** Drops RRULE and any exception components, keeping this master only. */
  withoutRecurrence() {
    const next = this.calendar;
    const kept = next[2].filter((component) => !CONTENT.has(component[0])
      || property(component, 'recurrence-id') === null);
    for (const component of kept) if (CONTENT.has(component[0])) removeProperty(component, 'rrule');
    next[2] = kept;
    const component = next[2].find((part) => CONTENT.has(part[0]));
    setProperty(component, 'dtstamp', 'date-time', utc(Date.now()));
    return new JcalDocument(next);
  }

  toString() { return this.#encoded; }
  toJSON() { return this.calendar; }
}

/** Parses a JSON-encoded VCALENDAR. */
export function parse(text) {
  return new JcalDocument(JSON.parse(text));
}

function create(kind, uid, props) {
  props.push(p('uid', 'text', uid));
  props.push(p('dtstamp', 'date-time', utc(Date.now())));
  return new JcalDocument(['vcalendar',
    [p('version', 'text', '2.0'), p('prodid', 'text', PRODID)],
    [[kind, props, []]]]);
}

/** RFC 4122 v4 identifier; cryptography is not required, only uniqueness. */
export function newUid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** New unscheduled VTODO. An absent time stays absent; nothing is invented. */
export function task(title, { start = null, due = null, checklist = [], uid = newUid() } = {}) {
  if (!String(title).trim()) throw new Error('任务标题不能为空');
  const doc = create('vtodo', uid, [p('summary', 'text', String(title).trim()), p('status', 'text', 'NEEDS-ACTION')]);
  const scheduled = start === null ? doc : doc.withSchedule(start, due);
  const items = checklist.map((text, index) => ({ id: `${uid}:${index}`, text, completed: false }));
  return items.length ? scheduled.withChecklist(items) : scheduled;
}

/** New VJOURNAL note. The daily note UID is journal:YYYY-MM-DD. */
export function journal(day, text) {
  return create('vjournal', `journal:${day}`, [p('dtstart', 'date', day), p('description', 'text', text)]);
}

export function isJournalDocument(doc) {
  return doc.kind === 'vjournal';
}

/** Shared UID rule so all clients and the server agree on record identity. */
export function documentUid(calendar) {
  return new JcalDocument(calendar).uid;
}
