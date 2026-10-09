# Pair a device

A phone, or any second device, gets a token of its own without typing a password. A signed-in
machine mints a pairing code (from Settings → Devices on the web, or `mend pair`): a QR of a
`mend://pair` link, the grouped code, and the server URL the device should use. The code works for
one device, once, for ten minutes. The device claims it and keeps the token it gets back. Every
token holder (a paired phone, a token minted by hand, a terminal signed in with `mend login`, the
desktop app) is a listed device under Settings → Devices, and revoking one ends its token.

## Sub-features

- `pair-web` mints a pairing code with its QR, code, URL and countdown from Settings → Devices.
- `pair-cli` prints the same code, QR and URL in a terminal (`mend pair [--url]`).
- `mint-by-hand` mints a named device token shown once, for a device that cannot scan.
- `claim-mobile` claims a code in the phone app, by deep link, scan or typed URL and code.
- `device-list` lists every device with its platform, pairing day and last use.
- `revoke` ends one device's token from the list.
- `unpair-mobile` clears the URL and token on the phone only; the server keeps the device.
- `qr-render` is the hidden `mend qr <text>` the installer prints its QR with.

## How to get to it (user POV)

- Web: Settings (`/settings`, section `#devices`), the heading `Devices` with the buttons
  `Refresh`, `Mint a token by hand` and `Pair a phone`. The Now page links there as
  `Pair your phone · Settings → Devices` until a device is paired, and the first-run checklist row
  `Pair your phone` links `Settings → Devices`.
- CLI: `mend pair [--url <base url>]`; hidden from help, `mend qr <text>`.
- Mobile: the `pair` screen (`/pair`, title `Pair with your machine`), opened by a scanned or
  tapped `mend://pair?u=<url>&c=<code>` link, by `Pair with your machine` on Settings when unpaired,
  or `Pair another machine` when paired. Settings → `Advanced` takes a URL and a bearer token by
  hand; `Unpair` forgets them.
- Desktop: no pairing screen. Its sign-in makes it a device (see [Sign in](./sign-in.md)).
- Revocation: Settings → Devices `Revoke`; `mend logout` revokes its own terminal's device.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser is signed in, and the CLI is signed in (baseline). The
  CLI's own sign-in is already one listed device.
- The server has at least one configured public URL (`APP_URL`), which the pairing code names.
- For the mobile steps, the Expo web build runs at `<expo>` (`pnpm --filter @mend/mobile web`) in a
  390x844 viewport, signed out (no pairing saved in that browser profile), and `<expo>`'s origin is
  one of the server's allowed origins (`MEND_ALLOWED_ORIGINS`). Without it the browser refuses the
  claim and the phone reads `<url> unreachable — check the URL, port, firewall, same network`.
  `phone` below is the Playwright page on `<expo>`; `page` is the signed-in web browser.

- **Open Devices.** Run `await page.goto("<web>/settings#devices")`. The heading `Devices` is
  visible (`page.getByRole("heading", { name: "Devices" })`), with one line per device:
  `<name>`, then `<platform> · paired <day> · last used <when>`.
- **Pair from the web.** Run `await page.getByRole("button", { name: "Pair a phone" }).click()`.
  The button reads `Minting…`, then the panel shows `code` with a grouped code `XXXX-XXXX`, `url`
  with `<web>`, a countdown matching `/^expires in \d+:\d{2}$/` (it may start at `10:00` or
  `9:59`) whose value is lower a few seconds later, and the text
  `The QR encodes mend://pair?u=<url-encoded web>&c=<code>`. Run
  `await page.getByRole("button", { name: "Done" }).click()`; the panel closes.
- **Pair from the CLI.** Run `mend pair`. Stdout shows a block-character QR, then
  `✓ pairing code XXXX-XXXX`, `  url     <url>`, `  expires in 10 min · one device, once`,
  `  scan it in the Mend app, or enter the url and the code there by hand` and
  `  the app is apps/mobile — build it yourself; it is not published yet`. Exit `0`. Run
  `mend pair --url http://not-configured.invalid`: stderr reads
  `mend: --url must exactly match one of the server's configured pairing URLs`, exit `1`.
- **Claim on the phone.** With the code from `mend pair`, run
  `await phone.goto("<expo>/pair?u=" + encodeURIComponent("<url>") + "&c=<code>")`. The screen
  claims at once, shows `claiming…`, and lands on the Now tab. Run
  `await phone.getByRole("tab", { name: "Settings" }).click()`: the screen reads
  `This phone is paired`, `<url>` and `<device name> · paired <day>`.
- **Claim by hand.** Unpair first (below), mint a new code with `mend pair`, and run
  `await phone.goto("<expo>/pair")`. The screen shows `Pair with your machine` and, on the web
  build, `the camera rides the native app — type the code below`. Run
  `await phone.getByText("Type the code instead", { exact: true }).click()`, then
  `await phone.getByRole("textbox", { name: "https://mend.example.com" }).fill("<url>")` and
  `await phone.getByRole("textbox", { name: "ABCD-EFGH" }).fill("<code>")`, then
  `await phone.getByText("Pair", { exact: true }).click()`. The phone lands on the Now tab.
- **Refused claims.** Claim the same code again. The status line reads
  `code not found — check it against the machine` or
  `code expired — generate a new one on the machine`, and the phone stays on `/pair`.
- **Test the connection.** On the phone's Settings, run
  `await phone.getByText("Test connection", { exact: true }).click()`. The word `connected` and
  a line matching `/^connected · \d+ projects?$/` appear (`connected · 1 project` for one).
- **Second view.** Reload `<web>/settings#devices`. A new device with platform `web` is listed,
  `last used` recent.
- **Mint by hand.** Run
  `await page.getByRole("button", { name: "Mint a token by hand" }).click()`,
  `await page.getByRole("textbox", { name: "device name" }).fill("verify-by-hand")` and
  `await page.getByRole("button", { name: "Mint", exact: true }).click()`. The panel shows
  `device` `verify-by-hand`, `url`, and `token · shown once` with the token and a `Copy` button.
  The list gains `verify-by-hand` reading `other · paired <day> · last used never`.
- **Revoke.** Count `page.getByRole("button", { name: "Revoke" })`. Only when it is `1` is the
  row known: run its `click()`, then
  `await page.getByRole("button", { name: "Confirm revoke" }).click()`. The row disappears. With
  more devices listed, record this step as blocked by the missing name (Gotchas) and prove
  revocation with `mend logout` instead: its device disappears from the list after a reload.
- **Unpair on the phone.** Run `await phone.getByText("Unpair", { exact: true }).click()`. The
  phone's Settings reads `Not paired` and `no server · no token`. The web list still shows the
  phone's device until it is revoked there.
- **QR renderer.** Run `mend qr hello`: stdout is a block-character QR, exit `0`. Run `mend qr`:
  stderr reads `mend: usage: mend qr <text>`, exit `1`.
- **Proof.** Save `await page.locator("body").ariaSnapshot()` and a screenshot of Settings →
  Devices with the pairing panel open, after the phone's claim, and after the revoke. Save the
  phone's Settings screen before and after `Unpair`, and keep the `mend pair` and `mend qr`
  transcripts with exit codes.

## Gotchas

- Each device row's `Revoke` button is named only `Revoke`, and the row has no container role or
  label: with several devices the run cannot tell which one it is about to end. That is a finding;
  the button needs the device's name. The Members panel also has `Revoke` buttons (invitations) for
  an owner with pending invitations.
- The Devices panel is a plain `section` with an `id`, not a region: `Done`, `Cancel` and `Copy`
  repeat elsewhere on Settings. Act on them only while the panel they belong to is the one open.
- When the server lists more than one pairing URL, the panel's URL picker is a `select` with no
  label (a combobox with no accessible name). That is a finding. With one URL it is plain text.
- The QR itself is `aria-hidden`; the payload text beside it is what the run reads.
- The phone app's controls carry no roles. `EvButton`s (`Pair`, `Type the code instead`,
  `Test connection`, `Unpair`, `Pair with your machine`) render as focusable `div`s, not buttons,
  and the two inputs have no label: their names come from the placeholders `https://mend.example.com`
  and `ABCD-EFGH`. The `getByText` steps above are the only handle; each is a finding. The Advanced
  bearer-token input is a password input with only a placeholder (`token`).
- The phone's tab bar is the exception: its items are `role="tab"` named `Now`, `Projects`,
  `Settings`.
- The camera scan and the keychain are native-only. On the web build the scan path is unreachable
  and the pairing is stored in browser storage; report the native paths unreachable.
- `mend pair --url` takes only a URL the server already lists; it cannot add one. With none
  configured it fails with `the server returned no configured pairing URLs; configure APP_URL on the
  server`.
- Pairing claims are rate limited: repeated wrong codes read
  `too many attempts — wait a minute, then try again`.
- A device token acts as the whole account; scoped device permissions are planned, not built.
- The device a phone claims under is named from the browser's device facts on the web build, so its
  name is not predictable; find it by platform `web`.
