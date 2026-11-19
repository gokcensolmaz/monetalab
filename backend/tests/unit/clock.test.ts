/** Business clock helpers (src/clock.ts): UTC day boundaries and the test-clock guard. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clockFromEnv, fileClock, nextUtcMidnight, systemClock, utcDay } from '../../src/clock.ts';

describe('UTC day (ADS-03 boundary)', () => {
  it('[BR] the day is the UTC calendar day, with an exclusive midnight boundary', () => {
    assert.equal(utcDay(new Date('2026-03-02T23:59:59.999Z')), '2026-03-02');
    assert.equal(utcDay(new Date('2026-03-03T00:00:00.000Z')), '2026-03-03');
  });
  it('[BR] an instant written with a local offset maps to its UTC day, not the local day', () => {
    // 01:30 in UTC+03:00 is still the previous UTC day; 22:30 in UTC-05:00 is already the next UTC day.
    assert.equal(utcDay(new Date('2026-03-03T01:30:00+03:00')), '2026-03-02');
    assert.equal(utcDay(new Date('2026-03-02T22:30:00-05:00')), '2026-03-03');
  });
  it('[BR] the quota resets at the next UTC midnight, across month and year ends', () => {
    assert.equal(nextUtcMidnight(new Date('2026-03-02T10:00:00Z')).toISOString(), '2026-03-03T00:00:00.000Z');
    assert.equal(nextUtcMidnight(new Date('2026-02-28T23:59:59Z')).toISOString(), '2026-03-01T00:00:00.000Z');
    assert.equal(nextUtcMidnight(new Date('2026-12-31T00:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
  });
});

describe('clock configuration', () => {
  it('[BR] without a clock file the system clock is used', () => {
    assert.equal(clockFromEnv({}), systemClock);
  });
  it('[NEG] a test clock file is refused with NODE_ENV=production', () => {
    assert.throws(() => clockFromEnv({ MONETALAB_TEST_CLOCK_FILE: '/nonexistent', NODE_ENV: 'production' }), /must not be used with NODE_ENV=production/);
  });
  it('[INT] a file clock follows the file and fails closed on bad content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monetalab-clock-'));
    try {
      const file = join(dir, 'now');
      writeFileSync(file, '2026-03-02T23:59:59.000Z\n');
      const clock = fileClock(file);
      assert.equal(clock.now().toISOString(), '2026-03-02T23:59:59.000Z');
      writeFileSync(file, '2026-03-03T00:00:00.000Z');
      assert.equal(clock.now().toISOString(), '2026-03-03T00:00:00.000Z');
      writeFileSync(file, 'tomorrow');
      assert.throws(() => clock.now(), /ISO-8601/);
      assert.throws(() => clockFromEnv({ MONETALAB_TEST_CLOCK_FILE: join(dir, 'missing') }), /ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
