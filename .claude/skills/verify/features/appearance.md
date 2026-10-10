# Appearance

Mend's light and dark themes are one structure in two palettes. Each client keeps its own theme
choice, `System`, `Light` or `Dark`, on the device: the web app and the desktop app store it in the
browser's local storage and toggle a `dark` class on the page, and the phone stores it with its text
size. `System` follows the operating system and tracks its changes live. The terminal dashboard has
one fixed dark palette and no setting.

## Sub-features

- `theme-web` picks System, Light or Dark on the web Settings page.
- `theme-desktop` picks system, light or dark under the desktop app's Appearance section.
- `theme-mobile` picks System, Light or Dark on the phone's Settings screen.
- `text-size-mobile` picks the phone's text scale: S, M, L or XL.
- `theme-system` follows the operating system's color scheme while `System` is chosen.
- `theme-persist` keeps the choice on that device across reloads.

## How to get to it (user POV)

- Web: `Settings` in the primary navigation opens `/settings`; the first panel is `Theme`.
- Desktop: the titlebar's `Settings` link (or `Ctrl+,` from the cockpit) opens Settings; the
  `Appearance` section has the `Theme` row.
- Mobile: the `Settings` tab; the panel with `Theme` and `Text size`.
- TUI: no setting. The dashboard and review screen always use the Ayu Mirage palette.
- VS Code: follows the editor's own theme; Mend has no setting there. Slack: none.

## Driving it with verify

Preconditions:

- Web: Mend is healthy at `<web>` and the browser is signed in. Start from a fresh browser context,
  so local storage holds no `mend-theme` key.
- Desktop: the Electron app is running with a remote debugging port and Playwright is attached
  through CDP, per the README's driving conventions.
- Mobile: the Expo web app is running (`pnpm --filter @mend/mobile web`) in Playwright at 390x844.
  The theme panel shows whether or not the phone is paired.

- **Web: open.** Run `await page.emulateMedia({ colorScheme: "light" })` and
  `await page.goto("<web>/settings")`. The heading `Theme` is visible with the buttons `System`,
  `Light` and `Dark`. `await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)` passes.
- **Web: system follows the OS.** Run `await page.emulateMedia({ colorScheme: "dark" })`. Without a
  reload, the `html` element gains the class `dark`.
- **Web: pin light.** Run `await page.getByRole("button", { name: "Light", exact: true }).click()`.
  The `html` element loses `dark` while the OS still reports dark, and
  `await page.evaluate(() => localStorage.getItem("mend-theme"))` returns `"light"`.
- **Web: pin dark.** Run `await page.getByRole("button", { name: "Dark", exact: true }).click()`,
  then `await page.emulateMedia({ colorScheme: "light" })`. The `html` element keeps `dark`. Reload:
  it still has `dark` before any interaction, and `mend-theme` is `"dark"`.
- **Web: back to system.** Run
  `await page.getByRole("button", { name: "System", exact: true }).click()`. `mend-theme` is
  `"system"` and the class follows the emulated scheme again.
- **Desktop: open.** Run `await page.getByRole("link", { name: "Settings" }).click()`. The heading
  `Settings` (level 1) and the heading `Appearance` are visible. The buttons `system`, `light` and
  `dark` sit in the `Theme` row; one reports `aria-pressed="true"`.
- **Desktop: pin dark.** Run
  `await page.getByRole("button", { name: "dark", exact: true }).click()`. It reports
  `aria-pressed="true"`, the others `false`, the `html` element has the class `dark`, and
  `localStorage.getItem("mend-theme")` is `"dark"`. Choose `light` and the class goes, while the
  terminal preview under `Terminal` stays dark.
- **Mobile: open.** Run `await page.getByRole("tab", { name: "Settings" }).click()`. The texts
  `Theme`, `System`, `Light`, `Dark`, `Text size`, `S`, `M`, `L` and `XL` are visible.
- **Mobile: pin dark.** Run `await page.getByText("Dark", { exact: true }).click()`. The screen's
  background turns dark in a screenshot, and
  `await page.evaluate(() => localStorage.getItem("mend-display"))` contains `"theme":"dark"`.
- **Mobile: text size.** Run `await page.getByText("XL", { exact: true }).click()`. The preview line
  `Everything scales with this — conversation, terminal, review. This line previews it.` grows, and
  `mend-display` contains `"textScale":1.2`. Choose `M` to restore `"textScale":1`, and `System` to
  restore the theme.
- **Proof.** For each surface, a screenshot with the page heading visible in each of light and dark,
  the ARIA snapshot of the theme controls, and the `mend-theme` or `mend-display` value read after
  each choice and after a reload.

## Gotchas

- The web `System`, `Light` and `Dark` buttons expose no pressed or selected state; the choice shows
  only by color. Read `mend-theme` from local storage, or the `html` class, as the observed state. A
  finding.
- The desktop theme buttons sit in a `group` with no accessible name, and the `Appearance` section
  is not a region. The names `system`, `light` and `dark` are lowercase and unique on the page
  today; the `Default harness` row's group beside it is just as unnamed.
- The mobile theme and text size options are pressables with no role, no accessible name of their
  own and no selected state; `getByRole` cannot reach them. Use `getByText` with `exact: true`. The
  `Theme` and `Text size` captions are plain text, not labels. A finding.
- Each client stores its own choice under its own origin: picking dark on the web does not change
  the desktop app or the phone, and a new browser context starts at `System`.
- The web page applies the stored class before first paint from an inline script, so a reload never
  flashes the other theme. Assert the class right after `goto`, before any click.
- The desktop terminal, the dashboard (`mend ui`) and the review screen stay dark whatever the
  theme.
