# Slack

A person writes `@mend <request>` in a Slack thread and Mend starts a session as that person, with
their provider logins and Git access, in the project it picks from the message, the thread, the
channel default or their own default. The session reports into the thread: a reaction, one status
message edited in place, the agent's messages, a summary with a `Review in Mend` button, and, when
the change lands, the branch and pull request. Each organization connects its own Slack app, made
from Mend's manifest and connected over Socket Mode, outbound only. A Slack user acts only after
linking their Mend account through a one-time link. Review stays in Mend.

## Sub-features

- `slack-connect` connects the organization's own Slack app in Settings → Slack: manifest, two
  tokens, `Check and connect`; replaces or removes it.
- `slack-display` sets the app's `Default harness`, `Agent messages`, `Diffs`,
  `Slack Connect channels` and `Land automatically`.
- `slack-link` links a Slack user to a Mend account through `/slack/link/<code>`; `Unlink`, and an
  owner's `Links` list with `Remove…`.
- `slack-default-project` sets `Your default project` for mentions that name none.
- `slack-mention` starts a session from `@mend <request>` with inline (`key=value`) or plain
  options.
- `slack-project-choice` picks the project (message, thread, channel default, personal default),
  says which decided, asks with buttons when nothing does, and offers `Switch project`.
- `slack-thread-report` reports into the thread: reactions, the status message, agent messages,
  questions, the end-of-session summary.
- `slack-follow-up` takes a later `@mend` in the thread as a follow-up, an answer, a resume or (with
  `new`) another session.
- `slack-commands` answers `@mend help`, `@mend settings`, `@mend list`, `@mend new <request>`.
- `slack-auto-land` lands a completed turn that asked for a change, unless the project, `autopr=` or
  the app setting says otherwise; otherwise offers `Push and open pull request` to the owner.

## How to get to it (user POV)

- Web: Settings → Slack (`/settings#slack`). Owners see the app section (connect, display settings,
  `Links`); everyone in an organization sees `Your Slack link` and `Your default project`. Nothing
  renders for an account in no organization.
- Web: `/slack/link/<code>`, opened from the `Link your Mend account` button Mend sends privately to
  an unlinked Slack user.
- Web: a project's `Land when a turn completes` setting decides before anything Slack says (see
  [Land a change](./land-change.md) and [Project settings](./project-settings.md)).
- Slack: `@mend <request>` in a channel thread or at the top of a channel, a direct message to the
  app (no `@mend` needed), `@mend help`, `@mend settings`, `@mend list`, `@mend new <request>`.
- Slack: the status message's `Open in Mend` and `Switch project`, the project buttons and the
  `Other…` list, `Review in Mend`, and `Push and open pull request` /
  `Push and update pull request`.
- Mobile: Settings → notifications has the switch `Sessions started from Slack`.
- CLI: none. Docs: `apps/docs/src/content/docs/integrations/slack.md`; ADR `docs/adr/0006-slack.md`.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, and the browser is signed in as the organization's `owner` (the first
  account on a single-tenancy instance).
- No Slack app is connected (Settings → Slack shows `Connect a Slack app`).
- The verify stack has no Slack workspace. Every Slack-side step is `not drivable yet`: a mention, a
  link code, the thread's messages and a connected app all need a real Slack workspace and its two
  tokens, and Mend has no fake Slack endpoint to point at. The web steps that need no Slack are
  drivable.

- **Open Settings → Slack (drivable).** Run `await page.goto("<web>/settings#slack")`. The heading
  `Slack` shows (`page.getByRole("heading", { name: "Slack", exact: true })`) with
  `Mention @mend in a Slack thread to start a session as yourself. …`. Scope the panel with
  `const slack = page.locator("section#slack")` (see Gotchas).
- **Manifest and steps (drivable).** The panel reads `Connect a Slack app`, four numbered steps
  starting
  `Create an app in Slack from this manifest (api.slack.com/apps → Create New App → From a manifest).`,
  and `manifest.json` above the manifest. The manifest has `"socket_mode_enabled": true`, the bot
  events `app_mention` and `message.im`, and ten bot scopes, and names no URL. With clipboard
  permissions granted (`context.grantPermissions(["clipboard-read", "clipboard-write"])`), run
  `await slack.getByRole("button", { name: "Copy" }).click()`: `Copied` appears beside it.
- **A token the wrong way round (drivable).** Run
  `await slack.getByLabel("app-level token").fill("xoxb-not-an-app-token")` and
  `await slack.getByLabel("bot token").fill("xoxb-not-a-real-token")`. `Check and connect` becomes
  enabled. Run `await slack.getByRole("button", { name: "Check and connect" }).click()`. An alert
  (`slack.getByRole("alert")`) reads
  `The app-level token starts with xapp-. Generate one under Basic Information → App-Level Tokens.`
  Nothing is saved: reload, and the panel still reads `Connect a Slack app`.
- **Tokens Slack refuses (drivable where the host reaches slack.com).** Fill `xapp-1-not-real` and
  `xoxb-not-real`, then `Check and connect`. The button reads `Checking with Slack…`, then an alert
  gives Slack's refusal (`Slack refused the …` or `Slack answered … for the …`), or, without a route
  to Slack, `Slack did not answer for the …: …. Nothing was saved.`. The panel still offers
  `Connect a Slack app`.
- **Your Slack link, no app (drivable).** Under `Your Slack link` the panel reads
  `Slack is not connected to this organization.` and offers no `Unlink` and no
  `Your default project`.
- **A link code that does not work (drivable).** Run
  `await page.goto("<web>/slack/link/not-a-real-code")`. The heading reads `This link does not work`
  (`page.getByRole("heading", { name: "This link does not work" })`), with
  `A link works once, for ten minutes, and only for members of the organization that connected that Slack workspace. …`.
- **Connect the app.** `not drivable yet` (needs a Slack workspace). With real tokens,
  `Check and connect` checks the bot token with `auth.test` and the app-level token with
  `apps.connections.open`. End state: the panel shows the workspace name, a line
  `<team id> · app <app id> · bot <bot user id> · connected by <name> <day>`, `links open <web>`,
  `Replace tokens…` and `Remove…`, then `Default harness` and the four On/Off settings, then `Links`
  with `no links yet`. The organization's audit log records the connection.
- **Display settings.** `not drivable yet` (needs a connected app). Press a setting's `On` or `Off`
  (`aria-pressed` marks the current one). End state: the setting's line changes to its other
  sentence, for example `Land automatically` off reads
  `A completed turn pushes nothing. The thread offers the owner “Push and open pull request”.`, and
  the audit log records the change (`slack.settings_changed`).
- **Mention and link.** `not drivable yet` (needs Slack). An unlinked user's
  `@mend fix the flaky login test` gets a reply only they see with `Link your Mend account`. End
  state on the web: `/slack/link/<code>` shows the Slack person as the heading,
  `<slack user id> · <team> · expires <time>`, `runs once linked` with the request, and the button
  `Link <person> to my account`; pressing it reads
  `Linked in <team>. Mend runs your request and answers in the thread.` with `Slack settings`.
  Settings → Slack then reads `Linked as Slack user <id> in <team>.` with `Unlink`.
- **Project choice and the thread.** `not drivable yet` (needs Slack). End state in Slack: ⏳ on the
  request, a status message such as `<project> · from the thread · claude · running · mend/<name>`
  naming which source decided (`named in the request`, `the thread's session`,
  `from a link in the thread`, `from the thread`, `channel default`, `personal default`, `picked`),
  and ✅ or ❌ when it settles. When nothing answers, buttons for the likeliest projects and
  `Other…`, which only the requester can press. In Mend, the session is the requester's and runs
  `claude` or `codex` in protocol mode (`mend sessions --all --json`).
- **Follow-up, commands and landing.** `not drivable yet` (needs Slack). A second `@mend` in the
  thread is a turn on the thread's latest session; `@mend new …` starts another; `help`, `list` and
  `settings` answer privately. With `Land automatically` on, a completed turn that asked for a
  change adds `pushed · mend/<name> · pull request #<n> · opened` to the status message; Mend's Land
  panel shows the same landing (see [Land a change](./land-change.md)).
- **Proof.** For the drivable steps, capture the Slack panel (`await slack.ariaSnapshot()` and a
  screenshot) before and after each refused connect, and the link page. Report every Slack-side step
  as `not drivable yet: no Slack workspace in the verify stack`.

## Gotchas

- The Slack panel is a `section` with an `id` but no accessible name, so it is not a region, and its
  buttons share names with other panels on the settings page: `Copy` (devices, git key), `Remove…`
  (organization members), `On` and `Off` (instance defaults). Scope by `section#slack`, Mend's own
  anchor (the link page navigates to it). Finding:
  `apps/web/src/components/organization-settings.tsx:75`.
- Inside the panel, the four display settings each have an `On` and an `Off` button with nothing to
  tell them apart but order, and `Default harness`'s choices are named only by the harness. The rows
  are not groups. Finding: `apps/web/src/components/slack-settings.tsx:378`, `:355`.
- The token fields are password inputs, so they are not textboxes; reach them with
  `getByLabel("app-level token")` and `getByLabel("bot token")`, which their wrapping labels name.
- `Your default project` is a select named by its `aria-label`; it appears only once the
  organization has a Slack app.
- The refusal alerts carry the error's tag in front of the sentence:
  `SlackRejected: The app-level token starts with xapp-. …` and
  `SlackRejected: Slack refused the bot token (invalid_auth).` (2026-10-10). Match the sentence
  inside the alert. A product gap: an internal error name shown to the person.
- `/slack/link/<code>` has a `main` landmark since mend#663 (`SetupFrame`); the live pass saw none
  before it. Scoping its checks to the heading holds either way.
- Clicking `Check and connect` with well-formed tokens calls Slack from the server. A stack without
  outbound network answers `Slack did not answer …`; that is the server's honest report, not a
  defect.
- A session started from Slack carries its origin on the server, but no Mend surface shows it: the
  web session page, the CLI's `mend sessions --json` and the phone have no origin field. The
  organization's audit log records each session started from Slack. Product gap.
- Channel defaults are set and read only in Slack (`@mend settings`). Settings → Slack lists links
  but not channel defaults.
- Approvals are answered in Mend, not from Slack (ADR 0006, open question 2): the thread shows a
  status line with a link.
- `model=` and `effort=` on a follow-up are not applied; Mend says so privately.
- `Land automatically` is overruled by a project whose `Land when a turn completes` is off, and
  `autopr=` decides for one request. A request read as a question never lands.
