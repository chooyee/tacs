// "Last edited 2 h ago" (D-37): <time datetime data-relative> printed in UTC by the server becomes a
// relative time in the reader's language, with the exact local time as a tooltip.
import { $$ } from './dom.js';

const UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const exact = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "2 hours ago", "yesterday", "just now". */
export function timeAgo(date) {
  const seconds = (date.getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(0, 'second');
}

/** Format every <time data-relative> below `root` (call again after re-rendering a part). */
export function formatTimes(root = document) {
  for (const el of $$('time[data-relative]', root)) {
    const date = new Date(el.getAttribute('datetime'));
    if (Number.isNaN(date.getTime())) continue;
    el.textContent = timeAgo(date);
    el.title = exact.format(date);
  }
}

formatTimes();
