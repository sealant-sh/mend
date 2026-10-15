# Merge queue activation

Mend's required CI workflow supports `pull_request`, `merge_group: checks_requested`, manual
dispatch and the nightly schedule. Pull requests use affected Turbo tasks. Merge groups run the full
graph, then the `checks` job rejects any missing, skipped, cancelled or failed required lane. The
post-merge main run remains while direct merges are possible, so main changes are still tested and
continue refreshing the trusted cache.

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
He has not yet chosen a batch size above one; the capacity model's background-load section shows
batching is the main lever on runner demand.

## Orchestrator activation contract

After the bypass decision, update the existing `protect-main` ruleset rather than creating a second
rule for `main`:

- Preserve the deletion and non-fast-forward protections.
- Require a pull request and the merge queue for the default branch.
- Require the `checks` status from GitHub Actions, app ID `15368`.
- Set the merge queue's minimum and maximum merge-group size to one. A queued commit must be tested
  by itself before it reaches `main`.
- Set bypass actors to the owner's decision. Do not infer a policy from an empty current list.
- Keep the ruleset active and targeted at `~DEFAULT_BRANCH`.

Keep the `push: main` CI trigger during activation. Remove that duplicate full run only in a later
change, after a real merge-group run has proved its cache writes and the decided bypass policy no
longer leaves an untested route into `main`.

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
run behind the stale ones. Pushes to `main`, merge groups and the nightly run are grouped by run id
and are never cancelled.
