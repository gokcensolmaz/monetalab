/**
 * Business clock (D-033). Subscription periods, renewal/expiry checks, the rewarded-ad UTC day and analytics
 * `occurred_at` all use this clock, never the client's device time. Audit timestamps (`created_at`) and session
 * expiry keep using the database clock.
 *
 * Tests control time WITHOUT any HTTP endpoint:
 * - in-process tests pass a fixed/mutable clock to buildApp();
 * - the API test harness may start a separate server with MONETALAB_TEST_CLOCK_FILE=<path>, a file holding one ISO
 *   timestamp that the test process rewrites. This is refused when NODE_ENV=production (like the mock providers).
 */
import { readFileSync } from 'node:fs';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock reading an ISO-8601 timestamp from a file on every call. Fails closed if the file is unreadable. */
export function fileClock(path: string): Clock {
  return {
    now() {
      const text = readFileSync(path, 'utf8').trim();
      const date = new Date(text);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(date.getTime())) {
        throw new Error('test clock file does not contain an ISO-8601 timestamp');
      }
      return date;
    },
  };
}

export function clockFromEnv(env: NodeJS.ProcessEnv = process.env): Clock {
  const path = env.MONETALAB_TEST_CLOCK_FILE;
  if (path === undefined || path === '') return systemClock;
  if (env.NODE_ENV === 'production') throw new Error('MONETALAB_TEST_CLOCK_FILE must not be used with NODE_ENV=production');
  const clock = fileClock(path);
  clock.now(); // validate at startup
  return clock;
}

/** UTC calendar day (YYYY-MM-DD) of an instant: the rewarded-ad quota boundary (PRD §3.2). */
export function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** The next UTC midnight after an instant: when a new daily ad quota starts. */
export function nextUtcMidnight(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() + 1));
}
