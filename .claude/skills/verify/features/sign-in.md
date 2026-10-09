# Sign in

Every surface acts as one Mend account. The web app signs in with email and password at `/login`;
on a fresh instance the same page creates the first account, which becomes the owner of its
organization and the instance's operator, and registration then closes: everyone after joins by an
invitation link. The CLI and the desktop app never take a password: `mend login` (and the desktop's
`Sign in with the browser`) open an authorize request, the browser shows a code at `/authorize`,
and a signed-in person compares it with the terminal's and presses `Authorize`. The terminal then
holds a revocable device token, listed under Settings → Devices. Signing out revokes that token.

## Sub-features

- `first-account` creates the first account on a fresh instance, then asks for Git access
  (`/welcome`), then lands on the Now page's first-run checklist.
- `registration-closed` shows sign-in only once an account exists, with the invitation note.
- `web-sign-in` signs in with email and password, and returns to the page that asked (`?next=`).
- `web-sign-out` signs the browser out from the shell's `Sign out`.
- `cli-login` signs a terminal in through the browser authorize page (`mend login [--url]`).
- `authorize-page` shows the code, `Authorize` or `Deny`, and says when a code is spent or missing.
- `cli-logout` revokes the terminal's device and forgets its token (`mend logout`).
- `password-reset` sets a new password from a one-time `/reset/<token>` link an owner or the
  operator hands over.
- `desktop-connect` signs the desktop app in through the same authorize walk, or with a pasted
  token, and signs it out.

## How to get to it (user POV)

- Web: `/login` (any signed-out page walks there as `/login?next=<page>`). On a fresh instance it
  opens on `Create the first account`, then `/welcome` (`Git access`), then `/`.
- Web: the shell's `Sign out` button, in the sidebar at wide widths and the top strip below them.
- Web: `/authorize?code=<code>`, opened by `mend login` or the desktop app.
- Web: `/reset/<token>`, from `mend operator reset-link <email>` or an owner's `Reset password` on
  a member in Settings → Members.
- Web: `/join/<token>` creates an account from an invitation; see
  [Organization](./organization.md).
- CLI: `mend login [--url <server>]`, `mend logout`, and the sign-in line of `mend doctor`.
- Desktop: the `/connect` screen (`Connect to your Mend server`), reached when signed out, from the
  title bar's `mend · not connected` / `mend · token rejected` link, or Settings → Connection →
  `Manage`; Settings → Connection → `Sign out`.
- VS Code: `Mend: Connect to server` asks for a URL and a token, and otherwise reads the CLI's
  credential file. Not drivable yet: no VS Code harness exists for this map.

## Driving it with verify

Preconditions:

- `first-account` needs this run's own instance before any account exists. Every other step starts
  from the baseline (an account exists; the browser is signed in as `<email>` with `<password>`).
- Run the CLI under a disposable config home so its sign-in is the run's own:
  `export XDG_CONFIG_HOME=<tmp>/cli-home`. `mend login` writes `$XDG_CONFIG_HOME/mend/cli.json`.
- The desktop steps run the app with a remote debugging port (README, Driving conventions) and the
  same `XDG_CONFIG_HOME`, because the desktop and the CLI share one credential file. `app` below is
  the desktop window's page from `chromium.connectOverCDP`; `page` is the run's own browser.
- For password reset, `<email>` is an active operator account and the run holds its password;
  the first account on the instance is an operator. The logout and desktop sign-out steps before
  reset sign the CLI out, so sign it in again as that operator first. Without that account, report
  the reset step unreachable.

- **Create the first account.** On the fresh instance, run `await page.goto("<web>/login")`. The
  heading `Create the first account` is visible and the step list marks `01 Account` with
  `aria-current="step"`. Run `await page.getByRole("textbox", { name: "Name" }).fill("Verify")`,
  `await page.getByRole("textbox", { name: "Email" }).fill("<email>")`,
  `await page.getByLabel("Password", { exact: true }).fill("<password>")` and
  `await page.getByLabel("Password, again").fill("<password>")`, then
  `await page.getByRole("button", { name: "Create account and continue" }).click()`. The browser
  lands on `/welcome` with the heading `Git access`.
- **Finish first contact.** Run `await page.getByRole("button", { name: "Continue to Mend" }).click()`.
  The Now page shows the `First run` checklist with the rows `Git access`, `Sign the CLI in`,
  `Connect your accounts`, `Adopt a repository`, `Start a session`, `Pair your phone`.
- **Registration closed.** Run `await page.getByRole("button", { name: "Sign out" }).click()`. The
  browser lands on `/login` with the heading `Sign in` and the text
  `Accounts are created by invitation. Ask an owner of this Mend for a link.`
- **Wrong password.** Fill `Email` with `<email>` and the `Password` field with a wrong value, then
  run `await page.getByRole("button", { name: "Sign in" }).click()`. An alert appears
  (`page.getByRole("alert")`) and the URL stays `/login`.
- **Sign in and return.** Run `await page.goto("<web>/settings")` while signed out. The browser
  walks to `/login?next=%2Fsettings`. Sign in with the right password. The browser lands on
  `/settings` and the heading `Settings` is visible.
- **CLI login.** Run `mend login --url <web>` in the background and read its stdout. It prints
  `✓ authorize request open at <web>`, `  code    <XXXX-XXXX> · approve only if the browser shows the same code`,
  `  browser <web>/authorize?code=<XXXX-XXXX>` and
  `  waiting for approval… Ctrl-C stops; nothing is granted until someone approves`.
- **Authorize.** Run `await page.goto("<the browser line's URL>")`. The heading
  `Authorize this terminal?` is visible and the page shows the same grouped code. Run
  `await page.getByRole("button", { name: "Authorize" }).click()`. The heading reads `Authorized`.
  The CLI prints `✓ signed in as <email>`,
  `  this terminal is the device <hostname> · revoke it any time under Settings → Devices` and
  `  token saved to <path>/cli.json (0600)`, and exits `0`.
- **Spent and missing codes.** Reload the authorize URL. The heading reads
  `This code is not waiting`. Run `await page.goto("<web>/authorize")`. The heading reads
  `No code to authorize`.
- **Deny.** Run `mend login --url <web>` again, open its URL and run
  `await page.getByRole("button", { name: "Deny" }).click()`. The heading reads `Denied`; the CLI
  prints `mend: denied in the browser; nothing was granted` on stderr and exits `1`.
- **Second view.** Run `mend doctor`. A line matches `/^✓ signed in\s+token accepted/`. On
  `<web>/settings`, under the heading `Devices`, a device named `<hostname>` reads
  `cli · paired <day> · last used <when>`.
- **CLI logout.** Run `mend logout`. Stdout shows `✓ device revoked on <web>` and
  `✓ signed out · token removed from <path>/cli.json`; exit `0`. Run `mend projects`: stderr reads
  `mend: not signed in to <web> — run: mend login`, exit `1`. Reload Settings: the `<hostname>`
  device is gone.
- **Desktop connect.** Start the desktop app signed out. The screen shows the heading
  `Connect to your Mend server` and `Not signed in to a Mend server yet.` Run
  `await app.getByRole("textbox", { name: "Server URL" }).fill("<web>")` and
  `await app.getByRole("button", { name: "Sign in with the browser" }).click()`. The text
  `Approve in the browser if it shows this code` appears with the code, a button named by the
  authorize URL, and `Cancel`. Open that URL in the signed-in browser page and choose `Authorize`.
  The desktop leaves `/connect` for the cockpit; `mend doctor` from the same config home now
  reports `signed in` too, and Settings → Devices lists the desktop's device.
- **Desktop sign-out.** In the desktop, run
  `await app.getByRole("link", { name: "Settings" }).click()`, then
  `await app.getByRole("button", { name: "Sign out" }).click()`. The Connection row reads
  `Not signed in`. On `/connect` the same act is the button
  `sign out · revokes this device when it is one, removes the token`, after which the text reads
  `Signed out · the device was revoked on the server.`
- **Restore the operator CLI.** Run `mend login --url <web>` again and approve it at `/authorize`
  as in "CLI login", signed in to the browser as the operator `<email>`. `mend doctor` reports
  `signed in` again.
- **Password reset.** Run `mend operator reset-link <email>`, naming the operator's own account.
  Stdout prints `<web>/reset/<token>` and
  `password reset for <email> · works once · expires <day>`; exit `0`. Run
  `await page.goto("<that URL>")`: the heading `Set a new password` is visible. Run
  `await page.getByLabel("New password", { exact: true }).fill("<new password>")`,
  `await page.getByLabel("New password, again").fill("<new password>")` and
  `await page.getByRole("button", { name: "Set password" }).click()`. The browser lands on `/login`
  with the status `Password changed. Sign in with the new one.` Opening the link again and
  submitting shows the alert
  `This link is spent or expired. Ask an owner or the operator for a new one.`
- **After the reset.** Open `<web>/settings`: the browser walks to `/login`, because the reset
  ended every browser session for this account; sign in with `<new password>`. Run `mend doctor`
  from the CLI: its line still matches `/^✓ signed in\s+token accepted/`, because a reset does
  not revoke device tokens.
- **Proof.** Save `await page.locator("body").ariaSnapshot()` and a screenshot for `/login`
  (registration closed), `/authorize` before and after `Authorize`, and Settings → Devices before
  and after `mend logout`. Keep every `mend login`, `mend logout`, `mend doctor` and
  `mend operator reset-link` transcript with its exit code, and the desktop's `/connect` snapshot.

## Gotchas

- A password input has no ARIA role: `getByRole("textbox", { name: "Password" })` finds nothing.
  Use `getByLabel`. `Password` is a prefix of `Password, again` (and `New password` of
  `New password, again`), so pass `exact: true`. Revealing a password with `Show password` turns
  the field into a textbox; registration has two `Show password` buttons that share one state.
- The login page asks the instance before it renders a form, so wait for the heading, not the
  fields. The `Create an account` and `Have an account? Sign in` buttons are never shown: the server
  answers `registration: closed` whenever any account exists, and `open` only when none does.
- `mend login` with no `--url` reuses the configured URL (`MEND_URL`, then `cli.json`); only a
  machine never pointed anywhere asks for one, and only on a TTY. It polls until approval, so run
  it in the background or its own PTY. Without a TTY it does not open a browser; the run opens the
  printed URL itself.
- `mend login` and the desktop app write the same `cli.json`. Signing the desktop out signs the CLI
  out too, and the reverse. Without a disposable `XDG_CONFIG_HOME` the run overwrites the
  harness's own sign-in.
- `MEND_TOKEN` outranks the file. Under it the desktop's sign-out leaves the app signed in and says
  `Still signed in · MEND_TOKEN supplies this app's token…`.
- `mend logout` prints `nothing saved — already signed out` only when no `cli.json` exists at all;
  a second `mend logout` after the first prints the `✓ signed out` line again.
- A reset ends every browser session of the account (Better Auth's `revokeSessionsOnPasswordReset`);
  sign the browser in again afterwards. Device tokens are checked on their own: one stops working
  only when it is revoked or its account is deactivated, so the CLI, the desktop app and paired
  phones stay signed in through a reset. Run the reset step last.
- `mend operator reset-link` takes any account with that email that belongs to an organization,
  the operator's own included; it refuses an email with no such account
  (`No active account in an organization has that email.`). Owners reset members' passwords from
  Settings → Members instead (see [Organization](./organization.md)).
- The desktop `/connect` form has no accessible name, and its waiting state's link is a button
  named by the full authorize URL; read the URL from that button's text.
- The `Sign out` button in the web shell exists twice in the DOM (sidebar and top strip); only one
  is displayed at a time. Keep the default viewport (1280 wide) so the sidebar's is the visible one.
- Status lines on the setup pages (`key created · add it to your git account`) and the first-run
  checklist's marks (`not signed in yet`, `signed in · <name>`) are plain text, not `role="status"`.
