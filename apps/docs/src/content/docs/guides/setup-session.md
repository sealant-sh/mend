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
  verify.md       How to try each feature and what to observe
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

The setup session writes a way to get a signed-in test user, not just a description of the login
page. `.mend/verify.md` says what to run and what it needs.

For OAuth or another external provider, the agent studies your app's own session storage. It writes
a script under `.mend/`, such as `create-test-session.mjs`, which creates a valid test-user session
in the app's development database or signs its session cookie with the app's dev secret. The
verification file gives the script command, runtime secret names, test-user and database
prerequisites, and how to install that session in the screen's browser. Captures skip the external
provider's flow. The script reads secrets at runtime; its code and instructions contain no values,
signed cookies or session tokens.

For password auth, the file names the seed script or documents the sign-up flow that creates the
test account. It lists the exact project secret or Doppler names and the command to set them, as in
the example above. You do not have to guess where an account comes from or which secret to add.

Every screen starts with a fresh browser profile. After it ends, the agent repeats the documented
auth preparation for the next screen. Missing runtime prerequisites are named as `not captured`, not
replaced with an anonymous page. Writing the script does not execute it during setup.

## Recipes and resources

For this example, `.mend/mend.toml` could contain:

```toml
[setup]
run = ["pnpm install --frozen-lockfile"]
inputs = ["pnpm-lock.yaml"]

[resource.db]
preset = "postgres"
image = "postgres:17"

[service.web]
command = "pnpm dev"
cwd = "apps/web"
port = 3000
browserScheme = "http"
depends = ["@db"]
env = { DATABASE_URL = "${MEND_DB_URL}" }

[preview]
service = "web"
```

`[setup]` holds commands a later Service start runs. The setup session writes those commands; it
does not run them. The web Service uses `@db` and explicitly maps its resource URL to the app's
`DATABASE_URL`. Declaring `@db` or naming it in `depends` does not start it.

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
into the session's Slack thread and shows them inline in T3 Code. Planned landing delivery will
embed them in the PR body; the planned review page and phone will show them beside the change. Once
posted, copies live under Slack's, T3 Code's or GitHub's access rules. Media on a public repository
is visible to anyone.

## Build order

1. Screenshots and a short video of the app with the change.
2. Delivery to Slack and inline display in T3 Code.
3. The setup session, including auth preparation.
4. Embedded media in the PR body.
5. The review page and phone presentation.

Withdrawing a capture is deferred to later work.
