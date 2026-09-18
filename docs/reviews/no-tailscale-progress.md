# Run Mend without Tailscale: progress

Written 2026-09-18, at the end of the unattended run. Nothing was merged, tagged, published or
deployed, and the cluster was not touched. Mend #281 (version packages) and #284 (Sealant 0.33.1)
were left alone.

**No gate is claimed.** This work does not authorize public exposure. G7 needs an independent
reassessment of an exact release. The product now says so itself: `MEND_EXPOSURE=public` refuses to
start while an item it can observe is open, and everything else is reported as `carried`, `declared`
or `open`, never as safe.

## Read these first

1. `docs/adr/0004-access-without-a-private-network.md` at the **top** of the Mend stack (branch
   `public/reporting-and-docs`, PR #291). Later layers amend the ADR where a review changed the
   design, so the copy in #285 alone is not the final one. It has the access model, the gate, 19
   decisions you can overturn one at a time, and 6 open questions that are yours.
2. The "What it does not cover" section of each PR body.

## Every PR

All are ready for review (none is a draft), and each repo's PRs are one registered `gh stack`.

### sealantd (one PR, no stack needed)

| PR                     | Purpose                                                                                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sealant-sh/sealantd#86 | The capture session channel (`HttpRegistrar`) and presigned object URLs are dialled over HTTPS with a verified certificate, or boot refuses. No redirects, no ambient proxy, no way to turn verification off. Plain HTTP only to loopback, or when the launcher states the network is private. |

CI green when last checked.

### Core (sealant-sh/sealant, stack #256, bottom to top)

| PR   | Finding | Purpose                                                                                                                                                    |
| ---- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #251 | CORE-01 | The API refuses to start without service keys (exit 78). The open mode is development only and ignored in production. A credential is required everywhere. |
| #252 | CORE-08 | Registry names are held to the OCI grammar; registry answers are bounded, not redirected, and time out.                                                    |
| #253 | CORE-05 | A credential goes only to the destination it was issued for (GitHub token ↔ repository URL, capture token ↔ endpoint). Adds `source.transport`.            |
| #254 | CORE-03 | An owner is named and checked on every operation; the gateway secret is verified in the gate.                                                              |
| #255 | CORE-04 | Per-credential and per-owner budgets, an inference usage ledger, output bounds.                                                                            |

CI green on all five when last checked.

### Mend (sealant-sh/mend, stack #292, bottom to top)

| PR   | Finding        | Purpose                                                                                                                                       |
| ---- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| #285 | —              | ADR 0004: the access model, trust boundaries, the public exposure gate, what each PR delivers, the decision log, the open questions.          |
| #286 | MEND-05        | Budgets: pre-decode body limits, per-address / per-credential / sign-in windows, session and launch ceilings, bounded connections and frames. |
| #287 | MEND-08        | Upgrade tickets: no long-lived bearer in a WebSocket or embed URL; query strings redacted; `MEND_URL_BEARERS`.                                |
| #288 | MEND-11        | An error boundary that redacts upstream detail, and a browser header policy that still lets the terminal embed load.                          |
| #289 | (closing note) | The event stream lifecycle through the real `/api/events` route.                                                                              |
| #290 | the edge       | `MEND_EXPOSURE`, the gate, explicit cookie attributes, the Helm Ingress (chart 0.3.0), the Docker Caddy overlay.                              |
| #291 | reporting      | `machine.ts`, the shell and `mend doctor` report exposure for tailnet, LAN and public alike; plan §7.5, `AGENTS.md`, self-hosting docs.       |

CI passed on all seven (the `checks` job), including after the `private` default was pushed.

## Gates that were run

- **Mend**, forced, on every one of the seven branches: `pnpm exec turbo typecheck --force` and
  `pnpm exec turbo lint --force` (44 of 44 tasks each), `oxfmt --check`. At the top:
  `turbo test --force` 20 of 20; `packages/db` 70 tests against a throwaway Postgres, none skipped;
  `node --test scripts/*.test.mjs` 141 passing, none skipped (Docker and Helm were present).
- **Core**, forced, on every layer: typecheck, lint and test, 53 of 53. One `@sealant/marketing`
  test failed once on one layer and passed on re-run; that package is untouched.
- **sealantd**: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`. The known local failures (four `sealant-process` `runtime::tests::*`,
  three in-process `tests/e2e.rs`) fail the same way on a clean tree. Two more did too and were
  checked against a clean tree before being set aside: `reap_gate` and three `sealant-pty` tests. CI
  is green.

One thing was observed in a real browser: the terminal's WebAssembly load under the new
Content-Security-Policy, in headless Chromium (refused by the first version of the policy, loaded by
the fixed one). Nothing else in this work was run end to end in a browser or against a live install.

## Review findings applied

Each stack had an independent review (read-only agents) before it was opened. Fixes went into the
layer they belong to.

### sealantd

- Proxy variables in the daemon's environment are not honoured: a loopback plain-HTTP request would
  otherwise have been handed, token and all, to whatever `HTTP_PROXY` named.
- A second CA option for presigned object URLs, so a private object store is not pushed onto the
  plaintext exception.
- IP-literal URLs handled; test servers read the body and close cleanly; doc wording.

### Core

- A regression: `POST /v1/github/webhooks` answered 401 once every route needed a credential. It is
  admitted at the gate again (it authenticates by signature).
- Service keys are read from `?token=` only on the session surface, not everywhere.
- The web app fails fast in production without `CORE_API_SERVICE_KEY`; the dev script keeps the open
  mode only for development.
- **High:** the output budget nulled the scrollback but left its hash, so a truncated record still
  claimed the original content. The hash is nulled too.
- The 429 carries `limit`; rate windows are bounded (timed sweep, 50,000 subjects, an overflow
  subject); spend is recorded in the right order.
- An inference continuation is bound to the owner that opened it.
- A restart revalidates stored `authRef`s (409 for one that names another destination); GitHub
  Enterprise hosts derive from `GITHUB_API_BASE_URL`; the Cloudflare runtime refuses `transport` at
  create; the capture allowlist is validated at start.
- The local Docker image store shares the OCI normalizers; names are validated at create; slug
  helpers; `scoped()` lets the owner win; the routes that are unscoped by design are documented.

### Mend

Budgets (#286):

- **High:** a request whose whole forwarded chain was trusted skipped the address and sign-in
  windows. With the chart's default trusted range (the Pod CIDR), a load balancer or any Pod could
  carry unlimited password guesses. Now counted under the socket's address; only a bare loopback
  socket is exempt, and never for sign-in attempts.
- **High:** the body limit did not reach `/api/auth/*`, because better-auth is handed the raw
  stream. The mount now reads its body under the limit.
- The credential window keyed on the whole `Cookie` header, so padding it started a fresh window.
- The organization session ceiling skipped `starting` sessions and loaded every row per create.
- Path rules did not match the way the router matches (case, doubled slashes, escapes).
- The limiter: a hard cap on subjects, time-based sweeping, IPv6 by /64. A sleeping test now polls.

Upgrade tickets (#287):

- **High:** renewal tickets outlived sign-out, a password change and device revocation, with no end
  date. Tickets are now bound to the credential that minted them, checked in the statement that
  spends them; the renewal ends twelve hours after the app minted the URL.
- A lost exchange reply stranded the embed page: the renewal is shown, not rotated, and a refused
  page asks the phone app for a fresh URL.
- `?session=A&session=B` passed the scope check for one value while the route read the other.
- The `?token=` fallback fired on any 404, so a proxy could push the bearer into URLs. Clients now
  fall back only when `/health` does not report `upgradeTickets`.

Errors and headers (#288):

- **High:** the CSP blocked the terminal's WebAssembly (`data:` fetch). Every packaged or chart
  install would have lost the web terminal and the phone embed. Dev never showed it, because
  `vite dev` bypasses the front. Fixed, observed in Chromium, and pinned by a test that reads how
  the installed library loads.
- The error boundary was not outermost as its comment said, and its answers (and the 403, 413, 429
  and 404) lost the API's security headers. The order now lives in one module with a test.
- `redactDetail` mangled ordinary text (`/application`, commit SHAs) and missed JWTs, `Basic …`,
  `password=…`, `AKIA…` keys and `~/.ssh/…`.
- Rewritten errors dropped cookies; HSTS sent `includeSubDomains` unasked.

Lifecycle (#289): fixed sleeps replaced with waits on what can be observed; two test names claimed
more than they tested.

Edge and reporting (#290, #291):

- Two gate items said `observed` from a hardcoded `true`. They are `carried` now.
- The gate could never read "nothing open". `MEND_EXPOSURE_DECLARED` lets the operator close the two
  items only they can verify. **This one is a product decision made without you** (decision 18).
- `/health` published the open gate ids to anyone. It carries counts now.
- An unversioned build could satisfy the reassessment item with `MEND_EXPOSURE_REASSESSED=dev`.
- "arrived via a trusted proxy" described the web tier, not an edge.
- `mend doctor` nagged about gate items on a loopback install.
- The documented edge recipe did not match what `mend server setup` installs. The docs now say so.
- Chart validation of `exposure.executorNetwork`; the edge subnet left the AWS default VPC range; a
  doc cited a sealantd version that does not exist.

## What each stack does not cover

### sealantd

- Client certificates (mutual TLS) on the channel.
- An additive CA: a configured bundle replaces the public roots, it does not add to them.
- An egress proxy for the daemon: proxy variables are ignored by design.

### Core

- A separate, less privileged database role for the worker.
- Executor egress isolation on the Docker adapter (the chart's NetworkPolicy and the MicroVM
  connector have it; Docker does not filter egress, and the security model now says so).
- A test that the HttpApi layer propagates the request principal end to end.
- CORE-02, -06, -07, -09 were out of scope for this run.

### Mend

- **The packaged edge is not installable by `mend server setup`.** Setup refuses a loopback bind
  with a non-local `--url`, `server.env` is integrity-checked, and `mend server start` / `upgrade`
  run `compose.yaml` alone. The overlay applies to a Compose project run by hand. It was rendered
  and the Caddyfile validated; **no certificate was issued and no browser session was run through
  it.** This is the largest gap between this stack and a packaged public install. A `--edge` flag
  belongs with the next bundle contract revision.
- **`mend server setup` installs cannot set `MEND_EXPOSURE`** (or `MEND_TRUSTED_PROXIES`): the
  bundle's `compose.v2.yaml` does not pass them through and `server.env` is integrity-checked. They
  run on the default, `private`, which is right for a tailnet or LAN install and a slightly loud
  report for a laptop one (`mend doctor` stays quiet there because `APP_URL` is on loopback). Only
  the report is affected; nothing refuses. A `--exposure` flag belongs with the `--edge` flag.
- **Mend does not yet send `source.transport`** (plaintext / CA bundles) or the owner scope to Core:
  that needs a Sealant release carrying Core #253 / #254 and a pin bump. Until then
  `MEND_EXECUTOR_NETWORK=private` is a statement in Mend's report only.
- Request windows are per API process, in memory.
- `ws` buffers a frame up to 100 MiB before Mend sees it (needs a `maxPayload` option upstream in
  Effect's Node server).
- The CSP still allows inline scripts, until the document's two inline scripts carry a nonce.
- `MEND_URL_BEARERS` defaults to `accept` until a phone build that sends tickets is installed.
- `/health` still names the open _multi mode_ gate items (`tenancyGate.failing`), as released.
- `mend server setup` still prints "is reachable at"; left because the packaged acceptance run
  asserts it and a release was in flight.
- `mend doctor` does not yet check the public origin from outside (headers, certificate, port 80),
  which is what would observe `browser-headers` and `edge-tls`.
- Resuming a session and opening a shell take no launch slot; hot-pool and job provisions are not
  counted against a ceiling.
- The Postgres-backed tests skip in CI, which has no Postgres.
- The phone changes (ticket minting, the embed remount) were typechecked and unit tested, not run on
  a device. They need a new EAS build or `eas update`.

## Decisions made without you

All are in the ADR's decision log or open questions, each with the default taken:

1. `private` only reports; it never refuses to start (open question 1).
2. Budget defaults are sized from one person's use (open question 2).
3. A reassessment is recorded by environment variable (open question 3).
4. The renewal ticket is reusable for twelve hours instead of rotating (ADR, "Upgrade tickets").
5. `MEND_EXPOSURE_DECLARED` exists at all (decision 18).
6. `/health` gives counts, not ids (decision 19), and `tenancyGate.failing` was left as released
   (open question 5).
7. (Yours, 2026-09-18 morning) the default is `private`, not `loopback` (decision 20). The doctor
   reads "beyond the machine" from the declaration and from whether `APP_URL` is on loopback.

## Exact next steps

Merge order is **sealantd → Core → Mend**, because each bakes the one below. No PR depends on an
unmerged PR in another repo, so the Mend stack can also merge first without breaking anything; it
just will not enforce the executor-side half until step 4.

1. **Let the in-flight Mend release finish** (#281 / #284) before merging anything in Mend.
2. **sealantd:** review and merge #86. Cut the sealantd train: a minor (0.17.0), since boot now
   refuses a plain-HTTP channel that was not declared private. The changeset names both runtime
   packages.
3. **Core:** review stack #256 and merge it with `gh stack merge --yes` (not `gh pr merge`). Bake
   the new sealantd. Cut the Core train (a minor). Upgrade notes that must go in the release:
   - `SEALANT_SERVICE_KEYS` is now required: the API exits 78 without it.
   - `install.sh` generates `SEALANT_WEB_SERVICE_KEY`; an existing install needs one added.
   - The chart (0.3.0) requires both secret keys.
   - `SEALANT_REQUIRE_OWNER_SCOPE=false` is the migration window for callers that do not yet send an
     owner; turn it on once Mend sends one.
   - Budgets apply to hot pools too: check the defaults against the pool size before rolling.
   - A launcher on a private plain-HTTP channel must send `transport: { plaintext: true }`, or
     workspaces refuse to boot with the new daemon. **Mend does not send it yet (step 4), so do not
     roll the new Core under the cluster's Mend until step 4 has shipped.**
4. **Mend pin bump** (a new PR, not written): bump `@sealant/sdk` and the Sealant image digests,
   send `source.transport` from `MEND_EXECUTOR_NETWORK` and the session channel's TLS settings, and
   send the owner scope. Re-pin digests from source, never from memory.
5. **Mend:** review stack #292 and merge it with `gh stack merge --yes`. Cut the Mend train (a
   minor; migration `0061_upgrade_tickets`; chart 0.3.0). If main has moved, `gh stack sync`, never
   a hand rebase. Migration numbers collide across branches: check `0061` is still free.
6. **Phone:** ship a build with ticket minting and the embed remount (`eas update` for the JS half),
   confirm a terminal and the WebView fallback on the device, then set `MEND_URL_BEARERS=refuse`.
7. **Before anyone declares `public`:** run the edge end to end (a certificate issued, a browser
   session, a terminal and the event stream through it), verify `core-private` and `edge-tls` from
   another network, and commission the independent reassessment G7 asks for, against the exact
   release.

## Housekeeping

- Worktrees were left in place: `~/Developer/OSS/Sealant/Mend-public`, `Core-public`,
  `Sealantd-public`. Do not edit in them while reviewing unless you mean to amend the stacks.
- The throwaway test Postgres container (`mend-public-test-pg`, 127.0.0.1:55434) was removed.
- A pre-existing git stash in one of the repos was left untouched.
