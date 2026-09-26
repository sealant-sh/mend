# Public exposure findings

> Historical record (2026-09-26): a review from 2026-09-16. Its decisions are in
> `docs/adr/0003-organizations-and-tenancy.md` and
> `docs/adr/0004-access-without-a-private-network.md`, which say what shipped.

Review date: 2026-09-16.

## Decision

**Do not expose the reviewed Mend or Sealant Core releases directly to the public Internet.**

Mend can eventually be the public, authenticated entry point. Core should remain a private backend
called by Mend, even if Mend later becomes Internet-facing. A domain, TLS certificate or reverse
proxy does not supply the missing application authorization.

For the next deployment step, prefer owner-only Tailscale HTTPS access to the Mend web tier. Treat
this as a proposed rollout, not an installed or fully tested configuration. Do not extend access to
less-trusted teammates until the [team authorization blockers](team-support-findings.md) are fixed.

## Scope and confidence

The source review covered Mend API/web 0.27.5 and Mend commit `6a2c50ec4`, plus Core 0.32.0 at
`abe4d6c`. Daemon behavior was checked against `sealantd` 0.15.2. Findings describe those versions,
not an assurance about every subsequent release.

Evidence labels:

- **Observed:** present in inspected source, configuration or recorded deployment evidence.
- **Reproduced:** exercised locally with synthetic data or a focused test.
- **Source-inferred:** follows from control flow, but was not demonstrated end to end.
- **Proposed:** a recommendation, not an implemented control.

The two automated API audit runs produced substantive reports and local test results, then failed
with provider cybersecurity restrictions. Their implementation and independent fix-review phases
were skipped. This is a useful set of findings, **not a completed penetration test or an exhaustive
security assessment**. No cross-user mutation probes were sent to production.

## Current deployment boundary

Recorded AWS deployment evidence shows:

- No public application or database ingress. The Kubernetes API admits the operator's address.
- Mend web and API use private Services. Core is a private `ClusterIP` service.
- The executor session channel uses an internal NLB restricted to the MicroVM connector network. Its
  transport is private-VPC HTTP, not TLS.
- PlanetScale uses PrivateLink and verified TLS. A valid-credential public connection was rejected.
- Raw development-service exposure is disabled.
- S3 holds authoritative captures; Postgres holds pointers. EBS holds the API's store/cache and
  registry data. There is no shared filesystem.

These facts contain several risks below. They do not prove isolation between authenticated Mend
accounts, or between an executor and every internal service. NetworkPolicy effectiveness still needs
runtime tests, including behavior during pod startup and policy convergence.

## Mend findings

### P0: authentication does not establish project authorization

**Observed; open registration reproduced; cross-user consequences source-inferred.**

Email/password registration is open in `packages/auth/src/auth.ts`. Most project, session, worktree,
change and operator routes require a login but operate on globally addressed rows. Session ownership
is recorded, yet it is not consistently enforced on subsequent operations.

The clearest example is `apps/api/src/routes/tty.ts`: it resolves a session and invokes Sealant as
that session's owner without first requiring the caller to own or be authorized for the project. The
service-tunnel route already performs an owner check, demonstrating that the necessary owner
information exists.

A reachable signup page therefore admits users to substantially more authority than a normal account
should receive. Closing signup is an immediate containment measure, but existing accounts still need
a real authorization boundary.

Required fixes:

1. Explicit bootstrap/enrollment policy, with a supported way to close registration.
2. An operator role for machine-wide settings and capabilities.
3. Centralized project authorization before reads, mutations, filesystem access or platform calls.
4. Scope checks for inherited resources, linked projects, streams and terminals, not only project
   detail pages.
5. Two-user regression tests asserting denial **and zero side effects**.

### Other Mend findings

| ID      | Priority                          | Evidence                                          | Finding and required correction                                                                                                                                                                                                                               |
| ------- | --------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MEND-02 | High                              | Observed                                          | Push devices and notification delivery are instance-global. Add device ownership and target notifications to authorized recipients; otherwise project names, summaries and prompt fragments can cross users.                                                  |
| MEND-03 | High                              | Observed; consequences source-inferred            | The SSH-agent bridge has one current signer/socket. Key bridge attachment, status, replacement and Git resolution by authenticated user. Never fall back to another user's signer.                                                                            |
| MEND-04 | High                              | Synthetic signing reproduced                      | Capture quota accounts for declared sizes, but PUT and UploadPart signatures do not bind content length. Require and sign exact sizes, enforce multipart bounds, verify stored sizes and clean mismatches/orphans. Actual S3 enforcement still needs testing. |
| MEND-05 | High                              | Observed; exhaustion consequences source-inferred | No coherent per-user launch, process, body, frame or connection budgets. Add pre-decode limits, bounded concurrent work and streams, plus a single application-owned event fan-out.                                                                           |
| MEND-06 | Medium                            | Observed; consequences source-inferred            | Git inputs can select private or loopback destinations. Define one operator-controlled source policy for projects, references and dotfiles, including credential-origin binding and explicit private-host allowances.                                         |
| MEND-07 | Medium to high, depending on host | Observed                                          | Local Git sources and arbitrary absolute mount directories can cross host filesystem boundaries. Operator-gate or disable them for ordinary accounts; resolve real paths against explicit allowed roots.                                                      |
| MEND-08 | Medium                            | Observed                                          | Long-lived session/device bearers can travel in WebSocket or terminal-embed URLs. Prefer native authorization headers and short-lived, target-scoped browser upgrade tickets. Redact query strings throughout the proxy chain.                                |
| MEND-09 | Medium                            | Observed; deployment-dependent                    | GitHub routes can use the server's ambient `gh` identity. Use a per-user identity or operator-only access, with no ambient fallback for another user.                                                                                                         |
| MEND-10 | Configuration hazard              | Observed                                          | Raw service listeners have no Mend authentication. Preserve disabled exposure defaults and use authenticated tunnels; network reachability must not be described as team authorization.                                                                       |
| MEND-11 | Low                               | Observed                                          | Public error mapping and browser security headers are incomplete. Redact sensitive error details and add a tested header policy that accounts for the supported terminal embed.                                                                               |

The SSE implementation also deserves a focused lifecycle test. Streams share an Effect PostgreSQL
listen connection; this is **not one database connection per browser**. Per-stream teardown may
unsubscribe the shared channel and interrupt other consumers. Cross-user event filtering and
connection budgets remain separate problems.

## Core findings

### Core is a trusted control plane, not an end-user authorization server

**Observed.** A Core service-key holder can delegate operations to a caller-specified `ownerUserId`.
Several reads and mutations also accept absent owner scope. This assumes a trusted server caller,
not an untrusted browser or ordinary team member.

Keep Core, its registry and its execution/control endpoints private. Never distribute its service
key to a browser or use that key as a substitute for Mend project permissions.

| ID      | Priority              | Evidence                                                   | Finding and required correction                                                                                                                                                                                                                 |
| ------- | --------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORE-01 | Critical if reachable | Observed                                                   | Missing service-key configuration intentionally enables open mode. Production startup should fail closed; development exceptions must be explicit. AWS source configures keys, so this is not a claim that the deployed API lacks them.         |
| CORE-02 | High                  | Source inspection and a fake-credential local reproduction | An installation authorization reference is not bound to the selected Git repository URL. Resolve URL and authorization together server-side, restrict token repository permissions, and apply the same checks to dotfiles and redirects.        |
| CORE-03 | High for public use   | Observed                                                   | Optional owner filters and ID-only operations depend on broad outer service trust. A future less-trusted API requires principal-derived owner scope on every operation and separate worker authority.                                           |
| CORE-04 | High for public use   | Observed                                                   | General request, build/run concurrency, output and inference-spend budgets are missing. Add explicit per-principal and per-owner limits, not only per-container resources.                                                                      |
| CORE-05 | Medium                | Source-inferred                                            | Caller-selected Git/capture destinations and broad egress reach internal networks. Bind credentials to approved destinations and enforce executor network isolation. URL validation alone cannot contain arbitrary code running in a workspace. |
| CORE-06 | Medium                | Observed                                                   | The host-Docker adapter exposes some launch credentials through Docker arguments/environment and has weaker resource/isolation controls. It is disabled in AWS; do not treat it as a hostile-tenant boundary elsewhere.                         |
| CORE-07 | Medium                | Observed within review scope                               | Runtime expiry does not establish deletion/retention of durable records, artifacts, connected accounts or backups. Define and test separate data-retention policies.                                                                            |
| CORE-08 | Low to medium         | Synthetic URL handling reproduced                          | Registry repository/reference paths are insufficiently canonicalized. Validate OCI components, reject ambiguous traversal forms and bound response size/time.                                                                                   |
| CORE-09 | Availability          | Local agent behavior reproduced                            | The MicroVM agent reports early daemon exit, but adapter readiness waits toward a generic five-minute timeout. Propagate bounded exit information and terminate failed launches promptly.                                                       |

A separate compatibility defect sends `SEALANT_WORKSPACE_SOURCE=git` from MicroVM and Cloudflare
code while the pinned daemon expects `clone` or an omitted selector. Capture launches avoid this
mismatch. This explains the diagnostic Git-workspace stall, not the user's Codex authentication
failure, and does not itself justify Internet exposure.

## Controls worth preserving

Observed controls include exact browser-origin checks, Better Auth sessions, hashed pairing and
executor-channel tokens, encrypted project and connected-account credentials, constrained capture
object keys, scoped Core session tokens, private deployment defaults and an owner check on Mend's
current service tunnel.

Do not overstate proxy-header handling: web retains/appends an address-forwarding chain. Verify the
complete trusted-proxy configuration and pairing-rate-limit behavior through the actual ingress.
CORS is a browser control, not authorization for native clients.

## Recommended access design

Proposed first rollout:

1. Operator configures a Tailscale Kubernetes Operator/Serve HTTPS endpoint for **Mend web only**.
2. A reviewed tailnet policy grants only the owner access to that endpoint.
3. Laptop and phone connect Tailscale, open the same HTTPS bookmark and authenticate separately to
   Mend. CLI uses the same origin through `MEND_URL`.
4. Web proxies API, SSE and WSS traffic on that origin. No daily kubectl or SSH tunnel is needed.
5. Core, Kubernetes, database, registry, executor agents and raw service ports remain inaccessible
   to ordinary tailnet users. Coding executors do not join the administrative tailnet.

Before rollout, verify enrollment controls, proxy trust, exact origins, TLS/cookies, WSS/SSE
endurance, cellular access, device revocation, forbidden-service reachability and rollback. This
requires an approved deployment window; it has not been installed by this review.

A custom domain is possible, but a CNAME to a `.ts.net` name does not provide a certificate for the
alias. Private custom DNS and custom TLS termination are separate work. Public certificate issuance
can disclose the hostname through certificate transparency.

## Fix and publication status

GitHub status checked on 2026-09-16:

| Change                                                                                  | Repository status     | What it does not prove                                                                    |
| --------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| [#258 AWS capture deployment](https://github.com/sealant-sh/mend/pull/258)              | Merged                | Does not establish public or multi-user safety.                                           |
| [#259 private access plan](https://github.com/sealant-sh/mend/pull/259)                 | Merged, documentation | Does not install Tailscale or approve exposure.                                           |
| [#260 shared browser-origin configuration](https://github.com/sealant-sh/mend/pull/260) | Merged                | Does not close enrollment, authorize projects or prove a deployed image includes the fix. |

PR #260 passes `APP_URL` to both web and API. Its optional `web.allowedOrigins` renders a JSON array
in `MEND_ALLOWED_ORIGINS`. Backend credentials remain API-only. `MEND_APP_URL` is a different
setting for web's internal app-server upstream; it is not the external browser URL.

No live deployment of these follow-up changes was verified while writing this document. The
remaining API findings have no verified remediation from this work. The Codex login problem was
separate: direct provider inference rejected refresh of the stored login, even without a workspace.

## Evidence and acceptance still needed

Recorded local verification:

- Mend audit: 92 passing tests with 9 skipped, plus 14 additional passing tests and synthetic
  signup, signing-header and Git-helper checks. Not a full two-user integration suite.
- Core audit: 29 agent/adapter tests plus synthetic credential-destination, registry-path and
  early-exit checks. No live cloud attack or provider-backed acceptance test.
- Origin fix: 10 chart, 14 network and 12 tRPC tests; both Helm fixtures; independent review; forced
  typecheck and lint with 22 tasks each and no cache hits. tRPC emitted a shutdown warning after
  passing. Formatting, diagnostics and staged secret checks passed.

Before reconsidering public Mend, require:

- Two-user denial tests across direct and indirect resources, including zero effects on refusal.
- Enrollment and operator permissions that do not depend on secrecy of the URL.
- Per-user notifications, signers, provider authority and active-session revocation.
- Actual provider enforcement of upload-byte limits, durable quota accounting and orphan cleanup.
- Request/work/connection limits, executor network tests and credential-destination binding.
- Reviewed TLS/proxy/header behavior, retention/deletion policies and an independent reassessment of
  the exact release to deploy.

Reassess public Core separately only if its trust model changes. Fixing Mend does not turn Core's
administrative service credential into an end-user identity.
