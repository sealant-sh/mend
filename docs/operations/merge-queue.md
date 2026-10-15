# Merge queue activation

Mend's required CI workflow supports `pull_request`, `merge_group: checks_requested`, manual
dispatch and the nightly schedule. Pull requests use affected Turbo tasks. Merge groups run the full
graph, then the `checks` job rejects any missing, skipped, cancelled or failed required lane. There
is no post-merge `push: main` run: every commit reaches `main` through the queue, and the
merge-group run is the full graph on exactly that commit and the trusted cache writer.

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

`version.yml` dispatches ordinary `ci.yml` on the Version branch. It no longer dispatches packaged
release acceptance: that cost ~14 box runner-minutes per main merge for heads that were usually
replaced, so the release procedure runs it once on the head being released (`next-channel.md`, step
8). GitHub resolves the named ref to the Version branch's current head and attaches the required
`checks` result to that SHA. `workflow_dispatch` is not a trusted cache writer, so the self-hosted
jobs use `remote:r` while running the full graph. This neither approves nor reruns the stopped
automatic run. A subsequent push to `main` lets Changesets update the existing Version PR and
dispatch its CI; this change does not touch #455 itself.

## Superseded runs

A pull request and a dispatched branch keep only their newest CI run: `ci.yml`'s concurrency group
is the pull request number, or the ref for a `workflow_dispatch`, and both cancel in progress. Every
main merge re-dispatches CI on the Version branch, so without this each merge stacked another full
run behind the stale ones. Merge groups and the nightly run are grouped by run id and are never
cancelled.

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
