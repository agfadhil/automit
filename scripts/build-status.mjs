import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORKFLOW_FILE = 'daily-commit.yml';
export const API_VERSION = '2026-03-10';
export const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
export const DEFAULT_SCHEDULE = {
  timezone: 'Asia/Jakarta',
  hours: [7, 10, 13, 16, 19],
  minute: 7,
};

function wibDateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function wibHour(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false,
  }).formatToParts(date).find((part) => part.type === 'hour')?.value);
  return hour === 24 ? 0 : hour;
}

// GitHub can start a scheduled run hours late. daily-commit.mjs exits 0 without
// committing when the 19:07 slot slips past midnight into 00:00-07:00 WIB, so such
// a run is not an attempt and must never count as the day's success.
function isOutOfWindowSkip(run, commitsByRun) {
  if (run.event !== 'schedule' || run.status !== 'completed' || run.conclusion !== 'success') return false;
  if (commitsByRun.has(Number(run.id))) return false;
  const hour = wibHour(run.run_started_at || run.created_at);
  return hour !== null && hour < 7;
}

function filterRedundantDailyRuns(rawRuns, commitsByRun) {
  // Sort oldest-first to find the first successful run per WIB day.
  // Subsequent scheduled runs on the same WIB day that exit 0 without creating a commit
  // are no-op checks after the 1x daily target has already been met.
  const chronological = [...rawRuns].reverse();
  const succeededDays = new Set();
  const redundantIds = new Set();
  for (const run of chronological) {
    if (isOutOfWindowSkip(run, commitsByRun)) {
      redundantIds.add(Number(run.id));
      continue;
    }
    const day = wibDateKey(run.run_started_at || run.created_at);
    if (!day) continue;
    if (run.status === 'completed' && run.conclusion === 'success') {
      const hasCommit = commitsByRun.has(Number(run.id));
      if (succeededDays.has(day) && !hasCommit) {
        redundantIds.add(Number(run.id));
      } else {
        succeededDays.add(day);
      }
    }
  }
  return rawRuns.filter((run) => !redundantIds.has(Number(run.id)));
}

export function sanitizeMessage(value, limit = 1800) {
  return String(value ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(token|password|secret|api[_-]?key)(\s*[=:]\s*)(["']?)[^\s"',;]+/gi, '$1$2[REDACTED]')
    .trim().slice(0, limit);
}

export function normalizeRun(run, commitsByRun = new Map()) {
  const startedAt = run.run_started_at || run.created_at || null;
  const completedAt = run.status === 'completed' ? (run.updated_at || null) : null;
  const duration = completedAt && startedAt ? (Date.parse(completedAt) - Date.parse(startedAt)) / 1000 : null;
  const commit = commitsByRun.get(Number(run.id));
  return {
    id: Number(run.id),
    number: Number(run.run_number),
    status: run.status === 'completed' ? 'completed' : (run.status === 'in_progress' ? 'in_progress' : 'queued'),
    conclusion: run.conclusion || null,
    startedAt,
    completedAt,
    durationSeconds: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : null,
    url: run.html_url || null,
    event: run.event || null,
    commitSha: commit?.sha || null,
    commitMessage: commit ? sanitizeMessage(commit.commit?.message?.split('\n')[0], 200) : null,
  };
}

export function createGitHubClient({ token, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch } = {}) {
  const base = apiUrl.replace(/\/$/, '');
  return async (path, { allowNotFound = false } = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404 && allowNotFound) return null;
    if (!response.ok) throw new Error(`GitHub API gagal (${response.status}) saat membaca status workflow.`);
    return response.json();
  };
}

async function findFailure({ run, get, prefix, publishDetails }) {
  const result = await get(`${prefix}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  const jobs = result?.jobs || [];
  const failedJob = jobs.find((job) => FAILURE_CONCLUSIONS.has(job.conclusion));
  const failedStep = failedJob?.steps?.find((step) => FAILURE_CONCLUSIONS.has(step.conclusion));
  const job = sanitizeMessage(failedJob?.name || 'Workflow', 160);
  const step = sanitizeMessage(failedStep?.name || (run.conclusion === 'timed_out' ? 'Batas waktu eksekusi' : 'Eksekusi workflow'), 160);
  let details = [];
  if (publishDetails && failedJob?.check_run_url) {
    // Derive a numeric check id, never follow an arbitrary URL with the token.
    const checkId = /\/check-runs\/(\d+)$/.exec(failedJob.check_run_url)?.[1];
    if (checkId) {
      const annotations = await get(`${prefix}/check-runs/${checkId}/annotations?per_page=30`, { allowNotFound: true });
      details = (annotations || [])
        .filter((annotation) => annotation.annotation_level === 'failure')
        .map((annotation) => sanitizeMessage(annotation.message))
        .filter(Boolean).slice(0, 5);
    }
  }
  return {
    runId: Number(run.id),
    message: details[0] || `Automasi gagal pada langkah “${step}”. Buka GitHub Actions untuk melihat log lengkap.`,
    step,
    job,
    details,
    url: failedJob?.html_url || run.html_url || null,
  };
}

export async function collectStatus({
  repository,
  get,
  now = new Date(),
  publishErrorDetails,
  triggeringRun,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) {
    throw new Error('GITHUB_REPOSITORY harus berupa owner/repository.');
  }
  const prefix = `/repos/${repository}`;
  const repo = await get(prefix);
  const branch = repo.default_branch;
  const query = `per_page=100&branch=${encodeURIComponent(branch)}`;
  const rawResponse = await get(`${prefix}/actions/workflows/${WORKFLOW_FILE}/runs?${query}`, { allowNotFound: true });
  const runsById = new Map((rawResponse?.workflow_runs || []).map((run) => [Number(run.id), run]));
  // GitHub's run-list endpoint can lag behind the completion webhook. Prefer a
  // validated completion payload for the same attempt, but never overwrite a
  // newer rerun with an older completion event.
  if (triggeringRun?.name === 'Daily Auto Commit' &&
      triggeringRun.head_repository?.full_name?.toLowerCase() === repository.toLowerCase() &&
      triggeringRun.head_branch === branch && triggeringRun.status === 'completed' &&
      Number.isSafeInteger(Number(triggeringRun.id)) && Number(triggeringRun.id) > 0) {
    const listed = runsById.get(Number(triggeringRun.id));
    const triggerAttempt = Number(triggeringRun.run_attempt || 1);
    const listedAttempt = Number(listed?.run_attempt || 1);
    if (!listed || triggerAttempt > listedAttempt ||
        (triggerAttempt === listedAttempt && (listed.status !== 'completed' ||
          Date.parse(triggeringRun.updated_at) >= Date.parse(listed.updated_at)))) {
      runsById.set(Number(triggeringRun.id), triggeringRun);
    }
  }
  const sortedRawRuns = [...runsById.values()].sort((a, b) =>
    Date.parse(b.run_started_at || b.created_at) - Date.parse(a.run_started_at || a.created_at) || Number(b.id) - Number(a.id));
  const hasRuns = sortedRawRuns.length > 0;
  const commits = hasRuns
    ? await get(`${prefix}/commits?path=data%2Factivity.json&per_page=100&sha=${encodeURIComponent(branch)}`)
    : [];
  const commitsByRun = new Map();
  for (const commit of commits || []) {
    const runId = /^Automit-Run: (\d+)$/m.exec(commit.commit?.message || '')?.[1];
    if (runId) commitsByRun.set(Number(runId), commit);
  }
  const rawRuns = filterRedundantDailyRuns(sortedRawRuns, commitsByRun);
  const runs = rawRuns.map((run) => normalizeRun(run, commitsByRun));
  let lastSuccess = runs.find((run) => run.conclusion === 'success') || null;
  if (!lastSuccess && hasRuns) {
    const older = await get(`${prefix}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1&branch=${encodeURIComponent(branch)}&status=success`);
    if (older.workflow_runs?.[0]) lastSuccess = normalizeRun(older.workflow_runs[0], commitsByRun);
  }
  const rawFailure = rawRuns.find((run) => FAILURE_CONCLUSIONS.has(run.conclusion));
  let error = null;
  if (rawFailure) {
    // Public annotations are already public. Private annotations are opt-in.
    const publishDetails = publishErrorDetails ?? !repo.private;
    try {
      error = await findFailure({ run: rawFailure, get, prefix, publishDetails });
    } catch {
      error = {
        runId: Number(rawFailure.id),
        message: 'Automasi gagal. Detail error belum dapat diambil; buka log GitHub Actions.',
        step: 'Eksekusi workflow', job: 'Workflow', details: [], url: rawFailure.html_url || null,
      };
    }
  }
  return {
    schemaVersion: 1,
    repository: {
      owner: repo.owner?.login || repository.split('/')[0],
      name: repo.name || repository.split('/')[1],
      url: repo.html_url,
      defaultBranch: branch,
    },
    workflow: {
      file: WORKFLOW_FILE,
      name: 'Daily Auto Commit',
      url: `${repo.html_url}/actions/workflows/${WORKFLOW_FILE}`,
    },
    schedule: DEFAULT_SCHEDULE,
    generatedAt: now.toISOString(),
    lastSuccess,
    latestRun: runs[0] || null,
    runs,
    error,
  };
}

export async function buildSite({ env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch } = {}) {
  const get = createGitHubClient({ token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL, fetchImpl });
  const publishErrorDetails = env.PUBLISH_ERROR_DETAILS === 'true' ? true
    : (env.PUBLISH_ERROR_DETAILS === 'false' ? false : undefined);
  let triggeringRun;
  if (env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_EVENT_PATH) {
    triggeringRun = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')).workflow_run;
  }
  const status = await collectStatus({ repository: env.GITHUB_REPOSITORY, get, publishErrorDetails, triggeringRun });
  const output = resolve(cwd, 'dist');
  await rm(output, { recursive: true, force: true });
  await mkdir(resolve(output, 'data'), { recursive: true });
  await cp(resolve(cwd, 'index.html'), resolve(output, 'index.html'));
  await cp(resolve(cwd, 'assets'), resolve(output, 'assets'), { recursive: true });
  await writeFile(resolve(output, 'data/status.json'), `${JSON.stringify(status, null, 2)}\n`);
  await writeFile(resolve(output, '.nojekyll'), '');
  // An initial deployment is valid even before the daily workflow has ever run.
  console.log(`Status diperbarui: ${status.runs.length} eksekusi, ${status.latestRun?.conclusion || 'menunggu eksekusi pertama'}.`);
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSite().catch((error) => {
    console.error(sanitizeMessage(error.message));
    process.exitCode = 1;
  });
}
