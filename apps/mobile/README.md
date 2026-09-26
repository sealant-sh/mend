# @mend/mobile

The Mend mobile app — control and review, not an IDE (plan §4.6, §7.4): the Now inbox, project
status, live sessions, readable unified diffs, and review comments that return to the agent. Expo
SDK 57 / React Native 0.86, expo-router, React Compiler, typed routes.

## Run

```bash
pnpm --filter @mend/mobile dev        # Metro; the dev build (or Expo Go) connects to it
pnpm --filter @mend/mobile web        # run in a browser
npx expo export --platform web        # static web export (from apps/mobile)
```

## iPhone dev build (free personal team)

Store Expo Go lags the current SDK (App Store review), so the phone runs a development build
(`expo-dev-client`) signed with a free Apple personal team instead. Once installed, daily dev needs
only Metro on the Linux machine — the Mac is only for (re)building the shell.

On the Mac, once per native change (and weekly — free-team installs expire after 7 days):

```bash
npx expo run:ios --device            # from apps/mobile; prebuild + build + install over cable
```

First time: open `ios/Mend.xcworkspace` in Xcode → Signing & Capabilities → Team = your personal
team; on the iPhone enable Developer Mode (Settings → Privacy & Security) and trust the certificate
(Settings → General → VPN & Device Management). The iOS bundle id is `com.yiannisp.sealant.mend` and
the Android package is `com.yiannisp.mend`, both in `app.json`.

Then on Linux: `pnpm --filter @mend/mobile dev`, and open the Mend dev build on the phone — it
discovers Metro on the LAN (port 8081 must be allowed through the firewall), or connect to the
machine's address by hand.

## Builds and updates

The app is not in the App Store or Google Play. `eas.json` defines three EAS build profiles:
`development` (the dev client, internal distribution), `adhoc` (internal distribution) and
`production`. `app.json` points `expo-updates` at an EAS Update URL with a fingerprint runtime
version, so JavaScript-only changes can reach an installed build as an over-the-air update on its
channel.

## Design

Evidence Review, same family as web (`DESIGN.md` at the repo root). Tokens come from
`@mend/ui/tokens` — a TypeScript transcription of the CSS sheet in
`packages/ui/src/styles/globals.css`; keep the two in sync. Fonts are loaded in
`src/app/_layout.tsx` (Inter, Space Grotesk, JetBrains Mono via Expo Google Fonts). Light and dark
are the same structure; scheme comes from `useEvidenceTheme()` in `src/theme/evidence.ts`.

## Data

The app talks to a Mend server over its HTTP API. `src/data/live.ts` holds the server URL and a
token stored on the device, minted by pairing (`src/data/pairing.ts`, the `mend pair` QR or code) or
typed in by hand, and adapts the API's sessions, projects and changes for the screens.
`src/data/review.ts` reads changes and posts review comments, `src/data/tty-socket.ts` holds the
`/api/tty` WebSocket for the terminal, and `src/data/notifications.ts` registers the device for
notifications. `src/data/review-routes.test.ts` checks the routes the review layer calls against
`@mend/api-contracts`.
