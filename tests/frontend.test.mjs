import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dailyActivity,
  dateKey,
  DEFAULT_SCHEDULE,
  hasSucceededOnDate,
  nextSchedule,
  runState,
  safeURL,
  statusCopy,
  validateSnapshot,
} from '../assets/status.js';

const now = new Date('2026-10-20T07:00:00Z');
const schedule = DEFAULT_SCHEDULE;
const makeRun = (overrides = {}) => ({
  id: 20,
  number: 20,
  status: 'completed',
  conclusion: 'success',
  startedAt: '2026-10-20T00:00:00Z',
  completedAt: '2026-10-20T00:00:25Z',
  durationSeconds: 25,
  ...overrides,
});
const makeSnapshot = (overrides = {}) => ({
  schemaVersion: 1,
  runs: [],
  latestRun: null,
  lastSuccess: null,
  schedule,
  ...overrides,
});

test('date keys change at WIB midnight and reject invalid timestamps', () => {
  assert.equal(dateKey('2026-10-20T16:59:59.999Z'), '2026-10-20');
  assert.equal(dateKey('2026-10-20T17:00:00.000Z'), '2026-10-21');
  assert.equal(dateKey('2026-12-31T17:00:00.000Z'), '2027-01-01');
  assert.equal(dateKey('2026-10-21T00:00:00+07:00'), '2026-10-21');
  assert.equal(dateKey('invalid timestamp'), null);
  assert.equal(dateKey(null), null);
});

test('next schedule advances every 3 hours at 07.07, 10.07, 13.07, 16.07, and 19.07 WIB boundaries', () => {
  const cases = [
    ['2026-10-19T23:59:59.999Z', '2026-10-20T00:07:00.000Z', 'Hari ini, 07.07'],
    ['2026-10-20T00:06:59.999Z', '2026-10-20T00:07:00.000Z', 'Hari ini, 07.07'],
    ['2026-10-20T00:07:00.000Z', '2026-10-20T03:07:00.000Z', 'Hari ini, 10.07'],
    ['2026-10-20T03:06:59.999Z', '2026-10-20T03:07:00.000Z', 'Hari ini, 10.07'],
    ['2026-10-20T03:07:00.000Z', '2026-10-20T06:07:00.000Z', 'Hari ini, 13.07'],
    ['2026-10-20T06:07:00.000Z', '2026-10-20T09:07:00.000Z', 'Hari ini, 16.07'],
    ['2026-10-20T09:07:00.000Z', '2026-10-20T12:07:00.000Z', 'Hari ini, 19.07'],
    ['2026-10-20T12:06:59.999Z', '2026-10-20T12:07:00.000Z', 'Hari ini, 19.07'],
    ['2026-10-20T12:07:00.000Z', '2026-10-21T00:07:00.000Z', 'Besok, 07.07'],
  ];
  for (const [timestamp, expectedDate, expectedLabel] of cases) {
    const next = nextSchedule(new Date(timestamp), schedule);
    assert.equal(next.date.toISOString(), expectedDate, timestamp);
    assert.equal(next.label, expectedLabel, timestamp);
  }
});

test('next schedule jumps to tomorrow 07.07 once today has already succeeded', () => {
  const afterMorningSuccess = nextSchedule(new Date('2026-10-20T00:05:00.000Z'), schedule, { succeededToday: true });
  assert.equal(afterMorningSuccess.date.toISOString(), '2026-10-21T00:07:00.000Z');
  assert.equal(afterMorningSuccess.label, 'Besok, 07.07');

  const todaySuccessRun = makeRun({ startedAt: '2026-10-20T03:00:00Z', completedAt: '2026-10-20T03:00:20Z' });
  assert.equal(hasSucceededOnDate([todaySuccessRun], todaySuccessRun, '2026-10-20'), true);
  assert.equal(hasSucceededOnDate([], null, '2026-10-20'), false);
});

test('next schedule uses the Jakarta calendar across midnight and year rollover', () => {
  const atMidnight = nextSchedule(new Date('2026-10-19T17:00:00Z'), schedule);
  assert.equal(atMidnight.date.toISOString(), '2026-10-20T00:07:00.000Z');
  assert.equal(atMidnight.label, 'Hari ini, 07.07');

  const nextYear = nextSchedule(new Date('2026-12-31T12:07:00Z'), schedule);
  assert.equal(nextYear.date.toISOString(), '2027-01-01T00:07:00.000Z');
  assert.equal(nextYear.label, 'Besok, 07.07');
});

test('a failed latest run preserves the actual previous success time', () => {
  const lastSuccess = makeRun();
  const failed = makeRun({
    id: 21,
    conclusion: 'failure',
    startedAt: '2026-10-20T03:00:00Z',
    completedAt: '2026-10-20T03:00:30Z',
  });
  const snapshot = makeSnapshot({ latestRun: failed, lastSuccess, runs: [failed, lastSuccess] });
  const copy = statusCopy(snapshot, now);
  assert.equal(copy.state, 'failure');
  assert.equal(copy.title, 'Ada yang perlu diperiksa.');
  assert.equal(copy.caption, 'Terakhir berhasil 6 jam yang lalu');
  assert.equal(snapshot.lastSuccess, lastSuccess);
});

test('pending and initial snapshots never claim that a commit succeeded', () => {
  for (const status of ['queued', 'in_progress', 'waiting']) {
    const latestRun = makeRun({ status, conclusion: null, completedAt: null, durationSeconds: null });
    const copy = statusCopy(makeSnapshot({ latestRun, runs: [latestRun] }), now);
    assert.equal(runState(latestRun), 'running');
    assert.equal(copy.state, 'running');
    assert.equal(copy.title, 'Automasi sedang berjalan.');
    assert.equal(copy.caption, 'Menyiapkan commit pertamamu');
    assert.doesNotMatch(copy.description, /sudah tersimpan|berhasil/i);
  }
  const initial = statusCopy(makeSnapshot(), now);
  assert.equal(initial.state, 'waiting');
  assert.equal(initial.title, 'Menunggu eksekusi pertama.');
  assert.equal(initial.caption, 'Belum ada eksekusi yang tercatat');
});

test('cancelled and skipped executions retain distinct, accurate labels', () => {
  const lastSuccess = makeRun();
  const cancelled = makeRun({ conclusion: 'cancelled' });
  const cancelledCopy = statusCopy(makeSnapshot({ latestRun: cancelled, lastSuccess }), now);
  assert.equal(runState(cancelled), 'cancelled');
  assert.equal(cancelledCopy.state, 'cancelled');
  assert.equal(cancelledCopy.title, 'Eksekusi dibatalkan.');
  assert.equal(cancelledCopy.caption, 'Terakhir berhasil 6 jam yang lalu');

  for (const conclusion of ['skipped', 'neutral']) {
    const skipped = makeRun({ conclusion });
    const copy = statusCopy(makeSnapshot({ latestRun: skipped }), now);
    assert.equal(copy.state, 'waiting');
    assert.equal(copy.title, 'Eksekusi terakhir dilewati.');
    assert.equal(copy.description, 'GitHub tidak menjalankan proses commit pada eksekusi ini.');
    assert.equal(copy.caption, 'Belum ada eksekusi yang berhasil');
  }
});

test('daily activity marks day as success once a retry succeeds while preserving run history', () => {
  const failedAt7 = makeRun({ id: 19, conclusion: 'failure', startedAt: '2026-10-20T00:00:00Z' });
  const succeededAt10 = makeRun({ id: 20, conclusion: 'success', startedAt: '2026-10-20T03:00:00Z' });
  const failedYesterday = makeRun({ id: 18, conclusion: 'failure', startedAt: '2026-10-19T00:00:00Z' });
  const days = dailyActivity([failedAt7, succeededAt10, failedYesterday], now, 3);

  assert.deepEqual(days.map((day) => [day.key, day.state]), [
    ['2026-10-18', 'waiting'],
    ['2026-10-19', 'failure'],
    ['2026-10-20', 'success'],
  ]);
  assert.deepEqual(days.at(-1).runs.map((run) => run.id), [20, 19]);
});

test('daily activity groups runs at the WIB date boundary rather than the UTC date', () => {
  const previousDay = makeRun({ id: 18, startedAt: '2026-10-19T16:59:59Z' });
  const currentDay = makeRun({ id: 19, conclusion: 'failure', startedAt: '2026-10-19T17:00:00Z' });
  const days = dailyActivity([previousDay, currentDay], now, 2);
  assert.deepEqual(days.map((day) => [day.key, day.state, day.runs.map((run) => run.id)]), [
    ['2026-10-19', 'success', [18]],
    ['2026-10-20', 'failure', [19]],
  ]);
});

test('safe URL links allow HTTPS and reject executable or insecure schemes', () => {
  assert.equal(safeURL('https://github.com/owner/repo/actions/runs/123'), 'https://github.com/owner/repo/actions/runs/123');
  for (const value of [
    'javascript:alert(document.cookie)',
    'http://github.com/owner/repo',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    '//github.com/owner/repo',
    '/relative/path',
    '',
    null,
    undefined,
  ]) {
    assert.equal(safeURL(value), null, String(value));
  }
});

test('snapshot validation rejects unsupported formats and incomplete latest runs', () => {
  for (const value of [
    null,
    undefined,
    [],
    {},
    { schemaVersion: 2, runs: [] },
    { schemaVersion: '1', runs: [] },
    { schemaVersion: 1 },
    { schemaVersion: 1, runs: {} },
    makeSnapshot({ latestRun: { id: 1, status: 'completed' } }),
    makeSnapshot({ runs: [null] }),
    makeSnapshot({ runs: [makeRun({ startedAt: 'invalid' })] }),
    makeSnapshot({ latestRun: makeRun({ durationSeconds: -1 }) }),
    makeSnapshot({ lastSuccess: makeRun({ conclusion: 'failure' }) }),
  ]) {
    assert.throws(() => validateSnapshot(value), /Format data status|Data eksekusi belum lengkap/);
  }
  const empty = makeSnapshot();
  assert.equal(validateSnapshot(empty), empty);
  const populated = makeSnapshot({ latestRun: makeRun(), runs: [makeRun()] });
  assert.equal(validateSnapshot(populated), populated);
});
