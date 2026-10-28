# CLAUDE.md

Guidance for working in this repository.

## What this is

Automit makes one automatic GitHub commit per day (WIB, `Asia/Jakarta`, UTC+7) via GitHub Actions, and publishes a static status page to GitHub Pages showing run history, last success, and last-failure details.

- Plain HTML/CSS/ES modules, Node >= 22 (CI uses Node 24). **No dependencies** — not even dev dependencies. Don't add any without a strong reason.
- Tests use the built-in `node:test` runner.
- User-facing strings (UI, log messages, workflow step names, error messages) are in **Indonesian**. Code comments and the README are in English. Keep that split.

## Commands

```sh
npm run dev      # static server at http://127.0.0.1:4173 (PORT overrides)
npm test         # node --test tests/*.test.mjs
npm run check    # node --check on the three browser modules
node --test tests/automation.test.mjs   # just the script tests
```

Demo UI with sample data: `?demo=success`, `?demo=error`, `?demo=running`, `?demo=waiting`.

## Layout

```
.github/workflows/
  daily-commit.yml      "Daily Auto Commit" — cron + push + manual; runs scripts/daily-commit.mjs
  publish-status.yml    "Publish Automation Status" — on workflow_run of the above (and pushes to UI files); builds dist/ and deploys Pages
scripts/
  daily-commit.mjs      writes data/activity.json, commits, pushes (retries 3x)
  build-status.mjs      queries GitHub API → status snapshot → dist/
  serve.mjs             local dev server (only serves /index.html, /assets/*, /data/*)
assets/
  app.js                DOM rendering, fetch/refresh loop (60s while tab visible)
  status.js             pure logic: WIB date keys, formatting, run state, schedule, snapshot validation
  demo.js               demo snapshots, dynamically imported only in ?demo= mode
  styles.css            minified single-file stylesheet
data/
  activity.json         the file the daily commit touches (date, runId, runUrl, baseSha)
  status.json           committed empty placeholder snapshot; the real one is generated into dist/ only
tests/
  automation.test.mjs   build-status + daily-commit (uses temp bare git repos)
  frontend.test.mjs     assets/status.js
```

## How the pieces connect

1. **daily-commit.mjs** (in Actions only — it throws unless `GITHUB_ACTIONS=true`, because it does `git reset --hard`):
   - Skips scheduled runs outside the WIB window; idempotent per WIB date — if `data/activity.json` already has today's `date`, it exits successfully with no commit.
   - Commit message is `chore: daily activity YYYY-MM-DD` with a body trailer `Automit-Run: <run id>` plus the run URL. **build-status.mjs parses that trailer** to map runs to pushed commit SHAs — don't change the format on one side only.
   - Commit identity: `COMMIT_AUTHOR_NAME`/`COMMIT_AUTHOR_EMAIL` repo variables, falling back to `<actor_id>+<actor>@users.noreply.github.com`.
   - On push rejection: fetch, hard reset to `origin/<branch>`, regenerate, retry (3 attempts). Never force-push.
2. **build-status.mjs** (publish workflow): reads the daily workflow's runs on the default branch plus commits touching `data/activity.json`, then builds a `schemaVersion: 1` snapshot. Notable behaviour:
   - Prefers the `workflow_run` event payload over a lagging run list, but only for the same repo/branch and never over a newer attempt.
   - Drops redundant same-WIB-day successful runs that made no commit (later retry slots after the day's commit).
   - Failure details come from check-run annotations, run through `sanitizeMessage()` (redacts tokens, auth headers, URL creds, `key=value` secrets). Private repos don't publish annotations unless `PUBLISH_ERROR_DETAILS=true`; `false` disables them for public repos too.
   - Output: `dist/` = `index.html` + `assets/` + generated `data/status.json` + `.nojekyll`.
3. **Frontend** fetches `./data/status.json`, validates it with `validateSnapshot()`, and renders. Only `https:` URLs are linked (`safeURL`). Build DOM with `textContent`/`element()`; `innerHTML` is only used for static SVG icon markup.

## Invariants and gotchas

- **Everything is WIB-based.** Day boundaries are Jakarta midnight, not UTC. Use the existing helpers (`jakartaDate`/`jakartaHour` in scripts, `dateKey` in `status.js`) — never `toISOString().slice(0, 10)` on a raw date.
- **The schedule is duplicated** and must be changed together:
  - cron in `daily-commit.yml` (`7 0,3,6,9,12 * * *` UTC = 07:07/10:07/13:07/16:07/19:07 WIB)
  - `DEFAULT_SCHEDULE` in `scripts/build-status.mjs` and `assets/status.js`
  - `assets/demo.js`, `data/status.json`, footer text in `index.html`, the README, and tests in both test files
  - the out-of-window guard in `daily-commit.mjs` (skips when `hour < 7`, so attempts run 07:00–24:00 WIB — a delayed 19:07 slot still commits until midnight), mirrored by `isOutOfWindowSkip()` in `build-status.mjs`, which drops those skipped runs so they never count as a success. A tracked WIB day that ends without a success shows as failed in the activity chart (`dailyActivity()`) and, the next day, on the status card (`missedDay()`)
- The workflow names `Daily Auto Commit` and file `daily-commit.yml` are hard-coded in `publish-status.yml` and `build-status.mjs`.
- Failure conclusions (`failure`, `timed_out`, `action_required`, `startup_failure`, `stale`) are defined in both `build-status.mjs` and `status.js`.
- Security posture of `publish-status.yml` is deliberate: read-only token in build, `persist-credentials: false`, only the default branch is checked out, nothing from the triggering run is downloaded or executed. The GitHub client only fetches constructed API paths (a check-run id is extracted from the URL rather than following it). Preserve these.
- The page must never show a fake success: missing/initial snapshots render a "waiting" state, and demo data is only loaded with an explicit `?demo=` param and is labelled as such.
- Don't hand-edit `data/activity.json`; the daily workflow owns it. Commits titled `chore: daily activity …` in history are automated.
- New scripts follow the existing pattern: export pure functions taking injectable `env`/`cwd`/`now`/`fetchImpl`/`get`, and run only when invoked as the entry point, so tests can import them.

## Commits

History uses Conventional Commits (`feat(schedule): …`, `docs: …`, `chore: …`).
