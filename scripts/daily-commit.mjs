import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function jakartaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function runDailyCommit({ env = process.env, cwd = process.cwd(), now = new Date() } = {}) {
  if (env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Jalankan melalui GitHub Actions; script ini memakai checkout runner sementara.');
  }
  const branch = env.DEFAULT_BRANCH;
  if (!branch || branch.startsWith('-') || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) {
    throw new Error('Konteks repository, default branch, atau workflow run tidak tersedia.');
  }
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...env, TZ: 'Asia/Jakarta' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (git('status', '--porcelain')) throw new Error('Checkout runner harus bersih sebelum membuat commit.');
  const author = env.COMMIT_AUTHOR_NAME || env.AUTOMIT_ACTOR;
  const email = env.COMMIT_AUTHOR_EMAIL || `${env.AUTOMIT_ACTOR_ID}+${env.AUTOMIT_ACTOR}@users.noreply.github.com`;
  if (!author || (!env.COMMIT_AUTHOR_EMAIL && (!env.AUTOMIT_ACTOR_ID || !env.AUTOMIT_ACTOR))) {
    throw new Error('Identitas author commit tidak tersedia.');
  }
  git('config', 'user.name', author);
  git('config', 'user.email', email);
  const date = jakartaDate(now);
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const runUrl = `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const activityFile = resolve(cwd, 'data/activity.json');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    git('fetch', 'origin', branch);
    // This operates only on an ephemeral Actions checkout, never the remote history.
    // Regenerate the tiny daily change from the latest branch on a push race.
    git('reset', '--hard', `origin/${branch}`);
    let previous = null;
    try {
      previous = JSON.parse(readFileSync(activityFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('data/activity.json tidak valid; perbaiki file sebelum menjalankan ulang.');
    }
    if (previous?.date === date) {
      const commitSha = git('rev-parse', 'HEAD');
      console.log(`Aktivitas ${date} sudah tersimpan; tidak membuat commit tambahan.`);
      if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `Aktivitas harian **${date}** sudah tercatat sebelumnya (\`${commitSha}\`); melewati auto-commit tambahan.\n`);
      }
      if (env.GITHUB_OUTPUT) {
        appendFileSync(env.GITHUB_OUTPUT, `changed=false\ndate=${date}\ncommit_sha=${commitSha}\n`);
      }
      return { changed: false, date, commitSha };
    }
    const activity = {
      schemaVersion: 1,
      date,
      recordedAt: now.toISOString(),
      runId: Number(env.GITHUB_RUN_ID),
      runUrl,
      baseSha: git('rev-parse', 'HEAD'),
    };
    mkdirSync(dirname(activityFile), { recursive: true });
    writeFileSync(activityFile, `${JSON.stringify(activity, null, 2)}\n`);
    git('add', '--', 'data/activity.json');
    git('commit', '-m', `chore: daily activity ${date}`, '-m', `Automit-Run: ${env.GITHUB_RUN_ID}\n${runUrl}`);
    try {
      git('push', 'origin', `HEAD:refs/heads/${branch}`);
      const commitSha = git('rev-parse', 'HEAD');
      console.log(`Aktivitas ${date} berhasil dipush (${commitSha.slice(0, 7)}).`);
      if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `Commit harian **${date}** berhasil: \`${commitSha}\`.\n`);
      }
      if (env.GITHUB_OUTPUT) {
        appendFileSync(env.GITHUB_OUTPUT, `changed=true\ndate=${date}\ncommit_sha=${commitSha}\n`);
      }
      return { changed: true, date, commitSha };
    } catch (error) {
      lastError = error;
      console.warn(`Push percobaan ${attempt}/3 gagal; memeriksa kembali default branch.`);
    }
  }
  const stderr = lastError?.stderr?.toString().trim();
  throw new Error(stderr || 'Push gagal setelah tiga percobaan. Periksa izin token dan aturan default branch.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runDailyCommit();
  } catch (error) {
    const message = String(error.message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error title=Daily auto commit gagal::${message}`);
    process.exitCode = 1;
  }
}
