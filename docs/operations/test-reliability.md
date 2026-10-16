# Test reliability after the October 2026 audit

The audit at `10e09bdaf` inspected 535 test files, 6,020 static test declarations and 17 shell
scenarios. Parameterized declarations expand into more runtime tests. Across declarations and shell
scenarios, the decisions were 5,734 keep, 267 rewrite, 18 remove, 11 move and 7 requiring a
decision, with 234 findings. A keep decision means an assertion is useful, not that its feature has
complete coverage.

The follow-ups below improve the evidence behind a passing suite and fix reproduced defects. The
audit is complete; implementing its recommendations is not. The original decision counts are an
inventory, not the number of changes still required today or a measure of feature coverage.

The implementation snapshot on 2026-10-12 uses main at `2b94a0af760b49f6c8dfe14ed69140a9df72ec61`.
Of the original 234 findings, 42 are addressed by merged follow-ups, six are partially addressed,
and 186 remain unaddressed. These counts classify each original recommendation, not whole features
or release acceptance. The original audit counts above are unchanged. Three newly confirmed gaps
below are outside the original 234; they do not change that inventory.

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

| Pull request                                        | What it establishes                                                                                                                                         | What it does not establish                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [#738](https://github.com/sealant-sh/mend/pull/738) | Required PostgreSQL tests run; stream errors fail; selected API and acceptance assertions require actual outcomes; 18 dead/helper-only declarations removed | Every audit rewrite is complete, or every client/provider journey ran                          |
| [#740](https://github.com/sealant-sh/mend/pull/740) | Complete Git-command validation before signer lookup; same-origin login destinations                                                                        | A real authenticated SSH transport or browser sign-in journey                                  |
| [#741](https://github.com/sealant-sh/mend/pull/741) | Database correctness stays required; latency has a separate, explicit measurement command with unchanged budgets                                            | Production latency or a passing performance result under every workload                        |
| [#742](https://github.com/sealant-sh/mend/pull/742) | CLI rows/anchors preserve real Git hunk contents; gateway refuses binary contents instead of inventing empty text                                           | Interactive terminal/editor rendering or binary preview support                                |
| [#743](https://github.com/sealant-sh/mend/pull/743) | Failed stack resource removal retains ownership and retry records; a subsequent successful retry cleans up                                                  | A live Docker deployment teardown                                                              |
| [#744](https://github.com/sealant-sh/mend/pull/744) | Concurrent production runners share one live job per name/key, including failure and interruption paths                                                     | Protection from old producers or direct external queue writes that bypass the lock             |
| [#745](https://github.com/sealant-sh/mend/pull/745) | Documents the original audit scope, initial repairs and release strategy                                                                                    | An additional behavior repair or executed release journey                                      |
| [#746](https://github.com/sealant-sh/mend/pull/746) | Final permitted inference tool-round answers are retained; shipped adapter continuations, tools, JSON and audit order are exercised                         | A live provider call, database audit persistence or invalid round-budget validation            |
| [#747](https://github.com/sealant-sh/mend/pull/747) | Failed Docker observations retain uninstall records; retries recheck owner and Docker context under the store lock                                          | A live Docker uninstall or successful optional Docker checks                                   |
| [#748](https://github.com/sealant-sh/mend/pull/748) | Exact capture stamps and base equality; immutable recomputed summary bytes; atomic current-state publication in PostgreSQL                                  | Automatic invalidation after later state changes or orphan-object cleanup                      |
| [#749](https://github.com/sealant-sh/mend/pull/749) | Checked HTTP(S) sources, including IP literals, refuse redirects despite inherited redirect configuration                                                   | Effective URL rewrite clearance or winning DNS-pin configuration                               |
| [#750](https://github.com/sealant-sh/mend/pull/750) | Packaged acceptance refuses unscoped/incompletely observed executors and requires exact added-file proof content                                            | Actual live Docker mount enforcement or a completed packaged/VM acceptance run                 |
| [#751](https://github.com/sealant-sh/mend/pull/751) | Child-frame pixels are masked or screenshots withheld; real Chromium secret/plain and parent-pixel controls                                                 | General main-document closed-shadow text/canvas inspection or live-stack verification          |
| [#752](https://github.com/sealant-sh/mend/pull/752) | Unreadable or malformed teardown ledger evidence refuses before removal and preserves retry records                                                         | A live Docker/Alpine teardown or faithful active network-endpoint modeling                     |
| [#753](https://github.com/sealant-sh/mend/pull/753) | Linked build-key invalidation, exact base/mirror image inventory and stack-label capacity assertions; slot-root cleanup                                     | Runtime pull/preload composition or failing tunnel cleanup                                     |
| [#757](https://github.com/sealant-sh/mend/pull/757) | Actual change-pass services require exact outputs, run identities, evidence/anchor rules, caps and pass isolation                                           | SQL serialization, notifications, live-provider quality or deployed journeys                   |
| [#758](https://github.com/sealant-sh/mend/pull/758) | Captured landing with real Git/blobs/cache requires exact publication, CAS refusal, ephemeral output and cache recovery                                     | Executor flush, SQL concurrency, remote GitHub publication or historical source-pack retention |

Reproduced production defects have regressions that failed before their fixes; assertion-only
follow-ups use strengthened cases and mutation evidence. The behavior follow-ups ran relevant local
suites, and the listed PRs passed forced repository typechecking and lint before publication. #738
was merged with a failing database benchmark in CI; that failure led to the explicit performance
lane in #741. The remaining listed merged follow-ups passed their applicable CI checks before merge.
A skipped release-acceptance workflow is not evidence that packaged or VM acceptance ran. Local
checks used Node 26.1.0; CI used the pinned 26.4.0.

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

- `INF-03`: the actual inference adapter runs against a scripted public Sealant SDK client and a
  recording audit repository. Its 24 adapter tests include 30 generated property cases; the full
  package suite passed 59 tests. They check credentials/configuration, continuation handles, tool
  success/refusal/failure, JSON decoding, exchange/audit order and bounded tool rounds. They do not
  call a live provider or establish database audit persistence. The final permitted tool-round
  answer regression failed before the fix; unknown-tool refusal uses the existing exchange evidence.
- `CLIS-005`: Docker discovery or ownership-inspection failures preserve uninstall records. Retry
  revalidates the owner and Docker context under the store lock. Validation reported 1,422 distinct
  passing CLI tests and four optional skips. Docker responses were scripted; this does not establish
  that a live Docker uninstall ran.

## New merged coverage

- `STORE-008`: checked HTTP(S) sources receive generic and exact-URL redirect refusals, including IP
  literals that need no DNS pin. Real Git requests to a recording proxy distinguish redirected
  destinations from the checked source and exercise inherited configuration precedence. The proxy
  does not forward requests. URL rewrites and DNS-pin overrides remain separate gaps below.
- `PKG-001` and `PKG-002`: packaged acceptance validates every newly recognized executor before
  selection or reclamation. Requested control/secret scope and observed mount names, destinations
  and read-only state must agree; missing or unknown observations refuse. Review proof must be an
  exact added line in the expected new regular text file, with coherent hunk counts. Real Git
  fixtures cover wrong-file, context/deleted/substr, symlink and binary cases. These check
  acceptance decisions, not live Docker enforcement; observed mounts do not expose the requested
  subpath.
- `VFY-01`: Chromium regressions compare synthetic-secret and plain child-frame pixels, including
  parent-change controls. CSS-discoverable frames are masked; uninspectable top-level frame elements
  cause withholding. CI ran all five browser cases. Main-document closed-shadow content remains
  outside this repair.
- `VFY-03`: failed Docker ledger reads refuse before planning removals. The production shell
  distinguishes an absent copy from unreadable, unsearchable, nonregular or symlink paths. Every
  successful output is parsed; empty, whitespace and malformed private copies refuse. Local tests
  run the actual captured shell over ten filesystem cases, preserve exact records and resource
  inventory, then require a successful retry. Docker responses are scripted; no live teardown ran.
- `VFY-05` and `VFY-08`: fixed-tree fixtures require exact image/version changes when linked build
  keys change, retaining pinned-upstream controls. Literal stack-label fixtures require exact live
  and building counts, the Service identity and capacity refusal. `VFY-06` now checks the exact
  required base/mirror image inventory, but runtime pull/preload composition remains open. `VFY-09`
  gains slot-root fixture cleanup; leak/tunnel fixture cleanup remains open. Recorded mutations pass
  the old selected assertions and fail these strengthened assertions.

## Summary observation

`AJ-002` and `AJ-003` require both diff and file reads to carry the requested capture's exact
stamps, including its sequence, kind and partial status. Equality includes the base SHA. The
observer writes separate immutable recomputed bytes before publishing their pointer and observed
state together. A short PostgreSQL transaction locks the worktree, chain and capture, then rechecks
the current base, head, Git verification result and claimed summary row before publishing. Real
PostgreSQL tests wait on competing base, head, verification and summary updates; independent
publishers have one winner.

This guarantee applies at the publication transition. Later base/head/verification changes do not
automatically invalidate an observed summary, and cleanup of unreferenced immutable objects remains
outside this follow-up. Partial captures remain partial; observation does not claim full Git fsck.
Local full suites passed 137 jobs tests, 273 database tests, 1,436 sessions tests and 243 store
tests. Sessions reported four existing optional corpus/S3 skips; store reported 11 optional S3 skips
and one opt-in verification measurement skip. The observer suite passed all 28 cases, and the
capture-store suite passed all 37 cases, including real PostgreSQL waits and repeatable-read
connection defaults. Forced repository build, typechecking and lint passed. #748 passed its
applicable CI checks and merged on 2026-10-12.

## Inference service coverage

`INF-02`, [#757](https://github.com/sealant-sh/mend/pull/757): actual tour, change-reader,
suggestion and shared-tool services run against a scripted provider/public SDK boundary and
recording repositories. Tests require exact run/job identities, stored outputs, evidence/anchor
rules, caps, failure outcomes and pass isolation. The local package suite passed 131 tests,
including four properties with 120 generated scenarios. This proves service-boundary behavior, not
SQL serialization, notifications, paid-provider quality or a deployed journey. Existing #746 adapter
coverage remains separate. Independent review and applicable CI checks passed; #757 merged on
2026-10-12.

## Captured landing coverage

`LAND-01`, [#758](https://github.com/sealant-sh/mend/pull/758): the actual captured adapter and an
owner landing run with real local Git, filesystem blobs and the production runner cache. Tests cover
matched/moving checkpoints, exact trees/parents/author/message, pack/index/inventory/ref ordering,
versioned CAS conflict, ephemeral bundle imports and cache deletion followed by a second
fast-forward push. Independent suites passed 164 landing and 33 related store tests. Repository
concurrency is modeled at the service contract; executor flush, PostgreSQL concurrency and remote
GitHub publication are not exercised. This test-only batch passed independent review, forced local
build/typechecking/lint and applicable CI checks. #758 merged on 2026-10-12.

The landing cache test explicitly supplies older source-pack references alongside derived packs and
refs. Physical retention alone is insufficient: a separate probe that omitted the old source pack
from the newest manifest restored the landing commit object but not its old tree. Derived landing
packs contain commit objects only. #758 does not fix that restore-input limitation, prove survival
after capture retention, or resolve `LAND-02` historical provenance.

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

The capture restorability measurement also has an explicit command:

```sh
MEND_VERIFY_BENCH_REPORT=/tmp/mend-capture-verification.json pnpm --filter @mend/store bench:capture-verification
```

It builds a format-2 section with 126,000 files and 21,211 directories, verifies it twice against
local filesystem blobs, and records both raw durations, counts, revision and machine context. The
report is printed; `MEND_VERIFY_BENCH_REPORT` optionally saves the same JSON to an existing parent
directory. The first verification follows fixture upload, so it does not establish an OS cold-cache
result. This is a measurement with no latency budget, not a release gate or a remote blob-store
result. Its ten-minute hang guard applies only to this command. The ordinary
`capture-verify-shares-thread.test.ts` responsiveness regression remains in the correctness suite.
`MEND_MEASURE_VERIFY` is no longer needed; ordinary tests do not collect this measurement.

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

The following work remains open at this snapshot. Reproduce it against the latest base before
implementing, and inspect overlapping PRs rather than duplicating their work.

- `APILIFE-01`, `ENGC-002` and `APILIFE-03`: interruption after membership removal or a notification
  defect can prevent later local revocations. A complete fix needs atomic local credential/control
  revocation and durable cleanup obligations, plus pending-launch coverage. Delayed work must target
  old process/run identities so it cannot stop newly admitted work. An uninterruptible wrapper alone
  does not cover process crashes or failed steps. The proposed atomic local database revocation fix
  is unpublished and parked outside the current test-only follow-up. Local atomicity, durable
  cleanup and admission fencing remain open and are not counted as addressed here.
- `LAND-02`: pulling an older captured checkpoint can use later history as its parent. The tip tree
  is the requested tree, but a fresh clone of the exported bundle can contain later file contents in
  its history. Preserve exact historical provenance and required Git objects, or refuse missing
  evidence. `APIAUTO-01` and `APIAUTO-02` also need actual held-flush/new-turn and
  listener-coalescing outcomes; #758's adapter tests do not establish those automatic-landing paths.
- `PKG-003`: flush-refusal diagnostics can retain secret-bearing error text. Require secret-free
  public classification, including credential URLs, bearer/API tokens and private paths; keep
  private diagnostics separate. This is a reproduced sanitizer omission, not a claim an actual
  credential was exposed. `PKG-001` and `PKG-002` are addressed by #750.
- `BENCH-1`, `BENCH-2`, `BENCH-3`, `BENCH-4` and `BENCH-12`: supply independent required
  identity/login/profile and delivery/resource evidence; refuse empty statistics selections;
  exercise companion reruns through the public command; bind complete numeric answers to the owned
  conversation. Comparator/helper tests do not establish those public benchmark gates.
- `STORE-002`: require first bytes to survive conditional multipart completion on every backend,
  including concurrent completions. Current Garage expectations permit the overwrite that the
  contract promises to prevent. Optional S3 tests that did not execute are not coverage.
- Admitted API paths, engine process rows and delayed gateway outcomes still need required success,
  exact destinations and completion barriers. SQL state-model and negative fixtures need independent
  constraints/identities, migration-backed auth setup and actual reset-password authentication.
  Notification/review worker composition and ambient inference-model configuration remain open; #757
  does not address `APISVC-02`, `AJ-006` or `INF-04`.
- `FOUND-12`, `SUPCL-003` and `STORE-010`: require pinned-provider conformance through production
  adapters, Remote-SSH runtime person identity and live S3 protocol evidence. Turn, permission,
  interrupt and resume outcomes need their own provider lane.
- `T3C-01` and `T3CR-001`: some vendored schema negatives fail on unrelated missing fields. Fix
  upstream/resync or add local coverage. Invalid terminal environment-key handling also needs an
  explicit reject-versus-drop contract.

Six original findings remain partially addressed: `AJ-005` still needs migration-backed auth
scenarios; `APITEN-01` needs successful admitted rows throughout its access matrix; `T3G-004` needs
a processing barrier for the delayed launch failure; `SUPCL-001` needs command-level rejected-stop
coverage; `VFY-06` needs runtime base/overlay image pull composition; and `VFY-09` needs failing
owned-tunnel cleanup. A touched file or passing suite total does not close these remaining parts.

Three additional confirmed gaps are outside the original 234-finding count:

- Git `insteadOf`/`pushInsteadOf` rewrites can change the effective destination after the supplied
  URL was checked. An independent real-Git recording proxy observed rewritten destination and
  localhost redirect-target requests without forwarding them. Bind clearance and reported source
  identity to the effective URL; #749's supplied-URL redirect repair does not establish this.
- Inherited `GIT_CONFIG_PARAMETERS` can override the counted `http.curloptResolve` DNS pin. Actual
  Git configuration queries reproduce the winning override; no external DNS request was made.
  Enforce the cleared pin at the winning precedence while preserving unrelated CA/proxy settings.
  The earlier CA-setting loss was fixed by #749 and is not an outstanding gap.
- Main-document closed-shadow text and canvas can change vouched screenshot pixels while final scans
  pass. Synthetic-secret/plain Chromium probes produced different pixels with zero masks. Define
  masking or withholding for that opaque content; #751's child-frame repair does not cover it. These
  probes did not use a live Mend stack, desktop CDP or VM.

This priority list is not the complete backlog. The landing restore-input limitation above also
needs a separate follow-up.

## Before cutting a tag

Use the Proxmox VPS for a resettable release environment. Keep pstack for development and
exploratory reproduction; release decisions should use reproducible commands and recorded outcomes.
The verify toolkit can capture evidence without making an LLM verdict a prerequisite.

1. Build the candidate once. Record the commit, lockfile, CLI tarball hash and image digest.
2. Require the automated suites and relevant client/provider acceptance against that candidate.
3. On a fresh VM snapshot, install the candidate and exercise sign-in, project adoption, a real
   session/turn, stop/resume, captured records, checkpoint/diff review and the intended clients.
4. Exercise backup restoration separately, then uninstall and check owned-resource cleanup. Keep
   logs, exact commands, artifact identities and explicit skipped/failed steps.
5. Publish the tested artifacts without rebuilding them.

For 0.36, the owner's 2026-10-10 decision is to run the fresh-install check on stock Ubuntu 24.04
and repeat it on the release candidate. The previous 0.35.1 upgrade VM test was dropped because
there were no external Mend installations to support. The VM and client runs remain distinct from
CI; this audit follow-up has not executed them.

A CI lane for that 0.35.1 gap is implemented, unproven: image.yml's `previous-upgrade` and
`archive-previous-upgrade` jobs ([the upgrade window](next-channel.md#the-upgrade-window); the
scenario is `scripts/check-previous-upgrade.mjs`) have not yet run inside a release workflow. The
scenario itself has run once outside them: run 38946598409 (2026-10-16), a scratch probe on GitHub's
hosted amd64 and arm64 runners, upgraded a seeded 0.35.1 to the published 0.36.0-next.792 and passed
every check. That run did not exercise a live-pinned previous next, a dry-run candidate, the archive
path or the release gate. Each release a candidate may be upgraded from is installed from its actual
artifacts: its npm CLI, its ghcr image by digest, its GitHub release setup assets, pinned in
`release/upgrade-from.json` for a stable release and read live for a next build. A project, a
session with its checkpoints and a Review comment are seeded on it; the candidate's CLI upgrades it
to the exact candidate image; old data, authentication, a new session, a restart and the migration
level are then checked. It counts as coverage once a dry run has passed it end to end on both
architectures.

`REL-01` is partially addressed: the existing packaged smoke already labels its same-source
version-transition evidence in its script header and final output. The CI step now uses the same
wording. Both images come from the candidate revision; a successful smoke run establishes upgrade
mechanics and retention, not compatibility with an earlier server implementation or schema. Its
additional previous-CLI generation check tests configuration compatibility, not an older
server/database. Coverage of an upgrade from an earlier server is the lane above: implemented, not
yet proven by a passing run.

## Provider adapter contracts and compatibility

`packages/agent-protocol/test/subprocess-contracts.test.ts` always runs in the normal test lane. It
drives Mend's Codex and Claude adapters with composed core protocol launch arguments across real
child-process stdin/stdout pipes. Synthetic peers check turn input, approval responses, interrupt
requests and fresh/resumed identity, and the tests release children on success, failure and scoped
cancellation. The tests do not inspect installed provider binaries or read account credentials.

This is adapter contract evidence against synthetic wire exchanges. It does not establish
compatibility with a released provider. The former auto-detected binary smoke tests were retired:
they could skip entirely, bypassed the adapters, and exercised only startup. FOUND-12 remains
partial until a separate mandatory lane pins actual provider versions and drives them with isolated
homes and owned model-server fixtures, without live accounts or paid provider requests. Engine
workspace setup flags and platform pipe behavior also remain covered at their existing seams, not by
this subprocess fixture.

## Worktree route performance

Ordinary API tests exercise real Git file/checkpoint reads, search and path/visibility refusals,
large bounded patches, the 400,000-file listing fixture, and 1,200 renames. They contain no hardware
latency assertions or skipped benchmark rows. The rename integration also checks independently known
rendered paths and the exact omitted tail; the parser's own literal table remains separate. Actual
route deadline tests use Deferred read readiness and TestClock: a blocked listing cuts at 20
seconds, while a listing that consumed 10 seconds leaves only 10 seconds for rendering. They observe
reader interruption and preserve known omitted paths. Their live hang guard only cleans up broken
tests; it is not a production latency budget.

Run the explicit performance lane on an otherwise idle Linux machine, using the same candidate,
Node/Git versions, filesystem and hardware when comparing results:

```sh
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
MEND_WORKTREE_PERF_CONTEXT=local-serial \
MEND_WORKTREE_PERF_REPORT=/tmp/mend-worktree-reads.json \
pnpm --filter @mend/api-server bench:worktree-reads
```

The command creates and removes only its owned temporary Git repositories. It disables global and
system Git configuration and rejects inherited Git location, template, counted and parameter
configuration overrides. It uses explicit empty init templates. No account, database or external
service is required. The measurement uses the actual HTTP Request handler, tenancy fixture and Store
reads; it does not measure TCP, real login/database/platform services or a deployed instance.

After five warmup rounds it records three rounds of 40 samples per query, rotating query order.
Every round retains the existing strict p90 budgets: under 1,000 ms for a forty-file diff and for
one file, and under 2,000 ms for search across 2,000 forty-line files plus the parser file. The
400,000-file fixture retains its single response-time budget of under 25,000 ms. Diff timing
includes JSON body consumption; contents timing includes array-buffer consumption, with checks after
timing; the wide timing ends when the response arrives, as its original budget did. The lane runs
one worker with file parallelism disabled and a 120-second outer test/setup guard.

The JSON report contains raw samples and partial rounds, completeness, budgets, workload counts,
source hashes, commit/dirty state, Node/Git/OS/CPU/memory/load and filesystem context. It is written
before budget assertions, so retain failures alongside passes. A pass applies to that fixture and
recorded environment; neither an idle declaration nor a local pass proves every production workload
meets the budget. Default `pnpm test` does not run this lane.

The manually dispatched **Worktree reads performance** workflow runs this command on the existing
8-vCPU Ubuntu 24.04 runner, with no other package tests or builds in that job, and uploads the JSON
report even when a budget fails. Dispatch it for the candidate branch when release evidence is
needed. A workflow definition or an ordinary CI pass does not mean that dispatch ran.
