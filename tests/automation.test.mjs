import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectStatus, createGitHubClient, DEFAULT_SCHEDULE, normalizeRun, sanitizeMessage } from '../scripts/build-status.mjs';
import { jakartaDate, jakartaHour, runDailyCommit } from '../scripts/daily-commit.mjs';

const repository = { owner: { login: 'fadhil' }, name: 'automit', private: false,
  default_branch: 'main', html_url: 'https://github.com/fadhil/automit' };
const run = (id, conclusion = 'success', overrides = {}) => ({
  id, run_number: id, status: 'completed', conclusion,
  run_started_at: `2026-10-${String(id).padStart(2, '0')}T00:00:00Z`,
  created_at: `2026-10-${String(id).padStart(2, '0')}T00:00:00Z`,
  updated_at: `2026-10-${String(id).padStart(2, '0')}T00:00:25Z`,
  html_url: `https://github.com/fadhil/automit/actions/runs/${id}`, event: 'schedule', ...overrides,
});

function mockApi({ runs = [], commits = [], jobs = [], annotations = [], privateRepo = false, older = [] } = {}) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path === '/repos/fadhil/automit') return { ...repository, private: privateRepo };
    if (path.includes('/runs?') && path.includes('status=success')) return { workflow_runs: older };
    if (path.includes('/runs?')) return { workflow_runs: runs };
    if (path.includes('/commits?')) return commits;
    if (path.includes('/jobs?')) return { jobs };
    if (path.includes('/annotations?')) return annotations;
    throw new Error(`Unexpected API request: ${path}`);
  };
  return { get, calls };
}

test('initial repository has no fake success or error', async () => {
  const { get, calls } = mockApi();
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get, now: new Date('2026-10-20T03:00:00Z') });
  assert.equal(snapshot.latestRun, null);
  assert.equal(snapshot.lastSuccess, null);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.generatedAt, '2026-10-20T03:00:00.000Z');
  assert.deepEqual(snapshot.schedule, DEFAULT_SCHEDULE);
  assert.deepEqual(snapshot.schedule, {
    timezone: 'Asia/Jakarta',
    hours: [7, 10, 13, 16, 19],
    minute: 7,
  });
  assert.equal(calls.length, 2);
});

test('maps actual pushed SHA rather than pre-run workflow head SHA', async () => {
  const { get } = mockApi({ runs: [run(20), run(19)], commits: [
    { sha: 'actual-pushed-sha', commit: { message: 'chore: daily activity 2026-10-20\n\nAutomit-Run: 20\nhttps://github.com/fadhil/automit/actions/runs/20' } },
  ] });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get });
  assert.equal(snapshot.latestRun.commitSha, 'actual-pushed-sha');
  assert.equal(snapshot.latestRun.commitMessage, 'chore: daily activity 2026-10-20');
  assert.equal(snapshot.runs[1].commitSha, null);
  assert.equal(snapshot.lastSuccess.id, 20);
  assert.equal(snapshot.latestRun.durationSeconds, 25);
});

test('filters out redundant same-day no-op schedule checks after daily commit succeeds', async () => {
  const failedAt7 = run(20, 'failure', {
    run_started_at: '2026-10-20T00:00:00Z',
    updated_at: '2026-10-20T00:00:15Z',
  });
  const succeededAt10 = run(21, 'success', {
    run_started_at: '2026-10-20T03:00:00Z',
    updated_at: '2026-10-20T03:00:20Z',
  });
  const noopAt13 = run(22, 'success', {
    run_started_at: '2026-10-20T06:00:00Z',
    updated_at: '2026-10-20T06:00:05Z',
  });
  const { get } = mockApi({
    runs: [noopAt13, succeededAt10, failedAt7],
    commits: [
      { sha: 'retry-pushed-sha', commit: { message: 'chore: daily activity 2026-10-20\n\nAutomit-Run: 21\nhttps://github.com/fadhil/automit/actions/runs/21' } },
    ],
    jobs: [{ name: 'Commit harian', conclusion: 'failure', steps: [{ name: 'Push', conclusion: 'failure' }] }],
  });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get });
  assert.deepEqual(snapshot.runs.map((item) => item.id), [21, 20]);
  assert.equal(snapshot.latestRun.id, 21);
  assert.equal(snapshot.lastSuccess.id, 21);
  assert.equal(snapshot.lastSuccess.commitSha, 'retry-pushed-sha');
});

test('late scheduled runs skipped outside the WIB window never count as the day succeeding', async () => {
  const failedAt7 = run(20, 'failure', { run_started_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:15Z' });
  const failedAt19 = run(21, 'failure', { run_started_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:15Z' });
  // The 19:00 slot delayed past midnight to 00:30 and 06:59 WIB the next day.
  const skippedAfterMidnight = run(22, 'success', { run_started_at: '2026-10-20T17:30:00Z', updated_at: '2026-10-20T17:30:09Z' });
  const skippedBeforeSeven = run(23, 'success', { run_started_at: '2026-10-20T23:59:00Z', updated_at: '2026-10-20T23:59:09Z' });
  const { get } = mockApi({
    runs: [skippedBeforeSeven, skippedAfterMidnight, failedAt19, failedAt7],
    jobs: [{ name: 'Commit harian', conclusion: 'failure', steps: [{ name: 'Push', conclusion: 'failure' }] }],
  });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get });
  assert.deepEqual(snapshot.runs.map((item) => item.id), [21, 20]);
  assert.equal(snapshot.latestRun.conclusion, 'failure');
  assert.equal(snapshot.error.runId, 21);
});

test('failed push remains visible while preserving last successful execution', async () => {
  const { get } = mockApi({
    runs: [run(20, 'failure'), run(19)],
    jobs: [{ name: 'Commit harian', conclusion: 'failure', html_url: 'https://github.com/fadhil/automit/actions/runs/20/job/1',
      check_run_url: 'https://api.github.com/repos/fadhil/automit/check-runs/123',
      steps: [{ name: 'Checkout default branch', conclusion: 'success' }, { name: 'Commit dan push aktivitas harian', conclusion: 'failure' }] }],
    annotations: [{ annotation_level: 'failure', message: 'remote: Permission denied. token=ghp_superSecretValue' }],
  });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get });
  assert.equal(snapshot.latestRun.conclusion, 'failure');
  assert.equal(snapshot.lastSuccess.id, 19);
  assert.equal(snapshot.error.step, 'Commit dan push aktivitas harian');
  assert.match(snapshot.error.message, /Permission denied/);
  assert.doesNotMatch(JSON.stringify(snapshot.error), /superSecretValue/);
});

test('recovered workflow retains the most recent historical error with its own run id', async () => {
  const { get, calls } = mockApi({
    runs: [run(20), run(19, 'failure'), run(18, 'failure')],
    jobs: [{ name: 'Commit harian', conclusion: 'failure', steps: [{ name: 'Push', conclusion: 'failure' }] }],
  });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get });
  assert.equal(snapshot.latestRun.conclusion, 'success');
  assert.equal(snapshot.lastSuccess.id, 20);
  assert.equal(snapshot.error.runId, 19);
  assert.equal(calls.some((path) => path.includes('/runs/19/jobs?')), true);
  assert.equal(calls.some((path) => path.includes('/runs/20/jobs?')), false);
});

test('completion event overrides a lagging in-progress list result for the same attempt', async () => {
  const { get } = mockApi({ runs: [run(20, null, { status: 'in_progress', run_attempt: 1 })] });
  const triggeringRun = run(20, 'success', { name: 'Daily Auto Commit', run_attempt: 1,
    head_repository: { full_name: 'fadhil/automit' }, head_branch: 'main' });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get, triggeringRun });
  assert.equal(snapshot.latestRun.status, 'completed');
  assert.equal(snapshot.latestRun.conclusion, 'success');
});

test('old completion event never overwrites a newer running rerun', async () => {
  const { get } = mockApi({ runs: [run(20, null, { status: 'in_progress', run_attempt: 2 })] });
  const triggeringRun = run(20, 'failure', { name: 'Daily Auto Commit', run_attempt: 1,
    head_repository: { full_name: 'fadhil/automit' }, head_branch: 'main' });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get, triggeringRun });
  assert.equal(snapshot.latestRun.status, 'in_progress');
  assert.equal(snapshot.latestRun.conclusion, null);
});

test('completion from another repository cannot enter the published snapshot', async () => {
  const { get } = mockApi();
  const triggeringRun = run(20, 'success', { name: 'Daily Auto Commit',
    head_repository: { full_name: 'someone-else/automit' }, head_branch: 'main' });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get, triggeringRun });
  assert.equal(snapshot.latestRun, null);
});

test('private repository annotations are not fetched without explicit opt-in', async () => {
  const { get, calls } = mockApi({
    privateRepo: true, runs: [run(20, 'failure')],
    jobs: [{ name: 'Commit harian', conclusion: 'failure', check_run_url: 'https://api.github.com/repos/fadhil/automit/check-runs/123',
      steps: [{ name: 'Push', conclusion: 'failure' }] }],
    annotations: [{ annotation_level: 'failure', message: 'Internal detail' }],
  });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get });
  assert.deepEqual(snapshot.error.details, []);
  assert.equal(calls.some((path) => path.includes('/annotations?')), false);
});

test('private repository annotations can be explicitly published', async () => {
  const { get } = mockApi({
    privateRepo: true, runs: [run(20, 'failure')],
    jobs: [{ name: 'Commit', conclusion: 'failure', check_run_url: 'https://api.github.com/repos/fadhil/automit/check-runs/123' }],
    annotations: [{ annotation_level: 'failure', message: 'Push rejected by branch rules.' }],
  });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get, publishErrorDetails: true });
  assert.deepEqual(snapshot.error.details, ['Push rejected by branch rules.']);
});

test('older successful run is recovered beyond the first history page', async () => {
  const { get } = mockApi({ runs: [run(20, 'failure')], older: [run(1)] });
  const snapshot = await collectStatus({ repository: 'fadhil/automit', get });
  assert.equal(snapshot.lastSuccess.id, 1);
});

test('queued and running executions never receive completion timestamps', () => {
  const pending = normalizeRun(run(20, null, { status: 'queued' }));
  assert.equal(pending.completedAt, null);
  assert.equal(pending.durationSeconds, null);
  assert.equal(pending.status, 'queued');
  assert.equal(normalizeRun(run(20, null, { status: 'waiting' })).status, 'queued');
});

test('redacts standard credentials and control codes before publishing annotations', () => {
  const result = sanitizeMessage('\u001b[31mAuthorization: Bearer value123\u001b[0m\nhttps://alice:password@example.com\npassword="hidden"\napi_key=hidden\ngithub_pat_abcdef');
  assert.doesNotMatch(result, /value123|alice|hidden|abcdef|\u001b/);
  assert.match(result, /REDACTED/);
  assert.equal(sanitizeMessage('x'.repeat(3000)).length, 1800);
});

test('token is sent only to constructed GitHub API routes; API errors do not expose bodies', async () => {
  const get = createGitHubClient({ token: 'secret', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/fadhil/automit');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    return { ok: false, status: 403 };
  } });
  await assert.rejects(get('/repos/fadhil/automit'), /GitHub API gagal \(403\)/);
});

test('Jakarta date and hour change at local WIB boundaries rather than UTC', () => {
  assert.equal(jakartaDate(new Date('2026-10-20T16:59:59Z')), '2026-10-20');
  assert.equal(jakartaDate(new Date('2026-10-20T17:00:00Z')), '2026-10-21');
  assert.equal(jakartaHour(new Date('2026-10-20T18:00:00Z')), 1);
  assert.equal(jakartaHour(new Date('2026-10-20T00:00:00Z')), 7);
  assert.equal(jakartaHour(new Date('2026-10-20T12:00:00Z')), 19);
});

test('daily commit is idempotent, skips out-of-window 1 AM WIB schedule runs, and uses the human actor email', () => {
  const directory = mkdtempSync(join(tmpdir(), 'automit-git-'));
  const remote = join(directory, 'remote.git');
  const clone = join(directory, 'clone');
  const git = (args, cwd = directory) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '--bare', remote]);
    git(['clone', remote, clone]);
    git(['checkout', '-b', 'main'], clone);
    git(['config', 'user.name', 'Initial'], clone);
    git(['config', 'user.email', 'initial@example.com'], clone);
    writeFileSync(join(clone, 'README.md'), 'Automit\n');
    git(['add', 'README.md'], clone);
    git(['commit', '-m', 'Initial'], clone);
    git(['push', 'origin', 'main'], clone);
    const env = { GITHUB_ACTIONS: 'true', DEFAULT_BRANCH: 'main', GITHUB_REPOSITORY: 'fadhil/automit',
      GITHUB_RUN_ID: '123', AUTOMIT_ACTOR: 'fadhil', AUTOMIT_ACTOR_ID: '456', GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_EVENT_NAME: 'schedule' };
    // 18:00 UTC is 01:00 AM WIB next day -> must be skipped by the 07:00-24:00 WIB window guard
    const tooEarly = runDailyCommit({ env, cwd: clone, now: new Date('2026-10-19T18:00:00Z') });
    assert.equal(tooEarly.changed, false);
    assert.equal(git(['rev-list', '--count', 'HEAD'], clone), '1');

    // 00:00 UTC is 07:00 AM WIB -> first scheduled check succeeds
    const first = runDailyCommit({ env, cwd: clone, now: new Date('2026-10-20T00:00:00Z') });
    assert.equal(first.changed, true);
    assert.equal(git(['log', '-1', '--format=%ae'], clone), '456+fadhil@users.noreply.github.com');
    const saved = JSON.parse(readFileSync(join(clone, 'data/activity.json'), 'utf8'));
    assert.equal(saved.date, '2026-10-20');
    assert.equal(saved.runId, 123);
    assert.equal(saved.recordedAt, '2026-10-20T00:00:00.000Z');
    // 03:00 UTC is 10:00 AM WIB -> already committed today, no-op
    const second = runDailyCommit({ env: { ...env, GITHUB_RUN_ID: '124' }, cwd: clone, now: new Date('2026-10-20T03:00:00Z') });
    assert.equal(second.changed, false);
    assert.equal(git(['rev-list', '--count', 'HEAD'], clone), '2');
    assert.equal(second.commitSha, first.commitSha);
    // Next day 00:00 UTC (07:00 AM WIB) -> commits for the new day
    const third = runDailyCommit({ env: { ...env, GITHUB_RUN_ID: '125' }, cwd: clone, now: new Date('2026-10-21T00:00:00Z') });
    assert.equal(third.changed, true);
    assert.equal(git(['rev-list', '--count', 'HEAD'], clone), '3');
    // 23:59 UTC is 06:59 WIB -> before the window, skipped even though the day has no commit yet
    const early = runDailyCommit({ env: { ...env, GITHUB_RUN_ID: '126' }, cwd: clone, now: new Date('2026-10-21T23:59:00Z') });
    assert.equal(early.changed, false);
    assert.equal(git(['rev-list', '--count', 'HEAD'], clone), '3');
    // 16:59 UTC is 23:59 WIB -> a delayed 19:07 slot still attempts the commit before midnight
    const delayed = runDailyCommit({ env: { ...env, GITHUB_RUN_ID: '127' }, cwd: clone, now: new Date('2026-10-22T16:59:00Z') });
    assert.equal(delayed.changed, true);
    assert.equal(git(['rev-list', '--count', 'HEAD'], clone), '4');
    assert.equal(JSON.parse(readFileSync(join(clone, 'data/activity.json'), 'utf8')).date, '2026-10-22');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('daily script refuses to reset a normal developer checkout', () => {
  assert.throws(() => runDailyCommit({ env: {} }), /melalui GitHub Actions/);
});

test('rejected push reports failure without rewriting remote history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'automit-rejected-'));
  const remote = join(directory, 'remote.git');
  const clone = join(directory, 'clone');
  const git = (args, cwd = directory) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '--bare', remote]);
    git(['clone', remote, clone]);
    git(['checkout', '-b', 'main'], clone);
    git(['config', 'user.name', 'Initial'], clone);
    git(['config', 'user.email', 'initial@example.com'], clone);
    writeFileSync(join(clone, 'README.md'), 'Automit\n');
    git(['add', 'README.md'], clone);
    git(['commit', '-m', 'Initial'], clone);
    git(['push', 'origin', 'main'], clone);
    const originalSha = git(['rev-parse', 'main'], remote);
    const hook = join(remote, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "Push rejected by branch rules" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    assert.throws(() => runDailyCommit({
      cwd: clone, now: new Date('2026-10-20T00:00:00Z'),
      env: { GITHUB_ACTIONS: 'true', DEFAULT_BRANCH: 'main', GITHUB_REPOSITORY: 'fadhil/automit',
        GITHUB_RUN_ID: '123', AUTOMIT_ACTOR: 'fadhil', AUTOMIT_ACTOR_ID: '456' },
    }), /Push rejected by branch rules/);
    assert.equal(git(['rev-parse', 'main'], remote), originalSha);
    assert.equal(git(['rev-list', '--count', 'main'], remote), '1');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
