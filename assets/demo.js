// Loaded only when explicitly requested via ?demo=success, ?demo=error, etc.
// Demo snapshots are never committed as real status or used by the workflows.
export function demoSnapshot(mode = 'success', now = new Date()) {
  const day = 86_400_000;
  const latest = now.getTime() - 120_000;
  const runs = Array.from({ length: 30 }, (_, index) => {
    const start = new Date(latest - index * day);
    const failed = index === 2 || (mode === 'error' && index === 0);
    return { id: 1000 - index, number: 128 - index, status: 'completed', conclusion: failed ? 'failure' : 'success', startedAt: start.toISOString(), completedAt: new Date(start.getTime() + 12_000).toISOString(), durationSeconds: 12 - index % 3, url: 'https://github.com', event: 'schedule', commitSha: failed ? null : `b7e29${String(index).padStart(2, '0')}db4e6156b4fb808f94c62e8c29e513604`, commitMessage: failed ? null : `chore: daily activity ${start.toISOString().slice(0, 10)}` };
  });
  if (mode === 'waiting') runs.length = 0;
  if (mode === 'running') { runs[0].status = 'in_progress'; runs[0].conclusion = null; runs[0].completedAt = null; runs[0].durationSeconds = null; runs[0].commitSha = null; }
  const failedRun = runs.find((run) => run.conclusion === 'failure');
  return {
    schemaVersion: 1, repository: { owner: 'contoh', name: 'automit', defaultBranch: 'main', url: 'https://github.com' },
    workflow: { file: 'daily-commit.yml', name: 'Daily Auto Commit', url: 'https://github.com' },
    schedule: { timezone: 'Asia/Jakarta', hours: [8, 15, 16, 17, 18, 19, 20, 21, 22, 23], minute: 0 }, generatedAt: now.toISOString(),
    lastSuccess: runs.find((run) => run.conclusion === 'success') || null, latestRun: runs[0] || null, runs,
    error: failedRun ? { runId: failedRun.id, message: 'Push ke repository ditolak. Token workflow belum memiliki izin untuk mengubah default branch.', step: 'Commit dan push aktivitas harian', job: 'Commit harian', details: ['remote: Permission to contoh/automit.git denied to github-actions[bot].', 'fatal: unable to access repository: The requested URL returned error: 403', 'Periksa permissions.contents: write dan aturan proteksi branch di repository.'], url: 'https://github.com' } : null,
  };
}
