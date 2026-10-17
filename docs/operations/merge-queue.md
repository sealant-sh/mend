# Merge queue activation

Mend's required CI workflow supports `pull_request`, `merge_group: checks_requested`, manual
dispatch and the nightly schedule. Pull requests use affected Turbo tasks, and so do merge groups,
with a full-graph fallback (below); the `checks` job rejects any missing, skipped, cancelled or
failed required lane. There is no post-merge `push: main` run: every commit reaches `main` through
the queue, and the merge-group run tests exactly that commit and is the trusted cache writer.

## Affected merge groups

Yiannis approved this on 2026-10-15, for the speed and because a release still runs everything:
`next-channel.md` step 8 dispatches `ci.yml` on the Version pull request, which runs the full graph,
then packaged acceptance.

- The `changes` job diffs the whole group, `merge_group.base_sha...head_sha`, so a batch of five
  pull requests is scoped by all five (`scripts/ci-scope.mjs --merge-group`). Its `graph` output is
  `affected` only when every changed path lies in an `apps/`, `packages/` or `tooling/` workspace
  package and none is a `turbo.json`; a changeset (`.changeset/**`) is allowed, since only
  versioning reads it, and so is root `docs/**`: no Turbo task reads it (`apps/docs` builds from its
  own `src/`), and `format:check`, its one reader, runs on every event. A root file, the lockfile,
  the workflows, `scripts/`, `deploy/` or any `turbo.json` makes it `full`.
- It fails closed. An invalid or missing SHA, a failed or empty diff, or a base commit that does not
  resolve on the runner (`scripts/ci-turbo.mjs`) runs the full graph rather than failing the queue.
- Turbo's `--affected` follows the package graph, so a changed package also runs every package that
  depends on it. What it cannot see is what the fallback list and the nightly cover: files a test
  reads without declaring them (the input audit and the build input probe guard those), the runner's
  own git, Postgres, Docker and SSH versions that the 14 uncached suites exercise, and links that
  are not package dependencies.
- The merge group was the trusted cache writer whichever graph it ran. Since 2026-10-16 the box's
  turbo cache refuses every write: a merge-group job on a box VM that ran a pull request's code
  can't vouch for what it writes. Reads stay on.
- The nightly full run (02:23 UTC, `--force`) is the backstop, with the nightly build input probe.
  `nightly-watch.yml`, on a GitHub-hosted runner so that a box outage can't silence it, keeps one
  open `nightly-failure` issue: it comments on it, or opens it, when a scheduled run of either does
  not succeed, and when either has had no successful scheduled run on main for 30 hours. GitHub
  started the 2026-10-15 nightly five hours late, and the 2026-10-16 probe 4.7 hours late.

Replayed over the 30 commits on `main` before this change, 13 would have run affected and 17 the
full graph: the CI pull requests touched `.github/`, `scripts/` or root docs, and #1006 and #991
touched `.oxlintrc.json` or the lockfile. Package-only changes, the usual feature and fix work, run
affected.

The workflow change does not activate or edit repository policy. The CI orchestrator owns ruleset
`20201151` (`protect-main`) and must apply its merge-queue changes after this pull request lands.
The ruleset currently protects the default branch from deletion and non-fast-forward updates; it
does not yet require a pull request, a status check or the merge queue.

## Activated 2026-10-15

Ruleset `20201151` (`protect-main`) now requires a pull request (squash only, no approvals), the
`checks` status from GitHub Actions (app ID `15368`), and the merge queue: squash, one entry built
and merged at a time, `ALLGREEN`, a 60-minute check timeout. Deletion and non-fast-forward
protections stay. Yiannis decided there is no administrator bypass: `bypass_actors` is empty, so
every route into `main`, the Version Packages pull request included, passes `checks` in the queue.
On the same day he chose the batch size: a merge group takes at least one and at most five queued
pull requests (`min_entries_to_merge` 1, `max_entries_to_merge` 5, no wait), still one group built
at a time. A lone pull request is tested and merged at once; a burst shares one full-graph run per
group of up to five, which the capacity model's background-load section shows is the main lever on
runner demand.

## Orchestrator activation contract

After the bypass decision, update the existing `protect-main` ruleset rather than creating a second
rule for `main`:

- Preserve the deletion and non-fast-forward protections.
- Require a pull request and the merge queue for the default branch.
- Require the `checks` status from GitHub Actions, app ID `15368`.
- Activate with a merge-group size of one, so the first queued commits are each tested by themselves
  before they reach `main`; the batch size is Yiannis's decision (above).
- Set bypass actors to the owner's decision. Do not infer a policy from an empty current list.
- Keep the ruleset active and targeted at `~DEFAULT_BRANCH`.

The `push: main` CI trigger was kept during activation and removed afterwards, once the first
merge-group runs proved their cache writes (below) and the empty bypass list left no untested route
into `main`.

Do not enable only the required status check while leaving a direct path to `main`. Apply the pull
request, queue and required-check rules together. The queue should admit a pull request only after
its ordinary `checks` result succeeds, build a one-pull-request merge group, and require a new
`checks` success on that proposed merge.

## Activation observation

Use a normal pull request after activation. Record the pull request head, the merge-group head and
the workflow run IDs. Observe all of the following before considering activation complete:

1. The pull request's `CI / checks` job succeeds.
2. Enqueueing creates a `merge_group` workflow run against `gh-readonly-queue/main/...`.
3. The merge-group run executes the full static, test, packaging and mobile graph, regardless of the
   pull request's affected-task selection.
4. The merge-group `checks` job succeeds only after every selected lane has succeeded.
5. GitHub moves `main` only after that merge-group result.

Do not bypass, approve or merge a policy-gated run to manufacture this observation.

## Changesets Version pull requests

The Changesets workflow authors the Version Packages pull request as `github-actions[bot]`. GitHub
reports that actor as a contributor, while this repository requires approval for all external
contributors. Its automatic `pull_request` runs therefore conclude `action_required` before they
create a job or check run. The API reports `approval_policy: all_external_contributors` and PR #455
reports `author_association: CONTRIBUTOR`. Run `38607378893` therefore ended with zero jobs and no
ordinary CI check on head `1e867ddd1c5c9a076f8d00caae80bbea5d580ff0`. The separately dispatched
release acceptance run `38607378387` succeeded, so packaged acceptance is not the current blocker.

`version.yml` dispatches nothing. Dispatching ordinary `ci.yml` on the Version branch after every
main merge cost a full box run for a head that was usually replaced, the same reason packaged
release acceptance stopped being dispatched there. The release procedure runs both once, on the head
being released (`next-channel.md`, step 8): `gh workflow run ci.yml --ref changeset-release/main`,
then `release-acceptance.yml`. GitHub resolves the named ref to the Version branch's current head
and attaches the required `checks` result to that SHA. `workflow_dispatch` is not a trusted cache
writer, so the self-hosted jobs use `remote:r` while running the full graph. Without that dispatch
the Version PR carries no `checks` and cannot enter the queue.

## Superseded runs

A pull request and a dispatched branch keep only their newest CI run: `ci.yml`'s concurrency group
is the pull request number, or the ref for a `workflow_dispatch`, and both cancel in progress, so
dispatching CI on the Version branch again replaces the run on the head it superseded. Merge groups
and the nightly run are grouped by run id and are never cancelled.

## Enqueuing a pull request

`gh pr merge <n> --squash` does not enqueue here: it answers that the merge strategy is set by the
queue, then tries auto-merge, which the repository does not allow. Enqueue with the GraphQL
mutation, which also pins the head that was reviewed:

```sh
id=$(gh pr view <n> --json id --jq .id)
gh api graphql -f query='mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) {
    mergeQueueEntry { position state }
  }
}' -f id="$id" -f head=<full head sha>
```

A pull request that is part of a `gh stack` stack can't be enqueued this way: the mutation refuses
it as part of a stack and points to the asynchronous merge REST API. Enqueue it with
`gh stack merge <n> --yes --squash`, or through that REST API. Neither pins the head, so read the
pull request's head SHA immediately before and check it is the head that was reviewed. #1028 (head
`784b7b345`, the bottom of stack #1030) was the first enqueued this way, on 2026-10-16.

## Activation observations

First queued pull request, #1006, head `2cff934f07f0a441a9ce49884cd686034960e84b`, enqueued
2026-10-15 03:29:39Z:

1. Its `CI / checks` succeeded before enqueueing (run `38674526617`).
2. Enqueueing created `merge_group` run `38676569514` on
   `gh-readonly-queue/main/pr-1006-a056818ec712a13ee9147be94fbb0a0399b30d30`, head `c28a2b60f`.
3. Every lane ran: static, both client lanes, test-engines, packaging and mobile-web. No turbo
   command carried `--affected`.
4. The merge-group `checks` job ran 03:42:31–03:42:40Z, after the last lane finished at 03:42:15Z.
5. `main` moved to exactly the merge-group head, `c28a2b60f`, at 03:42:46Z.

The run wrote 38 entries to the trusted cache and had none refused. The `.meta` sidecars, which only
writes touch, date them 03:39:21–03:42:04Z, inside the run. The `push: main` run that followed wrote
nothing: everything it built was already cached. That made it a full duplicate, and it was removed.

The second, #1008, head `4204a509a1419fd4ca79f742f9df031c6d9941fc`, confirmed the same five
observations: its `CI / checks` succeeded (run `38675953988`), `merge_group` run `38677763395` ran
every lane on head `2f44a995a`, its `checks` job ran 04:19:33–04:19:43Z after the last lane, and
`main` moved to `2f44a995a` at 04:20:04Z. The run wrote 12 entries, none refused. The job logs name
every written hash: eleven in the merge group's `static` job and one in its `test-engines` job; the
overlapping `push: main` job for #1006 wrote none of them.

That push run also cost the queue time. With two box runners, the redundant `push: main` run and the
Version branch's dispatched CI held both of them while the merge group's `checks` job, queued at
04:10:00Z, waited 9.5 minutes for a slot. Both were cancelled, and it started at 04:19:33Z, six
seconds after the second runner came free.

The same wait came back from other repositories. Merge group `38746126993` (#1018, `780c56b38`)
passed its last lane at 14:02:05Z, then its 10-second `checks` job waited 13.4 minutes, until
14:15:32Z. The two box runners serve Core and sealantd as well, in queue order, and an aggregate job
is queued only when its last lane finishes. Everything those repositories queued in the meantime
went first: sealantd's main-push CI and the CI of sealantd#168 and Core#368. `changes` and `checks`
now run on GitHub's `ubuntu-24.04-arm` instead, free for this public repository, so neither waits
for a box slot. Since 2026-10-17 the six lanes run on GitHub's `ubuntu-24.04` as well, and on the
box only when CI is dispatched with `runner: box`.
