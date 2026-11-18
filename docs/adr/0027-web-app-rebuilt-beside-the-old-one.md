# The web app is rebuilt beside the old one

Status: accepted 2026-11-16 (the plan) and 2026-11-17 (the order of work); in progress. Yiannis
agreed the plan "Mend redesign: the plan, step by step" (Linear project "Web redesign") on
2026-11-16 and said to start the code on 2026-11-17. The renames landed in #1774 and the lint rules
in #1775; the new kit (#1779, SLNT-1090) and the new app with no routes (#1777, SLNT-1093) are open.
Read against Mend `732269db61`. Builds on [ADR 0025](0025-one-home-per-setting.md) (settings) and
[ADR 0026](0026-tabs-and-tiles.md) (session screens); the look is `DESIGN.md`.

## Context

Mend's web app is moving to a new design, Sheet, drawn screen by screen on the Doop canvas "Mend".
The new design changes the structure of nearly every screen, not only its colours: the sidebar is
the only inbox, a session screen is a workspace of tabs and tiles, and settings lose inheritance.

The current app and its kit are shared. Desktop, marketing, mobile and the API use the same UI kit,
and people use the web app every day. Restyling the kit changes all of them at once. Rewriting the
web app in place leaves it half old and half new for weeks.

## Decision

### 1. Two apps, two kits, until cut-over

- The current app is `apps/web-old` (`@mend/web-old`) on `packages/ui-old` (`@mend/ui-old`). It
  keeps serving people until cut-over, and is frozen: it takes only Fix Now bugs. Desktop,
  marketing, mobile and the API stay on `@mend/ui-old` and must look and behave exactly as today.
- The new app is `apps/web` (`@mend/web`) on a fresh `packages/ui` (`@mend/ui`): the latest shadcn
  (`base-nova` on Base UI), generated anew and themed to Sheet. It starts with no product routes.

### 2. One route or one feature per PR, in the list's order

The new app gains one route, or one feature of a large route, per PR, in the order of the PR list
(Linear document "Mend web rebuild: the list of PRs", 58 PRs). The order follows the canvas pages:
onboarding, the sidebar inbox, starting a session, answering the agent, tabs and tiles with the
workspace views, review and landing, getting around, working with others, sessions sharing a
workspace, and settings last. Before the routes, the shared components are built on the kit.

Every old route and every feature in the verify skill's feature map is accounted for in that list:
rebuilt in a named PR, folded into another, or deliberately dropped. Each PR builds its screen in
light and dark and at phone width.

### 3. Copy, don't share

The tRPC routers and the tested logic in the old app's `lib` are copied into the new app as a route
needs them, with their tests. The two apps share no source.

### 4. The lint rules hold only the new code

`tooling/oxlint-plugin-mend` and the rules `.oxlintrc.json` sets for `apps/web/**` and
`packages/ui/**` (query states, router default states, no raw colours, no off-scale type or radii,
React, hooks, accessibility and import boundaries) run on the new app and kit only, with no disable
comments. The old app's code is not held to them.

### 5. Each route PR is proved on a local stack that serves the new app

A route PR owes a judge and a run, as every feature does (`AGENTS.md`, "Run a Feature Before It
Merges"). The run uses a local stack from the PR's commit with the new app served beside it
(`pnpm verify drive new-web`, which comes with the new app in #1777), and its screenshots show
light, dark and 390px.

### 6. What ships is the old app until cut-over

The Docker images, the published CLI's bundle, the bundle supervisor and `scripts/serve.mjs`, the
Helm chart and CI's browser checks keep building and serving `apps/web-old`. `pnpm dev` starts the
old app; `pnpm dev:web` starts the new one on its own port against the same API.

### 7. Cut-over

The new app becomes what ships once all of these are true:

1. Every old route and feature is accounted for in the list: rebuilt, folded into another PR, or
   dropped on purpose.
2. A box check of the whole new app passes: Mend's preview server, used as a person through every
   flow.
3. The images, the CLI bundle, the Helm chart, `pnpm dev` and the verify stack's web surface move to
   `apps/web`.

After cut-over `apps/web-old` is deleted. `packages/ui-old` is deleted once desktop, marketing and
mobile no longer need it.

### 8. Owner rulings carried by the rebuild

Made while the canvas was finished, each recorded here because the new app builds it:

- **Agent logins are connected with `mend connect claude|codex` run on the person's computer**
  (2026-11-17), shown with a Copy button. Mend's apps take no part in a provider's sign-in: no
  sign-in button, no pasted code, setup token, credentials file or `auth.json`. An API key is the
  second choice. Yiannis: "I don't want to intercept OAuth and be breaking terms."
- **Send always steers your own running turn** (2026-11-18). There is no "steer or queue" setting,
  and another person's turn is never steered. This keeps the 2026-10-24 rule that only a turn's
  sender may steer (`docs/decisions.md`), and drops the per-person value the server keeps for it.
- **The first account on a new server is its operator** (2026-11-18), as ADR 0003 already says for
  `single` tenancy and as the code does today.

## Considered options

- **Restyle the old app in place** (#1646, a draft: Sheet's colours, fonts and desk on the old app's
  token names, in slices). Rejected: Sheet changes the structure of nearly every screen, so a
  restyle keeps the old structure in Sheet's colours and each later slice reworks the same screens
  again, while people use an app that is half old and half new.
- **Delete the old routes first, then rebuild.** Rejected: people use the web app every day, and a
  gap between deleting a route and rebuilding it is a gap in the product.

## Consequences

- For the length of the rebuild there are two web apps and two kits. A small fix to the old app
  matches its own look (`docs/design-evidence-review.md`).
- A copied router or `lib` module can drift between the two apps. That is accepted until the old app
  is deleted.
- Each route PR is small enough to judge and run on its own, and the list says what is left.
- The new words (Waiting on you, To review, Running, Snoozed, Done, Idle) and the new settings names
  are in ADRs 0025 and 0026 only. The public glossary and the docs site describe what ships, so they
  change at cut-over or when each screen ships.
