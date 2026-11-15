# DORA baseline

Measured on 2026-11-15 for the 90 days from 2026-08-17 00:00 UTC to 2026-11-15 00:00 UTC, before phase A0 merges.
The repository is `Chykalophia/ooohm` and the production app is the Vercel project `ooohm` (hr.cklph.dev). The same
calls are to be re-run at the end of phases A3 and A8 (see [03-phased-plan.md](03-phased-plan.md)).

| Metric | Baseline | Basis |
| --- | --- | --- |
| Deployments to production per week | **17 a week** (2.6 a week averaged over all 90 days) | 34 successful production deployments, all in the two weeks the Vercel project has existed |
| Median lead time, first commit to merge | **1.5 hours** (25th percentile 0.2 h, 75th 71 h) | 43 PRs merged into `main` |
| Change-failure rate | **8.8%** (3 of 34); 5.9% (2 of 34) on the strictest reading | Failures followed by a fix PR within 7 days; no reverts or rollbacks were found |
| Time to restore (median) | **1.4 hours** (the three failures: 0.3 h, 1.4 h, 4.6 h) | From the failing deployment to the fix's merge |

## How each number was measured

All calls only read data. Times are UTC. The window's millisecond bounds are `since: 1786924800000` (2026-08-17) and
`until: 1794700800000` (2026-11-15). For a later re-run, move both bounds to the 90 days before that date.

### 1. Deployments to production per week

1. `mcp__Vercel__list_teams` gives the team `peter-chykalophias-projects` (`team_t6QTBv4Qz15Bal09Q1mUBvI6`).
2. `mcp__Vercel__list_projects` with `teamId` set to that team and `search: "ooohm"` lists two projects. The app is `ooohm`
   (`prj_dVAzoh4Gx1qDyv90LKPALfjGLqlI`). `ooohm-site` is the marketing site and is left out.
   `mcp__Vercel__list_project_domains` with `idOrName` set to the app's project ID confirms that hr.cklph.dev belongs to it.
3. `mcp__Vercel__list_deployments` with `projectId: "prj_dVAzoh4Gx1qDyv90LKPALfjGLqlI"`, the same `teamId`,
   `target: "production"`, `since`, `until` and `limit: 100`. Follow `pagination.next` if it is present. This run
   returned 36 deployments and no next page.
4. Count the deployments whose `state` is `READY` (34). The two in `ERROR` state were failed builds of #73 that never
   served traffic, so they are not counted.
5. Group by ISO week of `created`. Week 45 (Nov 2–8) had 18 and week 46 (Nov 9–15) had 16, so the rate was 17 a week.
   Dividing by the window's 12.9 weeks gives 2.6 a week.

### 2. Median lead time

1. `mcp__github__list_pull_requests` with `owner: "Chykalophia"`, `repo: "ooohm"`, `state: "closed"`, `perPage: 100` and
   `fields: ["number","title","merged_at","created_at","base","head"]`. Page until a page holds fewer than 100 (98 here).
2. Keep PRs whose `base.ref` is `main` and whose `merged_at` falls in the window. That left 43: #1–3, #14–16, #54, #57,
   #65–68, #70–98 and #100–101. #102 merged on 2026-11-15 at 04:17, after the window closed.
3. For each one, call `mcp__github__pull_request_read` with `method: "get_commits"`, `pullNumber` and `perPage: 100`.
   Ask for `page: 2` when a page comes back full (#54 has more than 100 commits). The first commit is the earliest
   `author.date`.
4. The lead time is `merged_at` minus that date, and the baseline is the median of the 43 values.

### 3. Change-failure rate

A production deployment counts as failed when one of these follows it within 7 days: a revert of its change, a Vercel
rollback, or a PR that fixes a defect the deployment introduced. No PR title in the window contains "revert",
"rollback" or "regression", and `mcp__Vercel__list_deployments` shows no redeploy of an older commit after a newer
one. So every failure was found by judging fix PRs. I read the title of each PR merged into `main`, and for each
candidate I read its body (`pull_request_read` with `method: "get"`) and its commits to check that the defect came in
with a deployment from the previous 7 days. A defect that was already there before the window, or a follow-up that only
added to a feature, does not count.

| Failing deployment | Fix | Why it counts |
| --- | --- | --- |
| `dpl_FHqEmYk1QL6aDxcvWjLsJpXtV2Rv`, #66, 2026-11-04 15:43, deployed with the CLI | #67 "Keep local env files and tool folders out of CLI deploys", merged 16:00 | Its commit says CLI deploys uploaded the local `.env` (with dev-only switches such as `WEBHOOK_ALLOW_PRIVATE=true`) to production. This one is a judgement call, and it is the only difference between 8.8% and 5.9%. |
| `dpl_DpQtxaNfWzC5erq1svCyrgrUaSCe`, #70, 2026-11-04 18:34 | #71 "Approvals: keep focus on the page when the last request is decided", merged 19:56 | Its body says it follows up #70. #70's fold-away left keyboard and screen-reader users at the top of the page. |
| `dpl_8AAm6EHSrh5E4qXa3ugy4xPTnioq`, #91, 2026-11-09 17:16 | #93 "Date picker: fix the oversized selected day on Legible…", merged 21:33, and #94 "Date picker: keep the selected day the grid's size on Tonal…", merged 21:53 | Both fix the date picker that #91 shipped. They count as one failure. |

PRs that were considered and left out: #73 (the archive-question layout had been wrong since before the window), #97
(department counts that included deactivated people, also an older bug), #88 (the site following the app's new teal,
which is not a defect) and #95 and #98 (feature changes).

The rate is failures divided by successful production deployments: 3 / 34.

### 4. Time to restore

For each failure, the time to restore runs from the failing deployment's `created` time to the fix PR's `merged_at`.
When a failure needed several fixes, it ends at the last one (#94 for #91). The times were 0.3 h, 1.4 h and 4.6 h, and
the median is 1.4 h. Without the #66/#67 judgement call it is 3.0 h, the median of 1.4 h and 4.6 h. If the #91 failure
is taken as restored by its first fix (#93), it took 4.3 h, and the median is unchanged.

## Caveats

- **The history is about two weeks, not 90 days.** The repo's first PR was opened on 2026-11-01, and the Vercel project
  was created on 2026-11-02. Every deployment and every merge falls between Nov 2 and Nov 15. The weekly rate is taken
  over the weeks the project existed. Averaged over the whole window it would be 2.6 a week, which describes nothing.
  At A3 and A8, measure a full 90 days.
- **Startup work distorts the lead-time spread.** #75 and #86 show 136 h because GitHub lists landing-page commits from
  #57 in their branches. #76–#85 sat open for about 71 h and then shipped together through #86. Leaving out #54, #75 and
  #86 moves the median only from 1.5 h to 1.2 h. Most PRs in this period were written by agents and merged within minutes,
  which keeps the median low.
- **This counts PRs whose base is `main`.** Before the first release (#54, Nov 3), work merged into `dev` or into stacked
  branches. Those PRs are not counted on their own, and their commits count inside #54's lead time.
- **Some production deployments did not come from `main`.** Six early ones came from `dev` and from a `claude/…` branch,
  and some were CLI uploads (`githubCommitRef` `HEAD`, or no git metadata at all). Five were rebuilds of a commit
  already deployed (for example #89 twice and #52's merge three times). All of them are counted, because each one put a
  new build in production. Counting distinct commits instead would give about 29.
- **Rollbacks may be missed.** A Vercel instant rollback re-points the domain without creating a deployment, and
  `mcp__Vercel__list_aliases` for hr.cklph.dev returned nothing. Neither call shows rollback history. If a dashboard
  rollback happened, it is not counted.
- **Failures come from judgement.** No PR is labelled as a regression fix. The rate depends on reading titles and bodies,
  and on the #67 call.
- **The deployment rate includes rebuilds that changed no code**, such as redeploys after an environment change.
