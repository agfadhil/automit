# Automit

A status page for automatic daily commits. Built with plain HTML, CSS, and JavaScript — no framework, production dependencies, or Personal Access Token required.

## One-time Setup

1. Save all project files to the **default branch** of your GitHub repository, e.g. `main`. Use your own repository (not a fork) so commits count toward your profile contribution graph.
2. In the repository, go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. This is required for the workflow to publish the status page.
3. Make sure GitHub Actions is enabled and that your default branch protection rules allow the workflow to push. The workflow requests `contents: write` permission; organization rules or rulesets may still block it. For protected work repositories, use a separate personal repo rather than weakening your work repo's rules.

Pushing the workflow configuration for the first time will trigger an automatic commit. After that, the schedule runs every 3 hours (`Asia/Jakarta`, UTC+7): starting at **07:07 WIB** (`00:07 UTC`), with retry checks at **10:07 WIB** (`03:07 UTC`), **13:07 WIB** (`06:07 UTC`), **16:07 WIB** (`09:07 UTC`), and a final check at **19:07 WIB** (`12:07 UTC`). Once a commit succeeds for the day, any remaining scheduled checks on the same WIB day finish immediately without creating additional commits.

GitHub often starts scheduled runs late, so the cron uses minute `:07` to avoid the busy top of the hour. A delayed run still attempts the commit as long as it starts between **07:00 and 22:00 WIB**; a scheduled run starting outside that window is skipped and is left out of the status page. Once 22:00 WIB passes without a successful commit, the status page marks that day as failed, even if GitHub never started an attempt.

The Pages URL will be available under **Settings → Pages** after the **Publish Automation Status** workflow succeeds. If the first publish run happens before Pages is enabled, manually trigger **Publish Automation Status → Run workflow** once after setting the Source above, or wait for the next daily execution. This is a one-time setup step, not a daily requirement.

## Commit Identity

By default, commits are attributed to the user who triggered the workflow using `ID+username@users.noreply.github.com`. For scheduled runs, GitHub determines the actor based on the user who last modified the schedule. To keep the identity fixed, set the following in **Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
| --- | --- |
| `COMMIT_AUTHOR_NAME` | Your GitHub name or username |
| `COMMIT_AUTHOR_EMAIL` | The commit email linked to your account; copy the noreply address exactly from GitHub Settings → Emails |

The author email must be linked to your GitHub account for commits to appear in your contribution graph. To show private repo contributions on your profile, enable **Private contributions** on your GitHub profile.

## How Status Is Updated

- **Daily Auto Commit** records the date, actual timestamp, run ID, and workflow reference to `data/activity.json`, then commits and pushes only that file. At most one activity commit per date; conflicting pushes are retried without force-push.
- **Publish Automation Status** runs after the daily workflow finishes, including on failure. This workflow reads results from the GitHub Actions API, saves a `data/status.json` snapshot in a Pages artifact, and deploys to Pages. The status does not depend on whether the daily commit push succeeded.
- The snapshot includes the most recent run, last success, duration, history, and a summary of the last failure. Failure details remain readable after automation recovers. Commit SHAs refer to commits that were actually pushed; backup runs that did not create a commit have an empty SHA. "Last succeeded" means the most recent successful run, including backup runs with no new commit.
- Publishing does not create additional commits and does not download or run artifacts from the triggering workflow. Checkout always comes from the repo's own default branch.

Data shown on Pages is the **last successfully published snapshot**, not a live connection to the runner. If the reporting workflow or the Pages deploy itself fails, the previous page remains visible; check the update time and open the Actions tab for diagnosis. Workflows that have never run will not be shown as successful.

## Error Details

For public repos, GitHub annotation error messages are published after being length-limited and filtered for common credential patterns. Raw logs are never published. The **GitHub Actions** link opens the full log.

For private repos, annotation details are not published by default; the page still shows the failure result along with the job/step name. To allow error details on the page, set the variable `PUBLISH_ERROR_DETAILS=true`. Set it to `false` to disable details even for public repos. Treat the content of the Pages site as information visible to any page visitor; pattern filtering is not a guarantee that all sensitive information has been removed.

## Local Development

Run the development server from the project folder:

```sh
npm run dev
```

Open the localhost address shown by the server. A page without a run snapshot will display an "no executions yet" state. Do not store GitHub tokens in browser-side JavaScript.

To preview the design with **demo-labeled sample data**, open `http://127.0.0.1:4173/?demo=success` or `?demo=error`. The `?demo=running` and `?demo=waiting` modes are also available. The normal page does not use sample data. Demo parameters only affect the browser display — they do not trigger or modify any workflows.

The **Refresh** button re-fetches the page snapshot; an automatic re-check also runs every 60 seconds while the tab is visible. Click an activity bar to see a summary for that date. History shows the three most recent runs, expandable, with last-failure details and a GitHub log link. Error details can be copied.

Run all tests and check frontend syntax:

```sh
npm test
npm run check
```

Test status collection, error redaction, commit idempotency, author email, and WIB date boundary:

```sh
node --test tests/automation.test.mjs
```

`scripts/daily-commit.mjs` must only be run inside a GitHub Actions runner checkout; it rejects a regular local checkout. `scripts/build-status.mjs` is used by the publish workflow to build the `dist/` folder.

## Service Limitations

GitHub Actions may delay or skip scheduled runs during busy queue periods; two schedules reduce the risk but do not guarantee an unbroken streak. Public repo schedules are automatically disabled after 60 days of no repository activity. Pages and Actions quota/permissions depend on your GitHub settings and plan.

Official documentation: [Schedule and workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [contribution criteria](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference), [GitHub Pages with Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
