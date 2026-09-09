# Mend documentation plan

## Purpose

This plan defines the final documentation set for the Mend repository and the work needed to publish
it without turning planned behavior into current instructions. `MEND-AGENT-WORKBENCH-PLAN.md`
remains canonical for product direction and product decisions. `PLATFORM-FEEDBACK.md` remains
canonical for gaps between Mend and the public `@sealant/sdk` contract.

The public documentation lives in `apps/docs/src/content/docs`. Maintainer records stay in the
repository. Public pages may derive facts from maintainer records, but task instructions must be
verified against implementation and a named Mend build.

Status 2026-09-06: the host-process installer this plan was written against is retired. `install.sh`
now installs only the CLI; the server is created by `mend server setup` from
`apps/cli/src/server-setup.ts` and the release assets in `deploy/docker/`, and operated by the
`mend server` lifecycle commands (`docs/SELF-HOSTING.md`, `apps/cli/SERVER-RUNTIME.md`). Rows below
that still name `install.sh` as the topology or installer source have been updated to that contract;
the page tree and status labels are otherwise unchanged and remain a plan, not a description of the
published site.

## Audiences

1. **Evaluating developer.** This reader needs the current product boundary, supported platforms,
   security assumptions, shipped features, and known limitations before installation.
2. **Daily Mend user.** This reader needs exact procedures for adopting a project, starting or
   resuming a session, reviewing its change, sending a follow-up, declaring a Service, and using
   Mend from another device.
3. **Self-hosting operator.** This reader needs prerequisites, installation, network exposure,
   status, logs, upgrade, backup, restore, repair, and uninstall procedures.
4. **CLI and automation user.** This reader needs commands, flags, exit behavior, configuration,
   completion support, and non-interactive selection rules generated or checked against
   `apps/cli/src/main.ts`.
5. **Contributor.** This reader needs local setup, package boundaries, architecture, database and
   API change procedures, Effect conventions, tests, and release checks without reading the full
   product plan first.
6. **Mend and Sealant integration maintainer.** This reader needs the public SDK boundary, identity
   model, open SDK gaps, adopted platform releases, and the decision records behind Services, Git
   access, and workspace images.
7. **Documentation maintainer.** This reader owns the Starlight information architecture, source
   links, status labels, generated references, and documentation checks in CI.

## Documentation rules

### Behavior status

Every public page that makes a capability claim must carry these frontmatter fields after
`apps/docs/src/content.config.ts` is extended to validate them:

```yaml
owner: sessions
availability: mixed
last_verified: 2026-08-22
verified_against: worktree@bb78943
```

`owner` is one of the roles in the ownership section. `availability` is one of these values:

- `shipped`: the behavior exists in the named released build and its acceptance path has been run.
- `implemented-unreleased`: the behavior exists in the verified commit but no released build has
  been named.
- `mixed`: the page contains separate `## Shipped behavior` and `## Planned behavior` sections.
- `planned`: the page describes direction only and contains no command that a user can run today.
- `historical`: the page is a dated record and is not current guidance.

A roadmap milestone, source comment, mock screen, schema, or merged platform pull request is not
evidence that a Mend user can use a feature. A `shipped` claim needs an implementation path, an
automated or recorded acceptance check, and a released version. Until all three exist, use
`implemented-unreleased` or `planned`.

### Product language

- Use `project`, `session`, `change`, `checkpoint`, `context pack`, `context snapshot`, and
  `handoff` as defined by `MEND-AGENT-WORKBENCH-PLAN.md` sections 5 and 16.
- Define a session as one supervised conversation and worktree with a durable record. Agent, shell,
  and Service processes belong to that session but are not sessions themselves.
- Use Sealant's nouns `workspace`, `run`, and `harness` only at the platform boundary.
- Write "Mend uses inference" or "Mend reads the change." Do not invent a noun for interface-side
  inference.
- Describe statuses as observations. Use wording such as `Completed · observed`, `not executed`, or
  `attribution unknown`. Never write `safe to merge`, `low risk`, or `high confidence`.
- Treat issues and pull requests as optional references. Treat commit and pull request creation as
  optional publication.
- Do not document `/queue`, `/issues/$issueId`, or `/runs/$runId` as supported workflows. Their
  current implementation is unsupported legacy code pending removal.
- Do not use triage, queued, mending, issue intake, kanban, or one-harness-per-issue language in
  current product guidance.

### Claims and evidence

- User instructions take shipped behavior from executable code and tests, not from milestone prose
  in `MEND-AGENT-WORKBENCH-PLAN.md`.
- Planned behavior takes direction from `MEND-AGENT-WORKBENCH-PLAN.md` and must carry a visible
  `Planned` label beside the claim.
- SDK capability status comes from `PLATFORM-FEEDBACK.md`. An entry marked "implemented at the
  source" remains unavailable until a released SDK is installed and Mend has adopted it.
- Security pages state mechanisms and boundaries. For example, say that the CLI token file has mode
  `0600`; do not claim that no other process on the machine can read a session.
- Review pages distinguish direct observation, inference, and unknown attribution. They do not
  promise provenance for every hunk unless the implementation and acceptance test prove it.
- Code samples must name the environment in which they were tested and must use commands supported
  by the verified CLI build.
- Public operational pages link to stable public pages or repository source URLs. They do not depend
  on comments inside `install.sh` for required steps.

### Page scope and prose

- Task pages contain shipped instructions first. Planned work belongs in a labeled final section or
  in `/concepts/roadmap/`.
- Concept pages may describe both states only when `## Shipped behavior` and `## Planned behavior`
  make the boundary visible.
- Generated reference pages say which source file and commit produced them.
- Headings and prose use sentence case. Product copy uses direct sentences and no em dashes.
- Paths, commands, ports, environment variables, status values, and version requirements use
  monospace formatting.
- Public documentation does not link into `docs/archive/` as current guidance.

## Final Starlight sidebar and page tree

The final sidebar is explicit in `apps/docs/astro.config.mjs`. Autogenerated groups are not used
because ordering and status-sensitive page names are part of the public route contract.

### Start here

- `apps/docs/src/content/docs/index.md` at `/` is **[Mixed] What is Mend?**, a factual summary of
  shipped behavior with a short, labeled planned-work section and no unsupported legacy workflow.
- `apps/docs/src/content/docs/getting-started/requirements.md` at `/getting-started/requirements/`
  is **[Shipped] Requirements**, covering Linux, x64 and arm64, Node.js 22 or newer for the CLI, a
  local Docker daemon with API 1.45 or newer and Docker Compose v2, network trust, and disk
  prerequisites verified against `mend server setup`.
- `apps/docs/src/content/docs/getting-started/install.md` at `/getting-started/install/` is
  **[Shipped] Install Mend**, covering CLI installation, `mend server setup`, the network boundary,
  account creation, `mend login`, account connection, `mend doctor`, and the `mend server`
  lifecycle.
- `apps/docs/src/content/docs/getting-started/secure-your-instance.md` at
  `/getting-started/secure-your-instance/` is **[Shipped] Secure your instance**, stating open
  sign-up, trusted-user access, tailnet preference, LAN HTTP risk, bind behavior, bearer-token
  handling, and the current absence of account isolation.
- `apps/docs/src/content/docs/getting-started/adopt-project.md` at `/getting-started/adopt-project/`
  is **[Shipped] Adopt a project**, documenting explicit `mend adopt`, local and remote sources,
  central-store behavior, and Git authentication modes.
- `apps/docs/src/content/docs/getting-started/first-session.md` at `/getting-started/first-session/`
  is **[Shipped] Start and reattach to a session**, documenting launch, detach, `mend attach`,
  browser attachment, stop, settled-session resume, and harness switching.
- `apps/docs/src/content/docs/getting-started/review-change.md` at `/getting-started/review-change/`
  is **[Shipped] Review a change**, documenting the pinned worktree-versus-base diff, comments,
  available read and suggestion passes, tours, and editable follow-up delivery to a settled session.

### Guides

- `apps/docs/src/content/docs/guides/session-lifecycle.md` at `/guides/session-lifecycle/` is
  **[Shipped] Session lifecycle**, explaining session, process, workspace, and run states plus
  detach, stop, resume, and retained-workspace behavior.
- `apps/docs/src/content/docs/guides/services.md` at `/guides/services/` is **[Shipped] Run a
  development Service**, guiding explicit `mend service run`, `add`, logs, restart, stop, and
  private raw-port access without Mend request authentication.
- `apps/docs/src/content/docs/guides/project-setup.md` at `/guides/project-setup/` is **[Mixed]
  Configure project workspaces**, separating current image, variable, secret, reference, mount,
  recipe, dotfile, hot-session, Git-access, and review settings from planned options.
- `apps/docs/src/content/docs/guides/git-access.md` at `/guides/git-access/` is **[Shipped]
  Configure Git access**, covering ambient credentials, a Mend key, the hardware-key bridge, the
  workspace shim, recovery, and the shared bare-repository risk.
- `apps/docs/src/content/docs/guides/remote-access.md` at `/guides/remote-access/` is **[Mixed] Use
  Mend from another device**, covering current browser access, tailnet observation, pairing and
  revocation while labeling the unpublished native app and any unshipped scope controls.

### Operations

- `apps/docs/src/content/docs/operations/status-and-logs.md` at `/operations/status-and-logs/` is
  **[Shipped] Check status and logs**, listing tested commands for the Mend user service, Mend
  Postgres, Sealant API, worker, SSH gateway, and workspaces.
- `apps/docs/src/content/docs/operations/upgrade.md` at `/operations/upgrade/` is **[Planned until
  tested] Upgrade Mend**, publishing no supported upgrade promise until backup, compatibility,
  health, failure, and rollback-limit procedures pass an installer acceptance run.
- `apps/docs/src/content/docs/operations/backup-and-restore.md` at `/operations/backup-and-restore/`
  is **[Planned until tested] Back up and restore**, publishing no complete recovery claim until
  both Postgres stores, the Mend store, configuration, keys, and Sealant records restore in a clean
  environment.
- `apps/docs/src/content/docs/operations/uninstall.md` at `/operations/uninstall/` is **[Planned
  until tested] Uninstall Mend**, separating program removal from data destruction after both paths
  have automated acceptance coverage.
- `apps/docs/src/content/docs/troubleshooting.md` at `/troubleshooting/` is **[Shipped]
  Troubleshooting**, mapping observed installer, Docker, migration, workspace, Service, account,
  Git, and connection failures to verified diagnostics and recovery steps.

### Concepts

- `apps/docs/src/content/docs/concepts/product-model.md` at `/concepts/product-model/` is **[Mixed]
  Product model**, defining shipped projects, sessions, processes, changes, and checkpoints before a
  labeled planned section for context packs, snapshots, handoffs, and publication.
- `apps/docs/src/content/docs/concepts/evidence-and-inference.md` at
  `/concepts/evidence-and-inference/` is **[Mixed] Evidence and inference**, explaining records,
  observed facts, honest attribution, current evidence-linked review output, and the planned full
  "Mend reads the change" contract.
- `apps/docs/src/content/docs/concepts/security.md` at `/concepts/security/` is **[Shipped] Security
  model**, explaining local ownership, trusted users, network boundaries, credential flow,
  workspaces, Services, and current authorization limits.
- `apps/docs/src/content/docs/concepts/roadmap.md` at `/concepts/roadmap/` is **[Planned] Roadmap**,
  summarizing unfinished workflow slices and linking to `MEND-AGENT-WORKBENCH-PLAN.md` for canonical
  detail without presenting milestones as release status.

### Reference

- `apps/docs/src/content/docs/reference/feature-status.md` at `/reference/feature-status/` is
  **[Mixed] Feature status**, a commit or release keyed table using Shipped, Implemented but
  unreleased, Planned, and Unsupported legacy states.
- `apps/docs/src/content/docs/reference/cli.md` at `/reference/cli/` is **[Shipped] CLI reference**,
  generated from or checked against the command registry and help text in `apps/cli/src/main.ts`.
- `apps/docs/src/content/docs/reference/configuration.md` at `/reference/configuration/` is
  **[Shipped] Configuration reference**, listing runtime and test environment variables, files,
  directories, ports, defaults, secret handling, and process scope from one checked registry.
- `apps/docs/src/content/docs/reference/services.md` at `/reference/services/` is **[Shipped]
  Service reference**, defining command behavior, process, forward, target and workspace states,
  endpoint behavior, and supported completion shells.
- `apps/docs/src/content/docs/reference/service-recipes.md` at `/reference/service-recipes/` is
  **[Shipped] `mend.toml` Service recipes**, generated from
  `packages/domain/src/workbench/service-recipe.ts` and parser behavior in
  `packages/sessions/src/recipes.ts`.
- `apps/docs/src/content/docs/reference/git-access.md` at `/reference/git-access/` is **[Shipped]
  Git access reference**, specifying auth modes, key locations, shim behavior, errors, and security
  limitations from current store and bridge code.
- `apps/docs/src/content/docs/reference/security.md` at `/reference/security/` is **[Shipped]
  Security reference**, recording the current authentication, pairing, token, authorization,
  transport, credential, and audit boundaries with source links.
- `apps/docs/src/content/docs/reference/known-limitations.md` at `/reference/known-limitations/` is
  **[Shipped] Known limitations**, deriving user-visible constraints from verified bugs and
  implementation gaps without publishing the internal defect ledger.
- `apps/docs/src/content/docs/reference/product-language.md` at `/reference/product-language/` is
  **[Mixed] Product language**, defining each noun with its current availability and the
  evidence-first voice rules from the canonical plan.
- `apps/docs/src/content/docs/reference/decision-records.md` at `/reference/decision-records/` is
  **[Current repository] Decision record index**, linking maintainers to the canonical plan, active
  decisions, historical records, and platform feedback with status and audience labels.
- `apps/docs/src/content/docs/reference/generated/http-api.md` at `/reference/generated/http-api/`
  is **[Generated current repository] HTTP API**, listing `MendApi` endpoints plus the manually
  mounted auth, SSE, TTY, and key-bridge routes.
- `apps/docs/src/content/docs/reference/generated/domain.md` at `/reference/generated/domain/` is
  **[Generated current repository] Domain schemas**, listing workbench schemas and statuses from
  `packages/domain/src/workbench` while labeling retiring types as unsupported.
- `apps/docs/src/content/docs/reference/generated/database.md` at `/reference/generated/database/`
  is **[Generated current repository] Database**, cataloging current tables, relations, indexes,
  foreign keys, and ordered migrations while labeling retiring tables.
- `apps/docs/src/content/docs/reference/generated/packages.md` at `/reference/generated/packages/`
  is **[Generated current repository] Packages and scripts**, listing workspace ownership, public
  entry points, dependency edges, scripts, and local ports from package manifests and `turbo.json`.

### Contributing

- `apps/docs/src/content/docs/contributing/overview.md` at `/contributing/overview/` is **[Current
  repository] Contributor overview**, mapping every app, package, tooling area, composition root,
  and current source of truth.
- `apps/docs/src/content/docs/contributing/local-setup/prerequisites.md` at
  `/contributing/local-setup/prerequisites/` is **[Current repository] Development prerequisites**,
  deriving Node from `.node-version`, pnpm from `package.json`, and the required local tools from
  the actual scripts.
- `apps/docs/src/content/docs/contributing/local-setup/sealant-and-postgres.md` at
  `/contributing/local-setup/sealant-and-postgres/` is **[Current repository] Local Sealant and
  Postgres**, documenting the tested development topology and the difference between ports 3101,
  3105, 5434, and production-shaped services.
- `apps/docs/src/content/docs/contributing/local-setup/environment-and-ports.md` at
  `/contributing/local-setup/environment-and-ports/` is **[Current repository] Development
  environment and ports**, using the same checked configuration registry as the public reference.
- `apps/docs/src/content/docs/contributing/local-setup/apps.md` at `/contributing/local-setup/apps/`
  is **[Current repository] Run each app**, giving verified commands for `apps/web`, `apps/cli`,
  `apps/desktop`, `apps/mobile`, `apps/vscode`, `apps/docs`, and `apps/marketing`.
- `apps/docs/src/content/docs/contributing/workflows/product-loop.md` at
  `/contributing/workflows/product-loop/` is **[Current repository] Exercise the product loop**,
  replacing the retired local workflow with adopt, launch, attach, review, and follow-up steps on a
  real repository.
- `apps/docs/src/content/docs/contributing/workflows/http-endpoint.md` at
  `/contributing/workflows/http-endpoint/` is **[Current repository] Add or change an HTTP
  endpoint**, covering contract-first changes, server implementation, client copies, transport
  manifests, tests, and generated reference updates.
- `apps/docs/src/content/docs/contributing/workflows/domain-and-database.md` at
  `/contributing/workflows/domain-and-database/` is **[Current repository] Change the domain model
  or database**, covering workbench imports, schemas, migrations, repositories, relation checks, and
  required Postgres tests.
- `apps/docs/src/content/docs/contributing/workflows/effect-service.md` at
  `/contributing/workflows/effect-service/` is **[Current repository] Add an Effect service**,
  requiring the relevant `effect-solutions` guides, contract-first service definitions, separate
  typed layers, and boundary composition.
- `apps/docs/src/content/docs/contributing/workflows/client-surface.md` at
  `/contributing/workflows/client-surface/` is **[Current repository] Add a client surface**,
  covering web, desktop, mobile, CLI, and VS Code ownership plus contract and behavior parity.
- `apps/docs/src/content/docs/contributing/testing.md` at `/contributing/testing/` is **[Current
  repository] Tests and required checks**, explaining build-before-typecheck, `tsgo`, lint, format,
  test suites, Postgres requirements, and forced pre-publication checks.
- `apps/docs/src/content/docs/contributing/dependencies.md` at `/contributing/dependencies/` is
  **[Current repository] Packages and dependencies**, recording `workspace:*`, `catalog:`, lockfile,
  package boundary, and public barrel rules.
- `apps/docs/src/content/docs/contributing/release-and-installer.md` at
  `/contributing/release-and-installer/` is **[Current repository] Release and installer workflow**,
  tying the Git tag, npm CLI version, served installer, Mend server, Sealant minimum, and release
  smoke tests into one release set.
- `apps/docs/src/content/docs/contributing/troubleshooting.md` at `/contributing/troubleshooting/`
  is **[Current repository] Contributor troubleshooting**, covering generated route trees, skipped
  Postgres tests, Effect runtime mismatches, local Sealant failures, and common workspace setup
  errors.

### Architecture

- `apps/docs/src/content/docs/architecture/system-overview.md` at `/architecture/system-overview/`
  is **[Current repository] System overview**, describing host processes, containers, deployables,
  data stores, entry points, and development versus installer topology.
- `apps/docs/src/content/docs/architecture/package-boundaries.md` at
  `/architecture/package-boundaries/` is **[Current repository] Package boundaries**, defining each
  app and package owner, public entry point, allowed dependency direction, and composition root.
- `apps/docs/src/content/docs/architecture/domain-and-data-ownership.md` at
  `/architecture/domain-and-data-ownership/` is **[Mixed] Domain and data ownership**, separating
  Mend product state, Git truth, Sealant records, current workbench schemas, and planned context
  records.
- `apps/docs/src/content/docs/architecture/session-lifecycle.md` at
  `/architecture/session-lifecycle/` is **[Current repository] Session and process lifecycle**,
  tracing session creation, process attempts, workspaces, records, checkpoints, detach, settle,
  retain, and resume.
- `apps/docs/src/content/docs/architecture/store-git-and-review.md` at
  `/architecture/store-git-and-review/` is **[Mixed] Store, Git, checkpoints, and Review**,
  documenting the central bare repository, worktrees, auth shim, checkpoint slices, current diff
  pipeline, and planned comparison modes.
- `apps/docs/src/content/docs/architecture/api-transports-and-auth.md` at
  `/architecture/api-transports-and-auth/` is **[Current repository] API transports and
  authentication**, mapping HTTP, Better Auth, SSE, TTY WebSocket, key bridge, client copies, bearer
  handling, and authorization gaps.
- `apps/docs/src/content/docs/architecture/sealant-boundary.md` at `/architecture/sealant-boundary/`
  is **[Mixed] Sealant SDK and identity boundary**, documenting service principals, per-user
  clients, public SDK use, current releases, and links to canonical gaps in `PLATFORM-FEEDBACK.md`.
- `apps/docs/src/content/docs/architecture/services-and-forwarding.md` at
  `/architecture/services-and-forwarding/` is **[Current repository] Services and private
  forwarding**, documenting Service identity, attempts, forwards, observations, leases, recipes, and
  the raw network boundary.
- `apps/docs/src/content/docs/architecture/inference-and-jobs.md` at
  `/architecture/inference-and-jobs/` is **[Mixed] Inference and background jobs**, mapping provider
  selection, connected accounts, inference audits, workers, evidence requirements, and planned
  review capabilities.
- `apps/docs/src/content/docs/architecture/security-boundaries.md` at
  `/architecture/security-boundaries/` is **[Current repository] Security and trust boundaries**,
  mapping users, devices, tokens, credentials, host processes, workspaces, store mounts, Services,
  private networks, and known missing controls.

## Source-of-truth matrix

| Subject                                      | Canonical source                                                                                                                                                              | Public or contributor derivative                                                                            | Status rule                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Product direction and decisions              | `MEND-AGENT-WORKBENCH-PLAN.md`                                                                                                                                                | `/concepts/roadmap/`, `/concepts/product-model/`, `/reference/product-language/`                            | Direction is planned until implementation and release evidence exists.                                                           |
| SDK gaps and adoption history                | `PLATFORM-FEEDBACK.md`                                                                                                                                                        | `/reference/known-limitations/`, `/architecture/sealant-boundary/`                                          | "Implemented at the source" is not shipped in Mend.                                                                              |
| Visual and copy language                     | `DESIGN.md` and `packages/ui/src/styles/globals.css`                                                                                                                          | `apps/docs/src/styles/custom.css` and all UI guidance                                                       | `DESIGN.md` governs design; the token source governs exact values.                                                               |
| Feature availability                         | Released implementation, acceptance tests, and `/reference/feature-status/` at a named tag or commit                                                                          | Product, guide, and operations pages                                                                        | The feature-status page is the public index, but code and tests win when it drifts.                                              |
| Installer behavior                           | `install.sh` (CLI only), `apps/cli/src/server-setup.ts`, `apps/cli/src/help.ts`, and `deploy/docker/*`                                                                        | `/getting-started/requirements/`, `/getting-started/install/`, `/operations/*`, `/reference/configuration/` | Every command, path, port, version, and default must match the packaged-server acceptance (`scripts/check-packaged-server.mjs`). |
| Served installer artifact                    | `install.sh`; `apps/marketing/public/install.sh` is derived                                                                                                                   | `https://mend.sealant.dev/install.sh`                                                                       | The existing byte-identity test remains mandatory.                                                                               |
| Development topology                         | `apps/web/scripts/dev.mjs`, `compose.dev.yaml`, `.env.example`, and workspace scripts                                                                                         | `/contributing/local-setup/*`                                                                               | Document the command that CI and contributors run, not an inferred topology.                                                     |
| Production topology                          | `deploy/docker/compose.v2.yaml` and `deploy/docker/setup-contract.v2.json`                                                                                                    | `/operations/*` and `/architecture/system-overview/`                                                        | The retired root `compose.yaml` and host-process installer are not supported topologies.                                         |
| CLI commands and completion                  | Command parsers, registry, and help in `apps/cli/src/main.ts`                                                                                                                 | `/reference/cli/` and command samples                                                                       | Generate or snapshot the reference; do not claim fish completion while only zsh and bash exist.                                  |
| HTTP API                                     | `packages/api/src/contract.ts`                                                                                                                                                | `/reference/generated/http-api/`                                                                            | Generate the contract section.                                                                                                   |
| SSE, TTY, key bridge, and Better Auth routes | `packages/api/src/events.ts`, `packages/api/src/tty.ts`, `packages/api/src/keys-bridge.ts`, and `apps/web/src/entry/main.ts`                                                  | Manual-route manifest within `/reference/generated/http-api/`                                               | CI checks the manifest because these routes are outside `MendApi`.                                                               |
| Workbench domain                             | `packages/domain/src/workbench/index.ts` and its modules                                                                                                                      | `/concepts/product-model/`, `/reference/generated/domain/`, `/architecture/domain-and-data-ownership/`      | New code and current docs use `@mend/domain/workbench`; retiring root exports are unsupported.                                   |
| Database schema and migrations               | `packages/db/src/schema/workbench.ts`, `packages/db/src/schema/relations.ts`, `packages/db/src/migrations.ts`, and `packages/db/src/repos`                                    | `/reference/generated/database/` and contributor database workflow                                          | A real Postgres migration test must back current schema claims.                                                                  |
| Session and process lifecycle                | `packages/domain/src/workbench/session*.ts`, `packages/domain/src/workbench/session-process.ts`, `packages/domain/src/workbench/session-fold.ts`, and `packages/sessions/src` | Session guide and architecture page                                                                         | Status wording must match the implemented fold and current client behavior.                                                      |
| Review and checkpoints                       | Workbench review schemas, `packages/api/src/review-diff.ts`, store Git code, and review route tests                                                                           | Review guide, evidence concept, and store and review architecture page                                      | Document only comparison modes and evidence links exercised in the verified build.                                               |
| Services                                     | Service and recipe schemas in `packages/domain/src/workbench`, `packages/sessions/src/service-host.ts`, `packages/sessions/src/recipes.ts`, CLI handlers, and tests           | Services guide and references                                                                               | `docs/SESSION-SERVICES.md` remains a decision record, not proof that every slice shipped.                                        |
| Git access                                   | `packages/store/src/git.ts`, `packages/store/src/git-auth.ts`, key-bridge implementation, CLI behavior, and tests                                                             | Git guide and reference                                                                                     | `docs/GIT-ACCESS.md` records decisions and risks; code and tests establish current behavior.                                     |
| Authentication and pairing                   | `packages/auth/src/auth.ts`, `packages/api/src/devices.ts`, `packages/db/src/repos/devices.ts`, and `apps/cli/src/pair.ts`                                                    | Secure-instance, remote-access, and security pages                                                          | State current trusted-user and unscoped-device boundaries until authorization tests prove otherwise.                             |
| Per-user Sealant identity                    | `packages/sealant/src/principal.ts`, `packages/sealant/src/identity.ts`, account code, migrations, and current SDK behavior                                                   | Security and Sealant-boundary pages                                                                         | `docs/SEALANT-IDENTITY.md` records the decision; the installed SDK release determines availability.                              |
| Workspace images                             | Current project setup API and UI, Sealant SDK image options, and acceptance tests                                                                                             | Project setup guide                                                                                         | `docs/WORKSPACE-IMAGES.md` is direction; custom images remain planned until selectable and tested.                               |
| Inference and jobs                           | `packages/inference/src`, `packages/jobs/src`, and worker wiring in `apps/web/src/entry/main.ts`                                                                              | Evidence concept and inference architecture page                                                            | Generated claims need record links or runnable checks, and provider support needs released SDK evidence.                         |
| Runtime configuration                        | Typed registry to be added, with current reads in store, sessions, auth, inference, database tests, and `deploy/docker/*` as migration inputs                                 | `/reference/configuration/` and contributor environment page                                                | CI rejects a key present in code but absent from the registry and reference.                                                     |
| Known defects                                | Reproducible tests and `docs/BUGS.md` until an issue-tracker migration is complete                                                                                            | `/reference/known-limitations/` and `/troubleshooting/`                                                     | Only user-visible, reproduced effects are published.                                                                             |
| Documentation structure                      | `docs/DOCUMENTATION-PLAN.md`                                                                                                                                                  | `apps/docs/astro.config.mjs` and the Starlight source tree                                                  | Archive this plan only after the final tree, ownership, and CI checks exist.                                                     |

## Migration table

### Repository Markdown

| Current path                                                                                                  | Audience                                | Action                                                                                                                                                  | Destination or derivative                                                                                                                                  | Acceptance check                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                                                                                   | Coding agents and maintainers           | Keep at the repository root and do not publish as user documentation.                                                                                   | Link contributor procedures to Starlight, but retain agent-only rules here.                                                                                | It points to `MEND-AGENT-WORKBENCH-PLAN.md` and `PLATFORM-FEEDBACK.md`, contains no supported legacy workflow, and its SDK examples match the installed public SDK. |
| `CLAUDE.md`                                                                                                   | Claude Code                             | Keep at the repository root as a short pointer.                                                                                                         | `AGENTS.md` remains the detailed instruction source.                                                                                                       | The pointer resolves and does not duplicate rules that can drift.                                                                                                   |
| `DESIGN.md`                                                                                                   | UI and documentation maintainers        | Keep at the repository root as design authority.                                                                                                        | `apps/docs/src/styles/custom.css` derives the Starlight presentation from it.                                                                              | Replace the remaining legacy status phrase when the file is next edited, and verify docs colors and type against the named token sources.                           |
| `DEVELOPMENT.md`                                                                                              | Contributors                            | Rewrite as a short local setup entry point and remove product workflow and production operation detail.                                                 | `/contributing/overview/`, `/contributing/local-setup/*`, `/contributing/testing/`, and `/contributing/release-and-installer/` hold the detailed material. | Node matches `.node-version`, the local loop uses adopt, session, review, and follow-up, and every command runs in a clean checkout.                                |
| `MEND-AGENT-WORKBENCH-PLAN.md`                                                                                | Product and engineering maintainers     | Keep at the repository root and keep canonical for product direction and decisions.                                                                     | Public concept and roadmap pages summarize it with status labels.                                                                                          | Public pages never use its milestone text as shipped evidence.                                                                                                      |
| `PLATFORM-FEEDBACK.md`                                                                                        | Mend and Sealant maintainers            | Keep at the repository root and keep canonical for public SDK gaps.                                                                                     | `/architecture/sealant-boundary/` and user-visible entries in `/reference/known-limitations/` derive from it.                                              | Each entry has an explicit open, implemented-at-source, released, adopted, or obsolete state, and only adopted releases appear as shipped.                          |
| `README.md`                                                                                                   | Repository visitors                     | Keep a short product summary, honest status table, supported install summary, repository map, and documentation link after a public docs origin exists. | `/`, `/reference/feature-status/`, and `/getting-started/install/` own detailed claims.                                                                    | It does not promise per-hunk provenance, published native mobile, automatic adoption, or visible planned labels that do not exist.                                  |
| `docs/BUGS.md`                                                                                                | Maintainers                             | Keep as the internal reproducible defect ledger until an issue-tracker migration is complete, then retain a generated index or archive.                 | `/reference/known-limitations/` and `/troubleshooting/` receive verified user effects and workarounds.                                                     | Every active item has reproduction, affected version or commit, owner, and a user-doc decision.                                                                     |
| `docs/DOCUMENTATION-PLAN.md`                                                                                  | Documentation and subsystem maintainers | Keep as the implementation plan while P0 through P2 remain open.                                                                                        | Archive to `docs/archive/DOCUMENTATION-PLAN.md` after the final sidebar, migration, ownership, and CI gates ship.                                          | No open backlog item depends on this file as the only source of an operating procedure.                                                                             |
| `docs/GIT-ACCESS.md`                                                                                          | Store and security maintainers          | Move the decision and threat model to `docs/decisions/GIT-ACCESS.md`; remove current user instructions from the decision record.                        | `/guides/git-access/` and `/reference/git-access/` receive verified setup, behavior, errors, and recovery.                                                 | Public steps pass ambient, Mend-key, bridge, shim push, disconnected signer, and shared-store-risk checks.                                                          |
| `docs/M0-INVENTORY.md`                                                                                        | Maintainers and historians              | Move unchanged to `docs/archive/M0-INVENTORY.md` with its 2026-07-25 snapshot date.                                                                     | `/contributing/overview/` and architecture pages replace it as current guidance.                                                                           | No active page or source comment cites it for current architecture.                                                                                                 |
| `docs/SEALANT-IDENTITY.md`                                                                                    | Architecture and security maintainers   | Move the decision to `docs/decisions/SEALANT-IDENTITY.md` and preserve implementation and release qualifiers.                                           | `/reference/security/` and `/architecture/sealant-boundary/` publish the verified account and credential model.                                            | Current SDK release, per-user mapping, account connection, and deletion limitations are each labeled with evidence.                                                 |
| `docs/SESSION-SERVICES.md`                                                                                    | Sessions maintainers                    | Move architecture, decisions, data model, delivery slices, and open questions to `docs/decisions/SESSION-SERVICES.md`.                                  | `/guides/services/`, `/reference/services/`, and `/reference/service-recipes/` receive shipped user behavior.                                              | Public docs match implemented commands, zsh and bash completion support, explicit declaration, raw endpoints, and current state vocabulary.                         |
| `docs/WORKSPACE-IMAGES.md`                                                                                    | Workspace and Sealant maintainers       | Move the platform decision and remaining sequence to `docs/decisions/WORKSPACE-IMAGES.md`.                                                              | `/guides/project-setup/` publishes only settings available in the verified Mend build.                                                                     | Current image choices and custom-image plans appear in separate shipped and planned sections.                                                                       |
| `docs/archive/*.md` as one group, currently `ARCHITECTURE.md`, `MEND-PLAN.md`, `PRODUCT.md`, and `ROADMAP.md` | Historians and maintainers              | Keep under `docs/archive/` with historical banners and no public sidebar entries.                                                                       | `/reference/decision-records/` lists the group as superseded history.                                                                                      | Link checks allow inbound history links only from the decision index or other historical files, never from task pages.                                              |

### Current Starlight pages

| Current path                                                  | Action                                                                                   | Acceptance check                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/docs/src/content/docs/index.md`                         | Rewrite around the verified feature-status table and retain the existing route.          | Every capability is labeled Shipped, Implemented but unreleased, or Planned and links to a task or status page.                                        |
| `apps/docs/src/content/docs/getting-started/install.md`       | Expand into the tested install procedure and retain the existing route.                  | It includes `git`, running Docker access, Compose 2.23.1 or newer, x64 and arm64, security boundary, health checks, and a non-piped inspection option. |
| `apps/docs/src/content/docs/getting-started/first-session.md` | Correct explicit adoption and session cardinality, then expand attach, stop, and resume. | A clean machine follows `mend adopt` before launch and completes the documented session path.                                                          |
| `apps/docs/src/content/docs/concepts/product-model.md`        | Split shipped and planned nouns while retaining the existing route.                      | Context packs, snapshots, handoffs, issue and pull request references, and publication are visibly Planned until their evidence gates pass.            |
| `apps/docs/src/content/docs/reference/product-language.md`    | Add availability to each noun and retain the existing route.                             | Current nouns match `MEND-AGENT-WORKBENCH-PLAN.md`, process is not equated with session, and unsupported legacy terms appear only in a prohibition.    |

## Backlog

### P0: make the current docs safe to use

| Work                                                                                     | Exact paths                                                                                                                                                                          | Acceptance checks                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Establish a versioned feature baseline from the three audits and current implementation. | Add `apps/docs/src/content/docs/reference/feature-status.md`; update `apps/docs/src/content/docs/index.md`.                                                                          | The table names a tag or commit, distinguishes Shipped, Implemented but unreleased, Planned, and Unsupported legacy, and every public capability claim links to one row.                                               |
| Repair the first-use path.                                                               | Update `apps/docs/src/content/docs/getting-started/install.md` and `apps/docs/src/content/docs/getting-started/first-session.md`; add `requirements.md` and `adopt-project.md`.      | A clean Linux x64 or arm64 environment passes preflight, installs, creates an account, logs in, connects one provider, adopts a real repository, and launches a session without undocumented steps.                    |
| Publish the real security boundary before promoting the docs site.                       | Add `apps/docs/src/content/docs/getting-started/secure-your-instance.md`, `apps/docs/src/content/docs/concepts/security.md`, and `apps/docs/src/content/docs/reference/security.md`. | The pages state open sign-up, trusted users, shared project and session visibility, unscoped device tokens, LAN HTTP risk, WebSocket query token risk, missing general control audit, and shared bare-repository risk. |
| Document the shipped review loop without future promises.                                | Add `apps/docs/src/content/docs/getting-started/review-change.md`; revise `product-model.md` and `product-language.md`.                                                              | The walkthrough uses the pinned unified diff and current comment delivery, does not promise live-TUI delivery or every-hunk provenance, and labels context and publication as Planned.                                 |
| Correct current repository entry points.                                                 | Plan follow-up edits to `README.md`, `DEVELOPMENT.md`, `apps/mobile/README.md`, and `docs/SESSION-SERVICES.md` or its replacement.                                                   | README claims match the feature baseline, development uses the current product loop and Node 26.4.0, mobile docs reference live data sources, and completion support says zsh and bash only.                           |
| Create the operations safety minimum.                                                    | Add `operations/status-and-logs.md` and `troubleshooting.md`; create planned placeholders for upgrade, backup and restore, and uninstall.                                            | Status and log commands run against an installer-created machine, while untested destructive or recovery procedures carry Planned labels and cannot be mistaken for support promises.                                  |
| Configure a real docs origin and deployment.                                             | Update `apps/docs/astro.config.mjs`; add a docs deployment workflow under `.github/workflows/`; update marketing and README links only afterward.                                    | Preview and production builds have a configured `site` and `base`, every route receives a post-deploy probe, and no repository page links to an invented hostname.                                                     |
| Add the first docs gate.                                                                 | Add a root `docs:check` script, supporting scripts under `apps/docs/scripts/`, and CI steps in `.github/workflows/ci.yml`.                                                           | CI runs Starlight typecheck and build, internal link and anchor checks, source-path checks, frontmatter validation, and a terminology/status scan with narrow historical allowlists.                                   |

### P1: make the docs complete for users, operators, and contributors

| Work                                               | Exact paths                                                                                                                                            | Acceptance checks                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete daily-use guides.                         | Add `guides/session-lifecycle.md`, `guides/services.md`, `guides/project-setup.md`, `guides/git-access.md`, and `guides/remote-access.md`.             | Each guide completes its task against the verified build, includes failure behavior, and separates planned options from shipped controls.                                                            |
| Generate the CLI and Service references.           | Add `reference/cli.md`, `reference/services.md`, `reference/service-recipes.md`, and generation code under `apps/docs/scripts/`.                       | Regeneration is deterministic, CI fails on a diff, all commands and flags match `apps/cli/src/main.ts`, and recipe fields match the schema and parser.                                               |
| Build one configuration registry.                  | Add a typed registry in the owning runtime package and generate `reference/configuration.md` plus `contributing/local-setup/environment-and-ports.md`. | Every runtime `Config` or `process.env` key is registered with scope, default, secret status, and audience, and `.env.example` contains every supported development key.                             |
| Publish the contributor path.                      | Add all pages under `apps/docs/src/content/docs/contributing/`; reduce `DEVELOPMENT.md` to an entry point.                                             | A clean checkout can install, start web and Postgres, connect to Sealant, exercise the product loop, change one endpoint, and run required checks without reading archived files.                    |
| Publish current architecture.                      | Add all pages under `apps/docs/src/content/docs/architecture/`; replace source comments that cite the retired `ARCHITECTURE.md`.                       | Every cited module has a current architecture link, package ownership matches manifests, and transport and trust diagrams match implementation.                                                      |
| Split mixed decision records from user procedures. | Create `docs/decisions/GIT-ACCESS.md`, `SEALANT-IDENTITY.md`, `SESSION-SERVICES.md`, and `WORKSPACE-IMAGES.md`; archive `docs/M0-INVENTORY.md`.        | Decision records state status and date, public derivatives pass their task tests, and no user page depends on delivery-slice prose.                                                                  |
| Make Postgres-backed contract evidence mandatory.  | Update `.github/workflows/ci.yml` and database tests.                                                                                                  | CI starts Postgres, applies every migration to a clean database, runs device and repository tests without skips, and checks declared schema parity for tables, columns, indexes, and foreign keys.   |
| Complete tested operator procedures.               | Replace Planned placeholders in `operations/upgrade.md`, `operations/backup-and-restore.md`, and `operations/uninstall.md`.                            | Fresh install, rerun, pinned upgrade, backup, clean restore, program-only uninstall, data-destroying uninstall, failed health check, and documented rollback limits pass in disposable environments. |

### P2: remove remaining manual drift

| Work                                                             | Exact paths                                                                                          | Acceptance checks                                                                                                                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate the complete API reference and a client drift manifest. | Add `reference/generated/http-api.md` and generator code under `apps/docs/scripts/`.                 | `MendApi` reflection and the manual-route manifest cover HTTP, auth, SSE, TTY, and key bridge, and CI detects method, path, success, or error changes in hand-written clients.                |
| Generate domain, database, and package references.               | Add `reference/generated/domain.md`, `database.md`, and `packages.md`.                               | CI regeneration has no diff, retiring types and tables are labeled, and the package graph rejects undeclared boundary crossings.                                                              |
| Add release and installer conformance tests.                     | Extend installer tests and release workflows under `.github/workflows/`.                             | `sh -n`, ShellCheck, x64 and arm64 smoke tests, `docker compose config`, production-secret policy, server tag, npm CLI, served installer, and minimum Sealant release pass as one set.        |
| Add cross-client contract and token parity checks.               | Cover clients in `apps/web`, `apps/desktop`, `apps/mobile`, `apps/cli`, and tokens in `packages/ui`. | Client wire copies cannot drift silently from the API manifest, and CSS and TypeScript token definitions stay synchronized.                                                                   |
| Archive this implementation plan.                                | Move `docs/DOCUMENTATION-PLAN.md` to `docs/archive/DOCUMENTATION-PLAN.md`.                           | The explicit sidebar, ownership metadata, generated references, migration destinations, and all CI gates exist, with remaining product work tracked in canonical product or platform sources. |

## Ownership and change triggers

The roles below become `CODEOWNERS` groups when maintainers map them to GitHub handles. Until that
file exists, reviewers assign the named role explicitly.

| Owner role             | Owns                                                                                                                                                | Required review triggers                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Product engineering    | `MEND-AGENT-WORKBENCH-PLAN.md`, `apps/docs/src/content/docs/concepts`, `reference/product-language.md`, and `reference/feature-status.md`           | Product noun, cardinality, milestone, status language, publication, context, or inference behavior changes.                           |
| Documentation          | `apps/docs`, `docs/DOCUMENTATION-PLAN.md`, generators under `apps/docs/scripts`, and docs CI checks                                                 | Any public page, route, sidebar, docs schema, generator, origin, or publication workflow change.                                      |
| Release and operations | `install.sh`, `deploy/docker/*`, `apps/cli/src/server-setup.ts`, `compose.dev.yaml`, release workflows, and `apps/docs/src/content/docs/operations` | Port, path, service name, minimum version, install, upgrade, backup, restore, uninstall, or bind change.                              |
| CLI                    | `apps/cli/src/main.ts` and `/reference/cli/`                                                                                                        | Command, flag, help, output, status, selection, completion, exit, login, pairing, or configuration change.                            |
| API                    | `packages/api/src/contract.ts`, `server.ts`, `events.ts`, `tty.ts`, and `keys-bridge.ts`                                                            | Endpoint, DTO, error, auth middleware, SSE event, WebSocket, or manual route change.                                                  |
| Domain and database    | `packages/domain/src/workbench`, `packages/db/src/schema`, `packages/db/src/migrations.ts`, and `packages/db/src/repos`                             | Noun, status, schema, relation, migration, repository, or data ownership change.                                                      |
| Sessions               | `packages/sessions`, Service domain modules, and session guides and references                                                                      | Session fold, process lifecycle, workspace retention, attach, resume, Service, recipe, forwarding, or lease change.                   |
| Store and Git security | `packages/store`, key bridge code, Git decision record, and Git guide and reference                                                                 | Adoption, store path, worktree, checkpoint, remote operation, auth mode, key, shim, or shared repository change.                      |
| Auth and security      | `packages/auth`, pairing and device code, security pages, and remote access guide                                                                   | Sign-up, session, token, scope, user visibility, pairing, revocation, trusted origin, audit, or network boundary change.              |
| Sealant integration    | `packages/sealant`, `PLATFORM-FEEDBACK.md`, identity decision record, and Sealant architecture page                                                 | SDK version, service principal, owner mapping, connected account, credential, workspace, run, forward, or platform-gap status change. |
| Inference and jobs     | `packages/inference`, `packages/jobs`, evidence concept, and inference architecture page                                                            | Provider, model selection, prompt, generated claim, evidence requirement, worker, or review-pass change.                              |
| UI and design          | `DESIGN.md`, `packages/ui`, and `apps/docs/src/styles/custom.css`                                                                                   | Token, typography, status presentation, evidence language, or shared component change.                                                |

Specific path triggers must update or explicitly mark these docs as unaffected:

| Changed source                                                                                         | Required documentation impact                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEND-AGENT-WORKBENCH-PLAN.md`                                                                         | Review `/concepts/product-model/`, `/concepts/roadmap/`, `/reference/product-language/`, and `/reference/feature-status/`.                      |
| `PLATFORM-FEEDBACK.md` or the `@sealant/sdk` version                                                   | Review `/architecture/sealant-boundary/`, `/reference/known-limitations/`, `/reference/feature-status/`, and any task page blocked by that gap. |
| `install.sh`, `deploy/docker/*`, `apps/cli/src/server-setup.ts`, or `compose.dev.yaml`                 | Regenerate or review requirements, install, secure-instance, operations, configuration, system overview, and release pages.                     |
| `apps/cli/src/main.ts`                                                                                 | Regenerate `/reference/cli/` and review all command samples plus shell completion claims.                                                       |
| `packages/api/src/contract.ts`                                                                         | Regenerate HTTP reference, update client drift manifests, and review endpoint workflow docs.                                                    |
| `packages/api/src/events.ts`, `tty.ts`, `keys-bridge.ts`, or `apps/web/src/entry/main.ts` route mounts | Update the manual-route manifest and API transport architecture page.                                                                           |
| `packages/domain/src/workbench/**`                                                                     | Regenerate domain reference and review product model, language, lifecycle, and database workflow pages.                                         |
| `packages/db/src/schema/**` or `packages/db/src/migrations.ts`                                         | Regenerate database reference and run mandatory clean Postgres migration checks.                                                                |
| `packages/sessions/**`                                                                                 | Review session lifecycle, Services, project setup, configuration, and Services architecture pages.                                              |
| `packages/store/**`                                                                                    | Review adoption, Git access, store and review architecture, security, and configuration pages.                                                  |
| `packages/auth/**`, `packages/api/src/devices.ts`, or `packages/db/src/repos/devices.ts`               | Review secure-instance, remote access, security concept, security reference, and limitations pages.                                             |
| `packages/inference/**` or `packages/jobs/**`                                                          | Review evidence and inference, feature status, known limitations, and inference architecture pages.                                             |
| Any workspace `package.json`, `pnpm-workspace.yaml`, `turbo.json`, or `.node-version`                  | Regenerate package and scripts reference and review contributor prerequisites, apps, dependencies, and tests.                                   |

A pull request that touches a trigger path must include a `Docs impact` section with one of two
outcomes: named page changes, or `No docs change` with the exact source and test proving that public
behavior did not change.

## CI checks

Add a `pnpm docs:check` root command and run it after `pnpm build` in `.github/workflows/ci.yml`. It
performs these checks:

1. Run `pnpm --filter @mend/docs typecheck` and `pnpm --filter @mend/docs build` explicitly.
2. Crawl the built Starlight site for broken internal routes, missing anchors, missing assets, and
   invalid repository source paths.
3. Validate `owner`, `availability`, `last_verified`, and `verified_against` through
   `apps/docs/src/content.config.ts`.
4. Reject current product pages containing legacy workflow terms, with allowlists limited to
   `docs/archive/**`, historical decision context, and the prohibition in
   `/reference/product-language/`.
5. Reject unqualified planned claims for context packs, context snapshots, handoffs, publication,
   side-by-side review, live-TUI follow-up, published native mobile, account isolation, scoped
   devices, control auditing, automatic listener discovery, or path-proxy Services.
6. Compare `.node-version`, `package.json#packageManager`, installer prerequisites, Compose minimum,
   documented ports, service names, paths, and defaults against generated documentation data.
7. Regenerate CLI, configuration, Service recipe, API, domain, database, and package references and
   fail on a diff.
8. Snapshot `MendApi` and the manual auth, SSE, TTY, and key-bridge route manifest, then compare
   hand-written client paths and methods in web, desktop, mobile, and CLI.
9. Start Postgres, apply every migration, run migration, repository, pairing, and device tests
   without skips, and compare the resulting database with declared Drizzle tables, columns, indexes,
   and foreign keys.
10. Keep the byte-identity check between `install.sh` and `apps/marketing/public/install.sh`; add
    `sh -n`, ShellCheck, `docker compose config` on `deploy/docker/compose.v2.yaml`, and
    production-secret policy checks.
11. Check that changes to any ownership trigger include the required `Docs impact` section and the
    named owner review.
12. Check external links on a scheduled job and before docs deployment, while pull requests use a
    bounded allowlist and retry policy so third-party outages do not hide internal failures.
13. Probe every configured public route after deployment and fail the deployment if the origin, base
    path, asset path, or route is unavailable.

For release tags, run the forced repository checks required by `AGENTS.md`:
`pnpm exec turbo typecheck --force` and `pnpm exec turbo lint --force`. The release gate also runs
tests, docs checks, installer smoke tests, and the release-set compatibility check.

## Claims and pages that must wait for implementation evidence

| Claim or page                                                                                                            | Current label                                  | Evidence required before `shipped`                                                                                                                            | Allowed documentation now                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Context items, context packs, immutable context snapshots, promotion, and handoffs                                       | Planned                                        | User-facing storage, selection, session attachment, inspection, edit and promotion flows plus an M3 acceptance run on a real repository.                      | Describe in `/concepts/product-model/` and `/concepts/roadmap/` under Planned only.                                              |
| Optional issue or pull request attachment and commit or pull request publication                                         | Planned                                        | Current workbench routes, persistence, permission handling, failure recovery, and M5 acceptance tests.                                                        | State that publication is optional product direction; provide no task instructions.                                              |
| Provenance for every arbitrary hunk                                                                                      | Planned                                        | A hunk-level evidence UI and tests covering direct, inferred, unknown, stale, and telemetry-gap cases.                                                        | Describe current evidence-linked tour stops and draft findings only.                                                             |
| Sending review text into a live TUI                                                                                      | Planned                                        | Exact-process delivery, idempotency, timeout and restart recovery, duplicate prevention, and a live-session acceptance test.                                  | Document settled-session relaunch and pending behavior while an agent is active.                                                 |
| Full "Mend reads the change" contract                                                                                    | Mixed                                          | On-demand settled-change pass, evidence or runnable check on every finding, accept, edit, dismiss, proposed verification, and real-repository M2.5 exit test. | Document only read, suggestion, or tour behavior observed in the verified build.                                                 |
| Side-by-side diff, whitespace controls, staged and unstaged views, hunk staging, discard, image diff, and review history | Planned unless separately verified             | UI implementation and interaction tests for each named control on desktop and supported narrow layouts.                                                       | List them only in roadmap or feature status with individual labels.                                                              |
| Automatic listener discovery or automatic Service creation                                                               | Not planned                                    | A new canonical product decision would be required because the current decision explicitly requires declaration.                                              | State that Services are explicit and observations never expose a port automatically.                                             |
| Session path proxies such as `/s/<session>/<port>` or automatic forwarding                                               | Not planned                                    | A new canonical product decision would be required because raw per-port forwarding replaced this design.                                                      | Document actual host-port endpoints and private-network access.                                                                  |
| Published native mobile app                                                                                              | Planned                                        | Signed distribution, supported install path, versioned API compatibility, pairing, revocation, and device acceptance tests.                                   | State that `apps/mobile` is unpublished and browser access is the no-install phone path.                                         |
| Installable PWA                                                                                                          | Planned until manifest and install tests exist | Manifest, service worker where required, install prompt behavior, offline boundary, and supported browser tests.                                              | Describe responsive browser access only.                                                                                         |
| Account-isolated multi-user deployment                                                                                   | Planned security work                          | Two-user authorization tests for project, session, terminal, Service, review, and record access plus enforced ownership rules.                                | State that every signed-in account must be trusted with instance-wide workbench data.                                            |
| Scoped device authorization                                                                                              | Planned security work                          | Read-only and control scopes enforced by API and WebSocket paths, revocation tests, expiry tests, and denial tests.                                           | State that paired device tokens currently receive normal authenticated API access.                                               |
| General audit trail for remote controls                                                                                  | Planned security work                          | Durable actor and device records for terminal input, stop, shell, Service, pairing, and review delivery plus query and retention tests.                       | State which inference audits exist and that general control auditing does not.                                                   |
| Secure LAN transport                                                                                                     | Operator supplied                              | Supported TLS termination procedure, trusted-origin configuration, WebSocket tests, and credential handling checks.                                           | Prefer Tailscale and warn that plain LAN HTTP exposes credentials and tokens to that network.                                    |
| Supported backup and restore                                                                                             | Backup shipped, restore planned until tested   | Clean restore of Mend Postgres, Sealant Postgres, store, configuration, keys, and Sealant records with version and integrity checks.                          | State that `mend server upgrade` saves a private `pg_dumpall` dump before activation; keep restore labeled Planned.              |
| Supported upgrade and rollback                                                                                           | Upgrade shipped, rollback not offered          | Version compatibility matrix, pre-upgrade backup, migration, health, failure, and rollback-limit acceptance runs.                                             | State that `mend server upgrade` backs up before activation, refuses downgrades, and never rolls back or restores automatically. |
| Supported uninstall                                                                                                      | Planned until tested                           | Program-only and destructive paths tested on installer-created Linux systems, including user services and XDG paths.                                          | Publish no destructive command outside a Planned placeholder.                                                                    |
| Root `compose.yaml` as a supported production topology                                                                   | Retired                                        | None; `deploy/docker/compose.v2.yaml` driven by `mend server setup` is the supported topology.                                                                | Do not document the retired root Compose or host-process installer.                                                              |
| Custom workspace base images and setup commands                                                                          | Planned                                        | Released SDK contract, selectable project UI, build and boot tests on amd64 and arm64, failure display, and session launch acceptance.                        | Document verified current image choices and keep custom bases in Planned.                                                        |
| Codex inference fallback from connected accounts                                                                         | Implemented at source, not adopted             | A released Sealant SDK containing the implementation, Mend dependency adoption, provider fallback tests, and a real connected-account run.                    | Link the canonical `PLATFORM-FEEDBACK.md` entry from the Sealant boundary page.                                                  |
| Complete resumable PTY cursor and idempotent follow-up launch                                                            | Open SDK gaps                                  | Released SDK support, Mend adoption, reconnect and retry tests, and removal of any workaround claims.                                                         | Document current reconnect and retry limits in known limitations.                                                                |
| Public docs hostname                                                                                                     | Not established                                | `site` and `base` configuration, deployment workflow, DNS, TLS, route probes, and a successful production deployment.                                         | Use repository paths during development and do not add public docs links from marketing or README.                               |
