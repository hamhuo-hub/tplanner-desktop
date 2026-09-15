/**
 * RFC 5545 iCalendar text export for Sync V5 documents.
 *
 * The exporter is read-only: it renders the canonical jCal array as .ics text and never
 * becomes a second data model. Timed values are emitted in UTC (Z) because Sync V5 only
 * stores UTC or TZID-qualified local values, and floating times are never produced.
 */

import { property, ruleText, instant } from './jcal.mjs';

const FOLD_OCTETS = 75;

function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 §3.1 line folding, counting octets so multi-byte text folds legally. */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= FOLD_OCTETS) return [line];
  const out = [];
  let current = '';
  let width = 0;
  for (const char of line) {
    const size = new TextEncoder().encode(char).length;
    if (width + size > FOLD_OCTETS) {
      out.push(current);
      current = ` ${char}`;
      width = 1 + size;
    } else {
      current += char;
      width += size;
    }
  }
  if (current) out.push(current);
  return out;
}

function stamp(prop) {
  const text = prop[3];
  if (text.endsWith('Z')) return text.replace(/[-:]/g, '');
  return text;
}

function dateTimeProp(prop) {
  if (!prop) return [];
  if (prop[2] === 'date') return [prop[3].replace(/-/g, '')];
  return [stamp(prop)];
}

function componentLines(component) {
  const lines = [`BEGIN:${component[0].toUpperCase()}`];
  const push = (name, value) => lines.push(`${name}:${value}`);
  const uid = property(component, 'uid');
  const dtstamp = property(component, 'dtstamp');
  const summary = property(component, 'summary');
  const description = property(component, 'description');
  const location = property(component, 'location');
  const status = property(component, 'status');
  const completed = property(component, 'completed');
  const dtstart = property(component, 'dtstart');
  const due = property(component, 'due');
  const rrule = property(component, 'rrule');
  const recurrenceId = property(component, 'recurrence-id');
  const checklist = property(component, 'x-tplanner-checklist');

  if (uid) push('UID', escapeText(uid[3]));
  if (dtstamp) push('DTSTAMP', stamp(dtstamp));
  if (recurrenceId) {
    const [value] = dateTimeProp(recurrenceId);
    push('RECURRENCE-ID', value);
  }
  if (summary) push('SUMMARY', escapeText(summary[3]));
  if (description) push('DESCRIPTION', escapeText(description[3]));
  if (checklist) {
    const rows = JSON.parse(checklist[3]);
    const text = rows.map((row) => `${row.completed ? '[x]' : '[ ]'} ${row.text}`).join('\n');
    lines.push(...fold(`X-TPLANNER-CHECKLIST:${escapeText(text)}`));
  }
  if (location) push('LOCATION', escapeText(location[3]));
  if (dtstart) {
    const [value] = dateTimeProp(dtstart);
    push(dtstart[2] === 'date' ? 'DTSTART;VALUE=DATE' : 'DTSTART', value);
  }
  if (due) {
    const [value] = dateTimeProp(due);
    push(due[2] === 'date' ? 'DUE;VALUE=DATE' : 'DUE', value);
  }
  const listId = property(component, 'x-tplanner-list-id');
  const color = property(component, 'x-tplanner-color');
  if (listId) lines.push(...fold(`X-TPLANNER-LIST-ID:${escapeText(listId[3])}`));
  if (color) push('X-TPLANNER-COLOR', String(color[3]));
  if (rrule) push('RRULE', ruleText(rrule[3]));
  if (status) push('STATUS', status[3]);
  if (completed) push('COMPLETED', stamp(completed));
  lines.push(`END:${component[0].toUpperCase()}`);
  return lines;
}

/** Renders one or more canonical documents as a single .ics payload. */
export function toIcs(documents) {
  const list = Array.isArray(documents) ? documents : [documents];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TPlanner//Sync V5//EN',
    'CALSCALE:GREGORIAN',
  ];
  for (const doc of list) {
    for (const component of doc.calendar[2]) {
      if (component[0] !== 'vtodo' && component[0] !== 'vjournal') continue;
      lines.push(...componentLines(component));
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.flatMap(fold).join('\r\n')}\r\n`;
}

/** Convenience for callers that only need a timestamp for a filename. */
export function icsFilename(prefix, now = Date.now()) {
  return `${prefix}-${new Date(now).toISOString().slice(0, 10)}.ics`;
}

export { instant };
