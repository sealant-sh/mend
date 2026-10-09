# Mobile app

The phone app (`apps/mobile`, Expo) steers sessions and reviews changes away from the desk. A phone
pairs with a machine once, by scanning or typing the code the machine shows, and keeps its own
device token. Three tabs follow: Now (what waits on you, what runs, what recently settled),
Projects (start a claude or codex conversation per project, adopt a project) and Settings. A session
opens as a conversation with its header actions; the change opens as a review where comments are
written and sent back to the session as one edited instruction. On an unfolded or tablet screen the
layouts split into two panes. The app is not published: it is built from source, and the web build
is what a verification run drives.

## Sub-features

- `mobile-web-build` runs the app on the web for driving; native-only pieces are reported
  unreachable there.
- `mobile-pair` pairs with a machine: scan the QR (native), type the URL and code, or open the
  `pair?u=<url>&c=<code>` link.
- `mobile-now` lists `Needs you`, `Live` and `Recently settled`, with `Clear settled`; on a wide
  screen, `Preview` shows the picked session beside the list.
- `mobile-projects` lists adopted projects and starts a `claude` or `codex` conversation in each,
  with a worktree name, model, thinking, base and priority.
- `mobile-adopt` adopts a repository from GitHub discovery or a clone URL (see
  [Adopt a project](./adopt-project.md)).
- `mobile-session` shows a session's header actions (`Resume`, `Deliver follow-up`,
  `Review the change`, `Diff`, `Shell`, `More actions` → `Stop session`,
  `Replace this workspace now`) above its conversation.
- `mobile-conversation` sends turns, stops the open turn, answers approvals (`Allow once`,
  `Allow for session`, `Decline`) and questions, and attaches images.
- `mobile-review` reads the change at `/review/<change id>`: `Suggest fixes`, `Read this change`,
  the description and tour, line and change-level comments, `Send review`.
- `mobile-diff` reads the change's diff at `/diff/<change id>`.
- `mobile-shell` opens a shell in the session's worktree at `/terminal/<session id>?process=<id>`
  (native terminal; the web build cannot draw it).
- `mobile-terminal-embed` is the `/tty-embed` web page the native app's WebView terminal loads,
  with a single-use upgrade ticket.
- `mobile-pr-card` shows a landed change's pull request with `Open on GitHub` and `Refresh`.
- `mobile-settings` shows the pairing, `Test connection`, `Pair another machine`, `Unpair`, the
  Advanced token path, Theme, Text size, notifications and the secret files list.
- `mobile-rename-delete` renames or deletes a session by sliding its row left.
- `mobile-split` shows two sessions side by side in landscape or stacked in portrait when the
  screen's short side is at least 600 dp; compact screens show only the focused pane.

## How to get to it (user POV)

- Mobile (native): build from source; `pnpm --filter @mend/mobile ios`, `android` or `dev` with a
  development build. `mend pair` says so: `the app is apps/mobile — build it yourself; it is not
  published yet`.
- Mobile (web): `pnpm --filter @mend/mobile web` (`expo start --web`), served at
  `http://localhost:8081` by default (written `<expo>` below).
- Routes (expo-router): `/` (Now), `/projects`, `/settings`, `/pair`, `/adopt`, `/project/<id>`,
  `/session/<id>`, `/review/<change id>`, `/diff/<change id>`, `/terminal/<session id>`,
  `/split?ids=<id>`. The bottom tabs are `Now`, `Projects` and `Settings`.
- A pairing code comes from the machine: web Settings → Devices, or `mend pair [--url <base url>]`,
  which prints a QR of `mend://pair?u=<url>&c=<code>`, `✓ pairing code <ABCD-EFGH>`, the `url` and
  `expires in <n> min · one device, once`. The phone's camera opens that link straight into
  pairing. See [Pairing devices](./pairing-devices.md).
- A push notification about a session opens `/session/<id>` (native only).
- Web: the `/tty-embed?session=<id>&ticket=<ticket>` page of the web app is what the phone's
  terminal shows.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, signed in from the CLI, and `<project>` is adopted.
- The server admits the Expo web origin: its `MEND_ALLOWED_ORIGINS` holds `["http://localhost:8081"]`
  (with `APP_URL`, the only origins its CORS answers, `apps/api/src/public-network-cors.ts`). Without
  it every call from the web build is refused by the browser.
- `pnpm --filter @mend/mobile web` runs from a checkout with dependencies installed, and `<expo>`
  answers. Record the PID.
- Playwright runs a fresh context at `{ viewport: { width: 390, height: 844 } }`. On the web build the
  pairing lives in that context's local storage.
- A pairing code: run `mend pair --url <web>`; it prints `✓ pairing code <code>`. `--url` must match
  one of the server's configured URLs.
- A settled session with a change, from
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`. Note its session id
  `<id>`.
- For the conversation steps, `mend connect claude` has been run.

- **Unpaired Now.** Run `await page.goto("<expo>/")`. The tab `Now` is selected
  (`page.getByRole("tab", { name: "Now" })`), and the screen reads `Now`, `not paired`,
  `Pair this phone with your machine` and `no server · no token`.
- **Open pairing.** Run `await page.getByText("Pair with your machine", { exact: true }).click()`. The
  URL becomes `/pair`, the header heading reads `Pair device`
  (`page.getByRole("heading", { name: "Pair device" })`), and the screen reads
  `Pair with your machine`, `one code · one token · this device`,
  `code expires 10 minutes after it is shown` and
  `the camera rides the native app — type the code below`.
- **Type the code.** Run `await page.getByText("Type the code instead", { exact: true }).click()`,
  `await page.getByRole("textbox", { name: "https://mend.example.com" }).fill("<web>")` and
  `await page.getByRole("textbox", { name: "ABCD-EFGH" }).fill("<code>")`, then
  `await page.getByText("Pair", { exact: true }).click()`. The status reads `claiming…`; the app
  returns to `/`, whose line now reads `nothing waiting on you · <n> live` (or `<n> waiting`). A
  refused claim stays on the screen with the reason, for example
  `code not found — check it against the machine` or
  `code expired — generate a new one on the machine`.
- **Pair by link (alternative).** Mint a new code, then run
  `` await page.goto(`<expo>/pair?u=${encodeURIComponent("<web>")}&c=<code>`) ``. The screen claims
  on arrival and returns to `/`.
- **Settings after pairing.** Run `await page.getByRole("tab", { name: "Settings" }).click()`. It
  reads `paired · one connection`, `This phone is paired`, `<web>` and
  `<device name> · paired <YYYY-MM-DD>`. Run
  `await page.getByText("Test connection", { exact: true }).click()`. It reads `connected` and
  `connected · <n> projects`.
- **Second view of the pairing.** On the web, Settings → Devices lists the new device (see
  [Pairing devices](./pairing-devices.md)); the code is spent.
- **Projects.** Run `await page.getByRole("tab", { name: "Projects" }).click()`. The screen reads
  `Projects` and `<n> adopted`, then a panel per project with its name, its default branch and
  adopted sha, the field `worktree name — e.g. fix-auth (empty = auto)`, and one row per harness,
  `claude` and `codex`, each with its model summary and `Start`. Tap a harness name to expand
  its options. `model` appears when the catalog offers models, `thinking` when the selected model
  offers more than one effort choice, `base` when branches have been returned, and `priority`
  when the harness supports fast mode (codex).
- **Start a conversation.** In `<project>`'s panel run
  `await page.getByRole("textbox", { name: "worktree name — e.g. fix-auth (empty = auto)" }).first().fill("verify-phone")`,
  then click the `Start` of the `claude` row (the first `Start` in that panel). The app opens
  `/session/<id>`: the header title `claude`, the line `claude · <model> · <status> · <worktree>`,
  and at the bottom the field `Message the session…` with `Send`.
- **Send a turn.** Run
  `await page.getByRole("textbox", { name: "Message the session…" }).fill("List the files in this repository and change nothing.")`
  and `await page.getByText("Send", { exact: true }).click()`. The turn appears with its input;
  while it runs, `working…` shows and a `Stop` button sits beside `Send`.
  Check the composer, turn input and non-markdown items separately from assistant prose and plan
  text, which are unsupported on the web build and show `Error parsing markdown`. Report those
  markdown items as unreachable with that reason.
  `mend sessions --project <project> --json` lists the session with `"harness": "claude"`.
- **Header actions.** Run `await page.goto("<expo>/session/<id>")` for the `mend run` session. The
  header shows its title and line, and icon buttons named by their action:
  `page.getByRole("button", { name: "Review the change" })` and
  `page.getByRole("button", { name: "Diff" })`, plus `Resume` for an owner of a settled session,
  and `Shell` while the session runs. Past three buttons the rest wait behind
  `page.getByRole("button", { name: "More actions" })`, a menu of `menuitem`s; `Stop session` is
  only ever there, never a button.
- **Review.** Run `await page.getByRole("button", { name: "Review the change" }).click()`. The URL
  becomes `/review/<change id>`. The screen reads `review`, the branch as title, `VERIFY.md` with
  `+1 −0`, and the actions `Suggest fixes`, `Read this change` and `Send review`, and the card
  `No description yet. Composed when a session settles, or on demand.` with
  `Compose description & tour` (or the composed description with `Tour this change →`).
- **Change-level comment.** Run
  `await page.getByRole("textbox", { name: "Comment on the change as a whole…" }).fill("Say why VERIFY.md exists.")`
  and click its `Comment` (`page.getByText("Comment", { exact: true }).last()`). The comment shows
  under `change-level comments`.
- **Line comment.** Tap the added line's text (`page.getByText("verified", { exact: true })`). A
  composer opens under it, named `Comment on this line…`. Fill it and tap its `Comment`. The file
  header now reads `· 1 comment`.
- **Send review.** Run `await page.getByText("Send review", { exact: true }).click()`. A dialog opens
  with `Send review to the session`, `assembled from 2 comments · resumes <branch>`, and the editable
  instruction. Tap `Send to session`. It reads `Review delivered`, or
  `Follow-up saved for the session` with `Deliver it from the session once the current agent
  stops.` Tap `Done`. See [Send review back](./send-review-back.md) for what the session receives.
- **Diff.** Run `await page.goto("<expo>/diff/<change id>")`. The navigation header's heading reads `Diff`
  (the root stack's title) and the file shows its rows read-only.
- **Shell on the web build.** On a live session tap `Shell`. The app opens
  `/terminal/<session id>?process=<id>` with the heading `Shell` and a `Stop` on the right; the pane
  reads `React Native WebView does not support this platform.`. Report the shell as unreachable on
  the web build.
- **Terminal embed (web page).** Mint a ticket as the phone does:
  `curl -s -X POST <web>/api/upgrade-tickets -H "authorization: Bearer <token>" -H "content-type: application/json" -d '{"target":"tty-embed","session":"<live session id>"}'`
  (the token is the CLI's, from `<XDG_CONFIG_HOME>/mend/cli.json`). It answers JSON with `ticket`.
  Within thirty seconds run `await page.goto("<web>/tty-embed?session=<live session id>&ticket=<ticket>")`.
  The terminal fills the page; `connecting…` shows until the socket opens. Reloading the same URL
  spends nothing new: `/api/upgrade-tickets/exchange` answers 401 and the page posts
  `mend:embed-expired` to its host.
- **Clear settled.** On Now, under `Recently settled`, tap `Clear settled`: it reads
  `Remove <n>?`; tap again. It reads `Removing…`, then the shelf empties of what the server
  removed. Run `mend sessions --project <project> --all --json` to see what remains.
- **Proof.** For each screen, capture `await page.locator("body").ariaSnapshot()` and
  `await page.screenshot({ path })` at 390x844: unpaired Now, the pair form, paired Settings with
  `connected`, Projects, the session with its turn, and the review with both comments. Keep the
  `mend pair` and `mend sessions --json` transcripts.

## Gotchas

- Most controls are `Pressable`s without a role. React Native Web renders them as focusable `div`s
  with no `button` role, so `getByRole("button")` finds only the few that set one: the session
  header's icon buttons (`Review the change`, `Diff`, `Shell`, `More actions`, …), `Now` in the
  wide rail, `Close <title>`, `Attach an image`, `Remove <image>` and `Close the split`.
  Pull request links use
  `page.getByRole("link", { name: "Open pull request <n> on GitHub" })`
  (`components/session-row.tsx:134`). Every `EvButton` (`Pair`, `Start`, `Send`, `Comment`,
  `Send review`, `Clear settled`, `Test connection`, …), the chips, the Segmented choices, the
  `Advanced` row, the session rows and the diff lines are reached by text only. Finding:
  `components/button.tsx:47`, `components/start-session.tsx:34`, `:128`,
  `app/(tabs)/settings.tsx:42`, `:343`, `components/session-row.tsx:96`, `components/diff.tsx:114`.
- Every text field is named only by its placeholder: `https://mend.example.com`, `ABCD-EFGH`,
  `token` (a password field, not a textbox), `worktree name — e.g. fix-auth (empty = auto)`,
  `Message the session…`, `Write an answer`, `Comment on this line…`,
  `Comment on the change as a whole…`, `Session label`, `project-name`. The Send review
  instruction has neither label nor placeholder. Findings: `app/pair.tsx:222`, `:235`,
  `app/(tabs)/settings.tsx:376`, `:388`, `components/start-session.tsx:246`,
  `components/protocol-conversation.tsx:677`, `:376`, `app/review/[id].tsx:962`, `:1057`,
  `components/rename-session.tsx:70`, `app/review/[id].tsx:483`.
- Screen titles drawn by the app (`Now`, `Projects`, `Settings`, `Pair with your machine`) are text,
  not headings. Only the navigation header's title is a heading (`Pair device`, `Adopt project`,
  `Diff`, `Shell`), and the session and review screens hide that header.
- `Start` repeats for every harness of every project; nothing scopes it but order (claude, then
  codex, panel by panel). With more than one project, locate the panel by its project name first.
- `Stop session`, `Replace this workspace now`, the shell's `Stop` and the image chooser behind
  `Attach an image` use `Alert.alert`, which does nothing on React Native Web. These controls open
  nothing and do nothing on the web build. `Clear settled` and row deletion confirm in place with
  a second tap (`Remove <n>?` and `Really?`), so they do not share that limitation. Stop sessions
  with `mend stop <id8>` in a web run, and report the Alert-based controls as unreachable there.
  Sources: `components/session-pane.tsx:305`, `:332`, `app/terminal/[id].tsx:24`,
  `components/session-workspace.tsx:199`, `components/composer.tsx:181`;
  second-tap confirmations: `components/clear-settled.tsx:20`, `components/session-row.tsx:193`.
- The terminal is a native libghostty surface with a WebView fallback; neither runs on the web
  build, which shows `React Native WebView does not support this platform.`
  (`components/ghostty-terminal.tsx:288`). Drive `/tty-embed` in a browser instead, and say which
  entry point was driven.
- Native-only, unreachable on the web build: the QR scanner (`Scan the code` is replaced by
  `the camera rides the native app — type the code below`), the keychain (the web build keeps the
  token in the browser's storage), push notifications (`Enable notifications` answers
  `unavailable` with `push rides the native app, not the web build`), haptics, the native terminal,
  and OTA updates.
- Assistant prose and plan text are unsupported on the web build. Nitro's web implementation
  throws on access; the markdown renderer catches the parser failure and shows
  `Error parsing markdown`. Product gap. Sources:
  `react-native-nitro-modules/src/turbomodule/NativeNitroModules.web.ts:3`,
  `react-native-nitro-markdown/src/markdown.tsx:644`, `components/protocol-conversation.tsx:167`,
  `:189`. Check the conversation controls and non-markdown items separately.
- Rename and delete are only on a row's slide-left actions (`Rename`, `Delete` → `Really?`). A mouse
  drag may not trigger the swipe on the web build; rename a session with the CLI or the web app when
  it does not, and report the swipe as unreachable.
- `/project/<id>` has no way in from the app's navigation: Projects lists projects without linking
  to it. Reach it by URL. Finding: nothing pushes `/project/[id]` (`app/(tabs)/projects.tsx`).
- The phone starts only `claude` and `codex` sessions, always as conversations, without a prompt:
  the first turn goes through the composer. It cannot start or steer `opencode` or `pi`, nor attach
  to a terminal agent; a PTY session shows its transcript and a raw TTY composer.
- The phone does not land a change. It shows the pull request card (`Open on GitHub`, and
  `Refresh` for the change's owner) once Mend has landed.
- At 390x844 every screen is the compact layout. `Preview`, the session rail and `Split` need a
  window whose short side is at least 600 (`data/posture.ts`); use a second context of, for example,
  1024x768 to see them, and say so.
- `Unpair` clears the URL and token in this browser only; the device stays on the machine until it
  is revoked in Settings → Devices.
- A pairing code is single use and expires 10 minutes after it is shown. Mint a new one per claim.
