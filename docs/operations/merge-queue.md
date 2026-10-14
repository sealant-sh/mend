# Merge queue activation

Mend's required CI workflow supports `pull_request`, `merge_group: checks_requested`, manual
dispatch and the nightly schedule. Pull requests use affected Turbo tasks. Merge groups run the full
graph, then the `checks` job rejects any missing, skipped, cancelled or failed required lane. The
queue run replaces the old duplicate full CI run after a commit reached `main`.

The workflow change does not activate or edit repository policy. The CI orchestrator owns ruleset
`20201151` (`protect-main`) and must apply its merge-queue changes after this pull request lands.
The ruleset currently protects the default branch from deletion and non-fast-forward updates; it
does not yet require a pull request, a status check or the merge queue.

## Pending owner decision

Yiannis must decide whether repository administrators may bypass the required `checks` status. The
orchestrator recommends an administrator bypass for emergencies. Do not change the ruleset or its
bypass actors until Yiannis decides. Record his answer in this document when the ruleset changes.

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

`version.yml` already dispatched packaged release acceptance. It now dispatches ordinary `ci.yml` on
the same Version branch too. The default-branch workflow definition runs the full CI graph at that
branch head and attaches the required `checks` result without approving the stopped automatic run. A
subsequent push to `main` lets Changesets update the existing Version PR and issue both dispatches.
