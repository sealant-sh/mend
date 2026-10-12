# Test reliability after the October 2026 audit

The audit at `10e09bdaf` inspected 535 test files, 6,020 static test declarations and 17 shell
scenarios. Parameterized declarations expand into more runtime tests. Across declarations and shell
scenarios, the decisions were 5,734 keep, 267 rewrite, 18 remove, 11 move and 7 requiring a
decision, with 234 findings. A keep decision means an assertion is useful, not that its feature has
complete coverage.

The follow-ups below improve the evidence behind a passing suite and fix reproduced defects. The
audit is complete; implementing its recommendations is not. The original decision counts are an
inventory, not the number of changes still required today or a measure of feature coverage.

## Audit scope

| Section                                     | Files | Static declarations | Shell scenarios |
| ------------------------------------------- | ----: | ------------------: | --------------: |
| Verification, releases and deployment       |    29 |                 432 |              17 |
| Database, storage, auth and jobs            |    69 |                 583 |               0 |
| Domain, contracts, networking and protocols |    46 |                 446 |               0 |
| Session engine and platform adapter         |    57 |               1,352 |               0 |
| API, landing, Slack and inference           |    96 |                 820 |               0 |
| CLI                                         |    67 |               1,074 |               0 |
| Web, desktop, mobile, VS Code and marketing |    98 |                 644 |               0 |
| T3 gateway and contracts                    |    73 |                 669 |               0 |

Eight supplemental executable checks were also inspected outside the 535-file inventory. A
parameterized declaration can execute many cases, so runtime totals must not be compared directly
with these counts. Keeping an assertion means it catches a useful failure; it says nothing about
unexercised paths in the same feature.

## Merged follow-ups

| Pull request                                        | What it establishes                                                                                                                                         | What it does not establish                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [#738](https://github.com/sealant-sh/mend/pull/738) | Required PostgreSQL tests run; stream errors fail; selected API and acceptance assertions require actual outcomes; 18 dead/helper-only declarations removed | Every audit rewrite is complete, or every client/provider journey ran              |
| [#740](https://github.com/sealant-sh/mend/pull/740) | Complete Git-command validation before signer lookup; same-origin login destinations                                                                        | A real authenticated SSH transport or browser sign-in journey                      |
| [#741](https://github.com/sealant-sh/mend/pull/741) | Database correctness stays required; latency has a separate, explicit measurement command with unchanged budgets                                            | Production latency or a passing performance result under every workload            |
| [#742](https://github.com/sealant-sh/mend/pull/742) | CLI rows/anchors preserve real Git hunk contents; gateway refuses binary contents instead of inventing empty text                                           | Interactive terminal/editor rendering or binary preview support                    |
| [#743](https://github.com/sealant-sh/mend/pull/743) | Failed stack resource removal retains ownership and retry records; a subsequent successful retry cleans up                                                  | A live Docker deployment teardown                                                  |
| [#744](https://github.com/sealant-sh/mend/pull/744) | Concurrent production runners share one live job per name/key, including failure and interruption paths                                                     | Protection from old producers or direct external queue writes that bypass the lock |

Each reproduced production defect above has regressions that failed before its fix. Each PR passed
forced repository typechecking and lint before publication and ran relevant local suites. #738 was
merged with a failing database benchmark in CI; that failure led to the explicit performance lane in
#741. The other five follow-ups passed their applicable CI checks before merge. A skipped
release-acceptance workflow is not evidence that packaged or VM acceptance ran. Local checks used
Node 26.1.0; CI used the pinned 26.4.0.

Local results retain their exceptions: #740's full sessions run had one existing five-second timeout
in the conversation-home tests, whose complete file passed separately. Its final CI passed after the
benchmark separation. Explicit optional Docker/provider skips are not executed coverage.

## What changed

- PostgreSQL is required for repository, migration, pg-boss and account-deactivation tests. CI
  starts PostgreSQL 17 and forces the test tasks to run. Connection and migration failures fail the
  run. The former 29 availability probes no longer silently skip their suites.
- API assertions require successful responses, returned identities and the correct forwarded
  account/project/session values. Stream lifecycle tests distinguish events before and after
  teardown. Diff tests check an independent digest and valid versus invalid anchors.
- Gateway subscription assertions propagate errors, defects and completion. Only a timeout on an
  open stream can count as silence. A terminal metadata snapshot establishes subscription readiness
  before the legacy-grant test opens a terminal.
- VS Code acceptance requires a completion record for this run and its requested Remote-SSH mode,
  every expected step, no recorded editor errors and observed session stop outcomes.
- CLI package installation uses an isolated home, npm configuration and cache, including during
  pack/install. Ambient credentials and npm lifecycle settings cannot make it pass accidentally.
- The 18 dead or helper-only declarations were removed, along with the unused argv file writer and
  unused desktop link helpers. Tests for the active pickup writer and terminal link handling remain.
  Migration and supported compatibility tests remain.
- `DB-012`: the session list/view latency benchmark now runs through an explicit performance
  command. Its three PostgreSQL semantic tests remain in the normal correctness suite. The benchmark
  retains 300 bulk sessions and the existing median/p90 budgets, measures three rounds with
  interleaved queries, and reports PostgreSQL, runtime and sample context.
- `AJ-001`: keyed enqueues acquire a PostgreSQL transaction lock, then check and send on the same
  connection at read-committed isolation. Real PostgreSQL regressions force 30 same-key requests
  across independent production runners, including with repeatable-read connection defaults. They
  check the accepted identity and persisted payload, active/retry key retention, terminal release,
  existing standard-queue jobs, rollback, timeout overrides and caller interruption. The guarantee
  requires every producer to use the upgraded implementation; older producers during a rolling
  deployment and direct external queue writes do not share its lock. These tests do not establish
  that the release VM journeys below ran.
- `CLIC004`: CLI review counts valid added/deleted source lines beginning `++` or `--`. Real Git
  fixtures assert complete row numbers, split/unified positions and comment anchors across hunks.
  Whitespace rendering preserves file headers and renders the source lines.
- `T3G-002`: added/deleted binary notices and Git binary patches return the existing typed
  unsupported-content error. Empty text files remain a positive case, including with a `.bin`
  filename. The tests exercise gateway RPC behavior with actual Git-generated patches.
- `VFY-02`: stack teardown checks state-volume removal before deleting its retry records. Fault
  injection covers that volume, an ordinary recorded volume and a recorded container. Each case
  requires the same owner and unchanged records to remain, then a successful complete retry.

## Boundary fixes

- `SC-003`: Git transport now parses the entire command as one supported verb and one literal
  repository argument. Regression cases reject shell suffixes, substitutions, redirections, options
  and extra arguments. Session-planner tests require refusal before signer lookup and operation
  recording, and check the exact valid SSH plan with the owner's identity. A real Git process sends
  quoted paths to an inert SSH recorder, preserving spaces, apostrophes and exclamation marks
  without connecting to a remote. Control characters and double-quoted or otherwise escaped paths
  are explicitly unsupported; Git's single-quoted form works.
- `CLIENT-005`: login and welcome destinations reject ambiguous authority prefixes and use URL
  parsing to check the origin. The accepted original string is preserved so normalizing a path
  cannot turn it into a new authority prefix. Regression examples and generated inputs compare
  navigation against several HTTP/HTTPS origins, including the validation origin.

Both defects were reproduced by failing regressions before their fixes. The planner tests do not
open real SSH connections, and redirect tests do not drive a browser sign-in journey. Those
deployment checks remain separate from the boundary guarantees above.

## Running the checks

Start the development PostgreSQL server from `compose.dev.yaml`, or supply a disposable server whose
account can create databases. Each integration suite creates and removes its own database.

```sh
MEND_TEST_DATABASE_URL=postgres://mend:mend@localhost:5434/mend pnpm exec turbo test --force
pnpm exec turbo typecheck --force
pnpm exec turbo lint --force
pnpm format:check
```

For a deliberately partial local run without PostgreSQL, unset `MEND_TEST_DATABASE_URL` and set
`MEND_SKIP_POSTGRES_TESTS=1`. The output reports skipped tests. This opt-out is rejected in CI and
when a database URL is configured. It is not release evidence. Turbo includes these settings in its
test cache key, and CI forces execution regardless of cache.

Node packaging/verification checks and browser, native client, provider and packaged-server
acceptance are separate commands. `turbo test` does not imply they ran. The existing CI workflow
lists the Node checks. Optional Docker, blob-store and provider prerequisites must be reported
alongside any suite result.

Run the session list/view performance check separately, on an otherwise idle disposable PostgreSQL
server:

```sh
MEND_TEST_DATABASE_URL=postgres://mend:mend@localhost:5434/mend pnpm --filter @mend/db bench:session-live-people
```

This command requires an explicit database URL and rejects the local database opt-out. It warms all
four queries, then records three rounds of 40 samples per query, rotating their order. Every round
must keep both the median and p90 of each enriched read within +5% or +20 ms of its plain read,
whichever is larger. The JSON report includes raw samples, database version, fixture counts and
runtime context. Its 120-second test/setup budget is confined to this command. The default suite has
no performance benchmark to skip, and its semantic checks retain their normal timeouts.

Keep adverse measurements too. In
[#740's run before benchmark separation](https://github.com/sealant-sh/mend/actions/runs/38185126396),
the enriched list read measured 72.6 ms median against 37.1 ms for the plain read, exceeding its
57.1 ms allowance while the combined CI workload ran. The extracted benchmark passed locally on
PostgreSQL 17.11 with its unchanged budgets. These are different environments, not proof that the CI
budget miss was noise or that production meets the budget. Run the explicit benchmark on the
candidate and record the workload and machine alongside the result.

## What the layers establish

| Layer                                              | Useful evidence                                                                     | Remaining limit                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Domain, schemas, protocols and parsers             | Pure decisions, encoding and representative invalid inputs                          | Examples are not exhaustive; several adversarial boundaries remain below                       |
| PostgreSQL repositories, migrations, auth and jobs | Real SQL, constraints, migration application and queue operations                   | Existing fixtures do not model every historical upgrade or concurrent failure                  |
| Session engine, API, gateway, landing and storage  | Service behavior, authorization, record/capture handling, real filesystem/Git cases | Many dependencies are test layers; success does not prove a deployed platform/provider journey |
| Web, desktop, CLI, mobile and VS Code              | Component/model behavior and selected client/server interactions                    | Browser rendering, Electron, native mobile and Remote-SSH need their own acceptance runs       |
| Packaging and verification tooling                 | Artifact shape, subprocess behavior, evidence validation and cleanup fixtures       | Helper tests do not substitute for installing and driving the actual candidate artifacts       |

## Follow-up priorities

The following audit findings remain open in this change. Reproduce them against the latest base
before implementing, and inspect overlapping PRs rather than duplicating their work.

- `APILIFE-01`: interruption after membership removal or a notification defect can prevent later
  local revocations. A complete fix needs atomic local credential/control revocation and durable
  cleanup obligations. Delayed work must target old process/run identities so it cannot stop newly
  admitted work. An uninterruptible wrapper alone does not cover process crashes or failed steps.
- `LAND-02`: pulling an older captured checkpoint can use later history as its parent. The tip tree
  is the requested tree, but a fresh clone of the exported bundle can contain later file contents in
  its history. Preserve exact historical provenance and Git objects, including after capture
  retention. Refuse missing evidence rather than substituting the current head.
- `CLIS-005`: uninstall can discard identity after failed Docker discovery or ownership inspection.
  Preserve unknown observations, revalidate under the store lock and retain the identity for retry.
- `PKG-001` and `PKG-002`: packaged acceptance must check executor mount scope/read-only secrets and
  associate the expected proof marker with the correct file and added diff line.
- `FOUND-12`: provider conformance needs an explicit pinned-provider lane through production
  adapters, with turn, permission, interrupt and resume evidence.
- `T3C-01` and `T3CR-001`: some vendored schema negatives fail on unrelated missing fields. Fix
  upstream/resync or add local coverage. Invalid terminal environment-key handling also needs an
  explicit reject-versus-drop contract.

There are further assertion, race-barrier and service-composition improvements in the full audit.
This list prioritizes reproduced defects and missing release gates; it is not the complete
234-finding backlog. In particular, bounded silence observations still need deterministic processing
barriers where the test claims a delayed operation has finished.

## Before cutting a tag

Use the Proxmox VPS for a resettable release environment. Keep pstack for development and
exploratory reproduction; release decisions should use reproducible commands and recorded outcomes.
The verify toolkit can capture evidence without making an LLM verdict a prerequisite.

1. Build the candidate once. Record the commit, lockfile, CLI tarball hash and image digest.
2. Require the automated suites and relevant client/provider acceptance against that candidate.
3. On a fresh VM snapshot, install the candidate and exercise sign-in, project adoption, a real
   session/turn, stop/resume, captured records, checkpoint/diff review and the intended clients.
4. In a separate lane, install the actual previous supported released artifacts, seed durable
   projects/sessions/checkpoints, then upgrade to the exact candidate artifacts. Check old data,
   authentication, a new session, review and restart recovery.
5. Exercise backup restoration separately, then uninstall and check owned-resource cleanup. Keep
   logs, exact commands, artifact identities and explicit skipped/failed steps.
6. Publish the tested artifacts without rebuilding them.

`REL-01` remains open: the existing same-source version-transition smoke builds both sides from the
candidate revision. It tests upgrade mechanics, but cannot prove compatibility with the previous
released code and schema. The fresh-install and historical-upgrade VM lanes above are recommended
follow-up work, not gates implemented or executed by this PR.
