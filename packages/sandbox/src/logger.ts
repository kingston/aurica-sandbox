import { formatWithOptions } from 'node:util';

import type { ConsolaInstance, ConsolaReporter, LogObject } from 'consola';
import { createConsola } from 'consola';

/** Zero-pad `value` to two digits. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Render a log's timestamp as a fixed-width `HH:MM:SS` clock. */
function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}`;
}

/**
 * Reporter that prefixes every message with a fixed 11-character `[HH:MM:SS] `
 * clock and nothing else — no level tag. Level is conveyed by the message's own
 * status emoji (the proxy block) and by stderr-vs-stdout routing.
 *
 * Unlike consola's default fancy reporter — whose timestamps alternate between
 * leading and right-aligned positions (its dedup behavior) and so don't form a
 * scannable time column — this gives one consistent column. A multi-line
 * message keeps its newlines; only the leading line carries the prefix so
 * indented bodies (e.g. the proxy reload banner, a per-request block) stay
 * aligned: their own leading whitespace must account for the 11-char prefix.
 */
const timestampReporter: ConsolaReporter = {
  log(logObj: LogObject): void {
    const time = formatTime(logObj.date);
    const args = logObj.args as unknown[];
    const text = formatWithOptions({ colors: false }, ...args);
    const prefixed = text.replace(/^/, `[${time}] `);
    const stream = logObj.level <= 1 ? process.stderr : process.stdout;
    stream.write(`${prefixed}\n`);
  },
};

/**
 * Build a consola instance whose every line carries a fixed 11-character
 * `[HH:MM:SS] ` timestamp prefix. Used by the long-running proxy process so its
 * scattered per-request lines share one scannable time column.
 */
export function createTimestampedLogger(): ConsolaInstance {
  return createConsola({ reporters: [timestampReporter] });
}

/** Shared application logger (consola defaults). */
export const logger = createConsola();
