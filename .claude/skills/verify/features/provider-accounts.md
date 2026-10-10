# Connect provider accounts

Sessions run on the person's own subscriptions. Each account connects its own Claude, Codex and
GitHub logins to its platform user; nobody else's work spends them. `mend connect claude` and
`mend connect codex` make a login of Mend's own through the provider's flow (Claude in the browser,
Codex with a device code), send it to the server and keep no copy, so the person's own login on the
laptop is left as it is; `--use-my-login` sends the laptop's login instead, and both sides then
share it. GitHub sends `gh`'s token. The server refreshes the logins; one the provider refuses is
marked as needing a reconnect, and Mend says so in the web app, `mend accounts` and `mend doctor`.

## Sub-features

- `accounts-list` shows each provider as connected (with the account and a token suffix), needing a
  reconnect, or not connected (`mend accounts`, Settings → Connected accounts).
- `connect-grant` connects Claude or Codex with a login of Mend's own (`mend connect claude|codex`).
- `connect-my-login` sends the laptop's existing login instead (`--use-my-login`).
- `connect-stdin` connects from a pasted credential (`--from-stdin`).
- `connect-github` sends `gh auth token`.
- `connect-web` pastes a credential into Settings → Connected accounts (`Connect`, `Replace`).
- `disconnect` removes one provider (`--remove`, `Disconnect`).
- `reconnect-state` reports a login the provider refused, with the command that fixes it.
- `doctor-lines` reports each provider, and Mend's own Claude grant, in `mend doctor`.

## How to get to it (user POV)

- Web: Settings (`/settings#accounts`), the heading `Connected accounts`, one row each for `Claude`,
  `Codex` and `GitHub`. While nothing is adopted, the Now page's first-run row
  `Connect your accounts` reads `none connected` or `<n> connected` and links `Settings → Accounts`.
- CLI: `mend connect <claude|codex|github> [--use-my-login] [--from-stdin] [--remove]`,
  `mend accounts`, and the provider lines of `mend doctor`.
- Desktop: Settings (the title bar's `Settings` link) → `Connected accounts`, shown while signed in:
  the same three rows with `Connect`, `Replace` and `Disconnect`, taking a pasted credential.
- Session starts: in a per-person workspace a launch without the harness's login is refused with
  `Connect Claude to start a session here.`, or
  `Your Claude login needs reconnecting. Reconnect Claude to start a session here.`; a steered turn
  says `Connect Claude to steer this session.` (Codex alike).
- Mobile, VS Code and Slack offer no account controls.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI are signed in as the same account. For the
  desktop step, the desktop app runs with a remote debugging port, signed in as that account (it
  shares the CLI's credential file); `app` is its window's page from `chromium.connectOverCDP`.
- The run holds test credentials it may send to this disposable instance, each in a file in the
  private directory, so the secret registry holds them and no command line does: a GitHub token in
  `$P/github-token.secret`, and for the Claude and Codex steps a Claude setup token in
  `$P/claude-token.secret` and a Codex `auth.json` in `$P/codex-auth.json`. Never this machine's own
  logins: the verify skill's guard gives the CLI an empty home of the run's own and removes
  `GH_TOKEN`, `GITHUB_TOKEN` and every provider variable, so `gh` and the providers' files have no
  login there. The interactive `mend connect claude` and `mend connect codex` flows need a person at
  the provider's login page; without one, report them unreachable and use `--from-stdin`.
- Note what `mend accounts` lists first, and restore it at the end.

- **List.** Run `mend accounts`. Stdout starts with `platform user <id>`, then one line each for
  `claude`, `codex` and `github`: `not connected`, or
  `connected · <account> · …<suffix> · since <day>`. Exit `0`.
- **Connect GitHub.** Run `mend connect github`. Under the guard the CLI's home has no `gh` login,
  so it fails with the line below; record it. With a `gh` login, outside the guard, stdout ends
  `github   connected · <login> · …<suffix> · since <day>`, exit `0`: the skill does not drive that,
  since it would send this machine's own GitHub login. The failure reads
  ``mend: github: no credential on this machine — `gh auth login` first, or pipe a token: gh auth token | mend connect github --from-stdin``.
- **Connect from stdin.** Run `mend connect github --from-stdin < "$P/github-token.secret"`. The
  same `github   connected …` line prints. Run `mend connect github --from-stdin < /dev/null`:
  stderr reads `mend: nothing on stdin`, exit `1`.
- **Connect Claude and Codex.** Run `mend connect claude --from-stdin < "$P/claude-token.secret"`
  and `mend connect codex --from-stdin < "$P/codex-auth.json"`. Each prints its `connected` line; a
  Claude credential given as a JSON grant also prints
  `  access expires <time> · grant expires <time>`, and any MCP tokens in it stay on the machine
  (`  keeping <names> on this machine`).
- **Interactive Claude grant.** With a person present, run `mend connect claude` in its own PTY. It
  prints `  Mend needs its own Claude login; it is sent to your server and not kept here` and
  `  your own Claude login stays as it is`, then runs Claude's browser login. Afterwards it checks
  the machine's own Claude login and prints one of: `  your own Claude login still works · verified`
  (it is still logged in), or the line that starts
  `  your own Claude login was signed out by this one — this account allows one grant at a time.`
  (it was logged in before and is signed out now). If neither condition holds, including when the
  status check is unavailable, no personal-login status line prints. Then the `connected` line.
  Capture which status line printed, or its absence, as CLI output.
- **Interactive Codex grant.** With a person present, run `mend connect codex` in its own PTY. It
  prints `  Mend needs its own Codex login; it is sent to your server and not kept here` and
  `  your own Codex login stays as it is`, then hands the terminal to `codex login --device-auth`,
  whose own output gives the link and code to enter. After approval it prints the `connected` line;
  it prints no check of the machine's own Codex login. A failed login ends with
  `mend: codex: the login did not complete`, exit `1`.
- **Second view on the web.** Run `await page.goto("<web>/settings#accounts")`. The heading
  `Connected accounts` is visible, and each connected row's line reads `<account> · …<suffix>` in
  place of `not connected`. A connected row's buttons read `Replace` and `Disconnect`.
- **Doctor.** Run `mend doctor`. Lines match `/^✓ claude\s+connected/`, `/^✓ codex\s+connected/` and
  `/^✓ github\s+connected/` for connected providers, and
  `/^○ <provider>\s+not connected → mend connect <provider>/` for the rest.
- **Disconnect from the CLI.** Run `mend connect github --remove`. Stdout reads
  `github: disconnected`, exit `0`. Run it again: stderr reads `mend: github: nothing connected`,
  exit `1`. `mend accounts` lists `github   not connected`.
- **Connect from the web.** In the `GitHub` row, choose `Connect` (see Gotchas for picking the row),
  then run `await page.getByPlaceholder("gho_…").fill("<github-token>")` and press `Enter` (or
  choose the form's `Connect`). The button reads `Connecting…`, the form closes, and the row reads
  `<login> · …<suffix>`. `mend accounts` lists `github   connected …`.
- **Disconnect from the web.** Choose that row's `Disconnect`. It reads `…`, then the row reads
  `not connected` and `mend accounts` agrees.
- **Desktop.** In the desktop app (`app`, over CDP), keep Claude and Codex connected and GitHub
  disconnected after the web steps. Run `await app.getByRole("link", { name: "Settings" }).click()`.
  The heading `Connected accounts` is visible with rows `Claude`, `Codex` and `GitHub`; the GitHub
  row's hint reads ``Paste `gh auth token` — gives `gh` in every session a GH_TOKEN``. Run
  `await app.getByRole("button", { name: "Connect", exact: true }).click()`,
  `await app.getByPlaceholder("gho_…").fill("<github-token>")` and
  `await app.getByPlaceholder("gho_…").press("Enter")`. The submit reads `Connecting…`, the form
  closes, and the row's hint reads `connected · <login> · …<suffix>` with `Replace` and `Disconnect`
  beside it. `mend accounts` lists `github   connected …`. Run
  `await app.getByRole("button", { name: "Replace", exact: true }).nth(2).click()`, fill the same
  field and press `Enter` again; the form closes and the connected hint returns. `mend accounts`
  still lists `github   connected …`. Run
  `await app.getByRole("button", { name: "Disconnect", exact: true }).nth(2).click()`: the hint
  returns to the paste instruction and `mend accounts` lists `github   not connected`. Record both
  `.nth(2)` actions as positional, using the provider order in Gotchas. A refused credential shows
  an alert (`app.getByRole("alert")`).
- **Refused usage.** Run `mend connect gitlab`. Stderr reads
  `mend: usage: mend connect <claude|codex|github> [--use-my-login] [--from-stdin] [--remove]` and
  `       mend connect pi [--dir <path>] [--dry-run] [--remove]`; exit `1`.
- **Proof.** Save `await page.locator("body").ariaSnapshot()` and a screenshot of the
  `Connected accounts` section before and after each web action, and
  `await app.locator("body").ariaSnapshot()` with a screenshot of the desktop's section before and
  after its connect, replace and disconnect. Keep every `mend accounts`, `mend connect` and
  `mend doctor` transcript with its exit code. Restore the accounts noted at the start.

## Gotchas

- Every row's buttons are named only `Connect`, `Replace` or `Disconnect`, with no provider in the
  name and no row container role, on the web and the desktop alike. With two rows in the same state
  the run cannot tell them apart by role. That is a finding. Until it is fixed, the rows render in
  the order `Claude`, `Codex`, `GitHub`; a run that falls back to `.nth()` on that order must record
  the step as positional.
- The paste fields have no label. The Claude and Codex fields are textareas whose names come only
  from their placeholders (`sk-ant-oat01-…  or  { "claudeAiOauth": { … } }` and
  `{ "OPENAI_API_KEY": null, "tokens": { … } }`). The GitHub field and every desktop paste field are
  password inputs, which have no role at all: `getByPlaceholder` is the only handle. Each is a
  finding.
- While a row's form is open its top button reads `Cancel`; a form's own submit also reads
  `Connect`, so a page with an open form has more than one `Connect`.
- The state dot beside each row is `aria-hidden`; the state is in the text beside it
  (`not connected`, or `rejected by the provider — reconnect`).
- A refused login (`reconnect needed · the provider refused the login` in `mend accounts` and
  `mend doctor`) appears only after the server's refresh fails at the provider. A run cannot produce
  it on demand; report it unreachable unless the instance already holds such an account. ADR 0008
  also names the phone app as showing it; the phone app has no accounts view (product gap).
- `mend connect claude` and `codex` without `--use-my-login` never send the laptop's own login: they
  refuse when the new grant is the same one the laptop holds. `--use-my-login` prints
  `  --use-my-login: Mend and this machine will share one login, and whichever refreshes second is signed out`.
- `mend doctor` adds a `grant` line only while an older CLI's Claude grant copy is kept on the
  machine; current connects keep none, so its absence is expected.
- Connecting real credentials sends them to the instance under test, as the run's account. Use a
  disposable instance and credentials the run may spend.
- Signing in to Mend and connecting a provider are separate: `mend login` does neither for the
  other.
