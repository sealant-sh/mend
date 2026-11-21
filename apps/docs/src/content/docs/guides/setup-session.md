---
title: Set up a project with an agent
description:
  Let your agent study a repository and propose a feature map, verification instructions and
  recipes.
sidebar:
  order: 1.5
---

When you adopt a repository, Mend asks whether to run a setup session. Choose **Set up this
project** to let your agent study the repo and write down what the app does and how to run and check
it. The session uses your own agent login. Choose **Not now** to finish adoption without it; the
project's **Set up this project** action stays available later.

A setup session is an ordinary session running Mend's prompt. You choose your agent, see the prompt
and conversation, answer questions and send follow-ups. Its result is a change you can review and
land like any other change.

## Start a setup session

- **Web:** after adoption, choose a connected Claude or Codex login and press **Set up this
  project**. Later, use **Set up this project** beside **Open a shell** or in the project menu.
- **CLI:** run `mend setup-session [claude|codex]` in an adopted checkout. With no agent, it uses
  Codex. Add `--note "Focus on browser sign-in"` for your own instructions, or `--project <name>`
  from elsewhere. It starts a terminal session and attaches it. `mend adopt` asks on a terminal:
  `Set up this project with codex? It uses your own codex login. [y/N]`. Only `y` or `yes` starts
  one. Scripts are never asked, and implicit adoption by `mend claude` or `mend codex` never asks.
- **Phone:** after adoption, choose Claude or Codex, then **Set up this project**. The same action
  stays on the project screen. The session opens in conversation mode.
- **VS Code:** after **Adopt a repository** or **Adopt this repository**, choose **Set up this
  project**, then your agent. Later, run **Mend: Set up this project** from the command palette.

**Not now**, dismissal or leaving the choice starts nothing. Adoption is already complete. Every
setup session gets a new worktree with automatic landing off. Mend supplies its opening prompt;
clients send only your own note when you give one.

Project launch settings live on the **Configuration** tab. That tab configures launches; the setup
session proposes repository files for review.

## What the session writes

For a task board app, the proposed files might be:

```text
.mend/
  features.md     What people can do and where each feature lives
  verify.md       Authentication, provider registration and feature checks
  mend.toml       Setup, Services, preview and resource definitions
  create-test-session.mjs  An app-specific script when auth uses an external provider
```

The agent reads existing instructions, app code, tests and infrastructure files. It updates existing
`.mend/` files rather than replacing your notes with a template. It records uncertainty and
instructions it has not tried. Finishing this session does not mean it has observed your app
running.

### A feature map

An entry in `.mend/features.md` might say:

```markdown
## Task board

People add tasks, mark them complete and see saved tasks after reloading. The board page lives in
`apps/web/src/routes/board.tsx`; task storage lives in `packages/tasks/src/`. See "Task board" in
`.mend/verify.md` for the user flow.
```

Paths come from your repository. The map describes the app's behavior and connects it to the code
and verification instructions. It is not just a list of packages.

### Verification instructions

The matching entry in `.mend/verify.md` might say:

```markdown
## Sign-in and test account

The board requires email and password sign-in at `/login`. Its `pnpm seed:test-user` command creates
a test account with permission to add and complete tasks. The seed reads TEST_USER_EMAIL and
TEST_USER_PASSWORD from runtime secrets. Prepare a protected capture.env file outside the repo with
those names, then load it with:

    mend env load /path/outside/repo/capture.env --secret --project task-board

If this project uses Doppler instead, upload that file to its selected config:

    doppler secrets upload /path/outside/repo/capture.env --project task-board --config dev

After the resource and schema are prepared, run `pnpm seed:test-user` in the capture's own database.
Do not write secret values into `.mend/`.

## Task board

Preconditions: start the declared @db resource explicitly, then start the web Service. Before
migrations or writes, choose a worktree database. Prepare the project's task-board fixtures there.
The test account must exist in that data.

Open the preview. Sign in at `/login`, then open `/board`. Add a task named "Review the board" and
observe it in the list. Mark it complete and observe its completed state. Reload the board and
observe that the same task is still complete. Keep a screenshot of that state and a short video of
the flow. Remove only the task this check created.

Not tried during setup. Supply the named runtime secrets before running these instructions.
```

The names and seed command above are examples for this task-board repo. Setup finds the actual
commands and names in your app. If there is no seed script, it documents the sign-up flow exactly,
including how to create the test account and where to store its credentials. It also lists which
resources each flow needs, how to prepare data and which actions change it.

## Apps that require sign-in

Authentication is one of the main things setup discovers. It inspects the app's auth configuration,
routes and environment examples for OAuth/OIDC providers, magic links, password auth and SSO.
`.mend/verify.md` records the configuration source paths, required env and secret names, callback
paths, protected user flows and test-user role. It contains names only, never secret values.

The file's `Authentication` section has four parts:

- `Providers and configuration`, with a table of provider or method, configuration source, required
  env names and callback or redirect paths.
- `Addresses and provider registration`, with separate preview, person's localhost and workspace
  localhost rows for each provider. Its columns are access, app origin, callback URLs, register at,
  allowed origins and cookie settings, and status.
- `Sign-in for checks`, with commands, prerequisites, browser preparation and cleanup.
- `Missing prerequisites`, with unresolved inputs and the person action or later check needed.

An app without auth gets `no authentication found` and the paths setup inspected. An auth method the
agent cannot establish stays `unknown`, with the missing information named.

### Register OAuth callback addresses

Your OAuth provider compares the callback URL your app sends with its registered URLs. The scheme,
hostname, port and path must match. A fixed workspace port does not make a preview URL match a
localhost callback.

Setup writes down what to register in the provider's console. For example, an app whose GitHub
callback is `/api/auth/callback/github` on workspace port 3000 needs
`http://localhost:3000/api/auth/callback/github` for a browser inside that workspace. Its preview
needs the preview's actual origin followed by `/api/auth/callback/github`. These paths and the port
are examples; use the ones setup finds in your app.

You can also sign in on your own machine through a tunnel with a fixed local port. Register
`http://localhost:<port>/<callback path>` with your provider, then run:

```sh
mend service connect <service> --port <port>
```

Open `http://localhost:<port>` on that machine and keep the tunnel running during sign-in. For the
example above, choosing local port 3000 means registering
`http://localhost:3000/api/auth/callback/github` and running `mend service connect web --port 3000`.
The callback reaches your machine on that exact port, then the tunnel carries it to the app in the
workspace. The local port can differ from the Service's workspace port. Configure the app's
public/base URL for the chosen localhost origin and restart the Service if needed. Setup records
that setting separately from the preview's. If your app or provider requires a different loopback
hostname or HTTPS, its registration row must say so.

For GitHub, the setting is **Settings → Developer settings → OAuth Apps → your development app →
Authorization callback URL**. GitHub OAuth Apps have one callback URL, so separate development OAuth
Apps may be needed for localhost and the preview. For Google, use your development OAuth client's
**Authorized redirect URIs**, and **Authorized JavaScript origins** when the app needs them. Other
providers have their own redirect, logout, trusted-origin or cookie-domain settings. Setup should
name the console, application and exact fields for the providers it discovers. You make those
changes; Mend cannot register URLs with the provider.

Setup studies and writes without starting a preview, so its address may be unknown. The output must
say `unknown` and give these steps to complete the registration later:

1. After choosing to run the app, start its declared resources explicitly at the documented project
   or worktree level. For an opted-in fixed project preview, run
   `mend preview start --project <project>`, then `mend preview project --project <project> --json`
   and copy its reported `url`. For an ordinary worktree preview, start the Service with
   `mend service <name>`.
2. Choose the preview's **Open in a new tab**, complete Mend sign-in and copy the final app origin
   from the address bar. Keep the scheme, hostname and port; leave out paths, tickets and query
   strings. `MEND_PREVIEW_URL` in the Service process also gives that origin when set. It is not
   automatically available in the agent's shell.
3. Append each callback path from the auth configuration. Fill in the preview row in `verify.md`
   with those full URLs and the provider's required origins. Register the exact entries in the
   provider console. Register the workspace localhost callbacks separately where supported.
4. Set the app's own public/base URL and trusted origins as documented, then restart the Service if
   its configuration changed. Mend's `/preview-auth` and `/__mend/auth` routes are for Mend access;
   they are not your app's OAuth callbacks.

Setup must record exact registration rows for both ways to sign in: the preview address and the
person's pinned localhost address. With a [fixed project preview](#use-a-fixed-project-preview), use
the configured fixed address reported by Mend. If it has not been allocated yet, keep its row
`unknown` with the completion steps above. Never guess an address. Keep the workspace localhost
registration in its own row too.

Without `fixed = true`, each new worktree's preview gets a new address and needs its own provider
registration. That preview belongs to a worktree and Service and keeps its identity across Service
restarts. On the `ts.net` default its external port comes from a pool, separately from the fixed
workspace port, and can be reassigned after inactivity. Fixed project ports stay reserved. Operator
domain or hostname changes require new registration in either case.

Some provider flows cannot use the preview gateway. It refuses cross-origin POST callbacks, such as
OIDC `form_post` and SAML POST responses. Use a GET callback mode only when the app and provider
support it; otherwise record the limit in `Missing prerequisites`. Registering a URL does not change
this. Provider requirements for HTTPS, verified domains or access to a private address may also need
a different development configuration. Open sign-in in a new tab if the provider refuses to run
inside Mend's preview frame.

### Prepare sign-in for checks

For OAuth or another external provider, the agent studies your app's own session storage. It writes
a script under `.mend/`, such as `create-test-session.mjs`, which creates a valid test-user session
in the app's development database or signs its session cookie with the app's dev secret. The
verification file gives the script command, runtime secret names, test-user and database
prerequisites, and how to install that session in the screen's browser. Captures skip the external
provider's flow. The script reads secrets at runtime; its code and instructions contain no values,
signed cookies or session tokens.

The instructions specify the target browser origin, cookie name, domain, path, Secure, HttpOnly and
SameSite attributes, expiry and cleanup. They account for the preview gateway's cookie handling,
including the `ts.net` HttpOnly cookie namespace. Use an app-supported session response or a
protected browser-state import without printing auth material or placing values in tool arguments.
Transient browser state stays outside the repository and is removed after use. If setup cannot
establish supported test-session creation, it records the blocker and any supported test-mode
alternative. It must not invent a session format or weaken production auth. These checks exercise
the signed-in app; they do not verify the provider's OAuth flow.

For password auth, the file names the seed script or documents the sign-up flow that creates the
test account. It lists the exact project secret or Doppler names and the command to set them, as in
the example above. You do not have to guess where an account comes from or which secret to add. For
magic links or SSO, it records the supported development/test route and missing prerequisites.

Every screen starts with a fresh browser profile. After it ends, the agent repeats the documented
auth preparation for the next screen. Missing runtime prerequisites are named as `not captured`, not
replaced with an anonymous page. Writing the script does not execute it during setup.

## Use a fixed project preview

For repeated provider sign-in, opt in to a
[fixed project preview](/guides/services/#a-fixed-preview-for-the-project) with
`[preview] service = "web"` and `fixed = true` on the default branch. It gives the project one
address and an explicitly chosen worktree. Start defaults to the shared Local default-branch
worktree; it creates that checkout only on explicit Start and preserves its edits. CLI and web can
choose another target. The phone shows the URL, target and status read-only.

Setup uses the exact fixed origin Mend reports when one has already been allocated. It must not
invent a hostname, start the target or switch it. If no address exists yet, write `unknown` in the
preview registration row and include these later steps:

1. After choosing to run the app, start its required resources at the documented level. Run
   `mend preview start --project <project>`, then `mend preview project --project <project> --json`.
   The web Worktrees tab also shows the address and an explicit Start action.
2. Copy the reported `url`, keeping scheme, host and port. Open the preview in a new tab and
   complete Mend sign-in. Append the app's actual callback paths, then fill in the preview row of
   `.mend/verify.md` and register those full URLs in the provider's development application.
3. Apply the app's public/base-URL, allowed-origin and cookie settings documented by setup. Restart
   its Service explicitly if it was already running with another origin. `MEND_PREVIEW_URL` is set
   at Service start; it does not update the agent's shell or the auth library automatically.

Keep three separate registration rows per discovered provider: the preview origin, localhost on your
machine, and localhost inside the workspace. For example, if the app's actual callback is
`/auth/callback/github` and you choose local port 3000, the person's-machine row is exactly
`http://localhost:3000/auth/callback/github`. Register it first, then run
`mend service connect web --port 3000` and open `http://localhost:3000` on your machine. Keep the
tunnel running during sign-in. Configure the app's base URL for that localhost origin when it
requires one. The workspace-localhost row uses the Service's declared workspace port separately. Use
your app's actual callback, Service name and port in place of this example.

Register the preview's full callback URLs and required origins once for its fixed address. Setup
names the provider console, development application and fields to edit. Providers that allow one
callback may need separate development applications for the preview and localhost. Mend does not
register them for you. Secret names belong in `.mend/`; secret values never do.

Without `fixed = true`, every new worktree's preview has its own address and needs its own provider
registration. Use the final app origin from **Open in a new tab** to fill an unknown row, excluding
Mend access routes, tickets and query strings. Ordinary `ts.net` ports can be reassigned after
inactivity. Fixed project ports stay reserved; an operator changing the preview domain or hostname
still requires re-registration.

Cross-origin POST callbacks remain an app/provider limit through the preview gateway, including OIDC
`form_post` and SAML POST responses. Registering a fixed URL does not change admission. Use a GET
callback mode only when the app and provider support it, or document the missing prerequisite. The
localhost tunnel is another route when the provider accepts its callback address. For proof
artifacts, keep the D11 test-session helper or password seed/sign-up flow in `verify.md`.

## Recipes and resources

Before writing recipes, setup checks the repository's lockfile and `packageManager` field and runs
`command -v pnpm npm bun yarn corepack` in the workspace. It records which tools it found in
`.mend/verify.md` and uses the installed package manager matching the lockfile directly. It uses
`corepack <manager>` only when Corepack is present and the matching package-manager binary is
absent. This lookup does not install or run a package manager.

If the required tool is missing, the recipe checks for it and exits with a message naming the
prerequisite before trying to use it. `.mend/verify.md` records the missing tool and what you need
to provide before starting the recipe. Listing an unchecked prerequisite there alone is not enough.

For pnpm repositories, setup also checks dependency build scripts against approvals in the `pnpm`
field of `package.json`, `pnpm-workspace.yaml` and existing pnpm configuration. It checks which
packages are approved, including transitive dependencies. A policy key alone does not approve every
package. Setup preserves explicit decisions to ignore or deny builds.

Some lockfiles identify packages with `requiresBuild`. A v9 lockfile can omit that field even for
`esbuild`, so its absence does not establish that no builds are needed. Setup reads exact-version
package manifests or registry metadata without installing dependencies or running their scripts. It
records any evidence it cannot establish as unknown.

If packages need approval, `.mend/verify.md` gets a **Dependency build prerequisites** section
naming the packages, locked versions and evidence. Review the listed packages, run
`pnpm approve-builds` and commit the resulting policy change, or add those packages to
`onlyBuiltDependencies` in your existing policy file. A repository using `allowBuilds` gets
instructions for per-package approvals in that format. Setup states that it did not change your
repository's dependency policy. It never approves builds for you, allows all builds or disables
pnpm's build-policy checks.

When approvals are missing or unknown, the proposed install step handles `ERR_PNPM_IGNORED_BUILDS`
with one plain line naming the step, affected packages and action. For example:

```text
setup.run (pnpm install): esbuild@0.21.5 needs build-script approval; run pnpm approve-builds and commit the result, or add esbuild to onlyBuiltDependencies.
```

That step exits nonzero, so the Service does not start. Other install failures keep their original
diagnostic and exit status. A later Start uses the current policy and proceeds once you approve
builds. The recipe includes the policy files in `setup.inputs` so changes invalidate setup
freshness. Repositories whose required builds are already approved, or whose dependencies need no
build scripts, keep their install commands.

For this example, pnpm was found in the workspace and dependency builds are already approved.
`.mend/mend.toml` could contain:

```toml
[setup]
run = ["pnpm install --frozen-lockfile"]
inputs = ["package.json", "pnpm-lock.yaml"]

[resource.db]
preset = "postgres"
image = "postgres:17"

[service.web]
command = "pnpm dev --port 3000 --strictPort --host 127.0.0.1"
cwd = "apps/web"
port = 3000
browserScheme = "http"
host = "preserve"
depends = ["@db"]
env = { DATABASE_URL = "${MEND_DB_URL}" }

[preview]
service = "web"
```

The output uses Mend's recipe keys exactly. `[setup].run` is a non-empty list of shell commands,
with optional `inputs` for setup freshness. `setup.commands` is not supported. A browser Service
needs `browserScheme = "http"`; `protocol` selects TCP or UDP, so `protocol = "http"` is invalid.
`[preview].service` names that runnable HTTP Service.

Put `host = "preserve"` or `host = "rewrite"` under `[service.web]`, never under `[preview]`. The
default `rewrite` sends `Host: localhost:<port>`; `preserve` sends the preview host. Both supply
`X-Forwarded-Host` and `X-Forwarded-Proto`. Setup chooses the policy and the app's trusted-proxy
settings from its actual auth configuration. The example preserves the preview host. In `verify.md`,
setup records the recipe path, `setup.run`, Service name, fixed port, browser scheme, host policy
and preview Service alongside the start prerequisites.

`[setup]` holds commands a later Service start runs. The setup session writes those commands; it
does not run them. The web Service uses `@db` and explicitly maps its resource URL to the app's
`DATABASE_URL`. Declaring `@db` or naming it in `depends` does not start it.

This example uses Vite's fixed-port flags. Setup chooses your app's actual launch options. An OAuth
app's Service port and launch command must agree with its localhost callbacks and fail if that port
is occupied, rather than silently select another. Mend supplies `PORT` to the Service. When a
preview has an address it also supplies `MEND_PREVIEW_URL`; setup documents how the command maps
that to the app's own public/base-URL setting. Mend does not configure auth libraries automatically.
See [Callback addresses and fixed ports](/guides/services/#callback-addresses-and-fixed-ports) for
the distinction between the workspace, preview and local tunnel addresses.

Your app gets recipes for what it actually needs. An app that uses an external database can keep
using project secrets or Doppler instead of a Mend resource. A repo without a browser app gets
verification instructions for its own entry points; web proof capture is marked unavailable.

See [Resources](/guides/resources/) for explicit starts and env mapping, and
[Development services](/guides/services/) for setup, Service and preview recipes. The resource guide
describes the agreed `.mend/mend.toml` location and start behavior; older builds and examples may
still use a root `mend.toml`. If both exist, `.mend/mend.toml` wins. The setup change must carry
forward your existing recipes when proposing a move.

## Review the result before using it

Open [Review](/guides/review-a-change/) and read the proposed files. Check the feature paths,
sign-in instructions, test-data needs, commands and resource definitions. Send corrections back to
the same session. Land the change when you want those files on origin, or keep working locally.

Writing or landing them starts nothing. The setup session's prompt studies and writes; it does not
start resources or Services, install dependencies, migrate data or sign in to your app. You can ask
a follow-up session to run the instructions explicitly. Starting resources still requires a choice
of project or worktree level, as the resource guide describes.

Later sessions use these files to find the relevant user flow, prepare a signed-in test user and
choose [proof artifacts](/guides/proof-artifacts/). Mend uploads the selected screenshots and video
into the session's Slack thread and shows them inline in T3 Code. Landing embeds them in the PR
body, and the review page and the phone show them beside the change. Once posted, copies live under
Slack's, T3 Code's or GitHub's access rules. Media on a public repository is visible to anyone.

Withdrawing a capture is not built yet.
