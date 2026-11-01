---
title: Set up a project with an agent
description:
  Let your agent study a repository and propose a feature map, verification instructions and
  recipes.
sidebar:
  order: 1.5
---

:::note[Agreed design, not yet built] This guide describes the setup session designed for Mend 0.37.
The action and files described here are planned behavior, not commands or controls available in the
current build. :::

When you adopt a repository, Mend asks whether to run a setup session. Choose **Set up this
project** to let your agent study the repo and write down what the app does and how to run and check
it. The session uses your own agent login. Choose **Not now** to finish adoption without it; the
project's **Set up this project** action stays available later.

A setup session is an ordinary session running Mend's prompt. You choose your agent, see the prompt
and conversation, answer questions and send follow-ups. Its result is a change you can review and
land like any other change.

## What the session writes

For a task board app, the proposed files might be:

```text
.mend/
  features.md     What people can do and where each feature lives
  verify.md       How to try each feature and what to observe
  mend.toml       Setup, Services, preview and resource definitions
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

The board requires email and password sign-in at `/login`. Provide a project test account through
project secrets or Doppler using TEST_USER_EMAIL and TEST_USER_PASSWORD. Keep their values out of
this file. Use a test account with permission to add and complete tasks.

## Task board

Preconditions: start the declared @db resource explicitly, then start the web Service. Before
migrations or writes, choose a worktree database. Prepare the project's task-board fixtures there.
The test account must exist in that data.

Open the preview. Sign in at `/login`, then open `/board`. Add a task named "Review the board" and
observe it in the list. Mark it complete and observe its completed state. Reload the board and
observe that the same task is still complete. Keep a screenshot of that state and a short video of
the flow. Remove only the task this check created.

Not tried during setup. A person must provide the test account before capture.
```

The agent assesses the real sign-in flow, including any external provider or email step. It says
when a test account is needed and what is missing. It also lists which resources each flow needs,
how to prepare data and which actions change it. Another agent should be able to follow the file
through your app, with observable results beside each action.

### Recipes and resources

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

Later sessions use these files to find the relevant user flow and choose
[proof artifacts](/guides/proof-artifacts/). If the app requires a login, supply a test account
through [project secrets](/guides/environment-variables/) or Doppler before asking for captures.
Every screen starts with a fresh browser profile, so the agent signs in again after it ends.
