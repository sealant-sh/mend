# The terminal, desktop, mobile web and T3 drivers

`pnpm verify drive desktop|mobile-web|t3` starts these for you; the terminal (`drive-tui.sh`) is
driven by hand. Read this for what each driver needs and what it cannot show. In this file, Launch
is `pnpm verify stack up` and Cleanup is `pnpm verify stack down`. `$E` is the run's evidence
directory, `$P` its private directory, `$wt` its outer worktree and `$web` its tunnel;
`.verify/stack/current.json` names each for the run that is up.

**Terminal (the dashboard).** `drive-tui.sh` runs this machine's `mend`, built from a Mend checkout
at the commit under test, signed in to the stack through the tunnel as the stack's first account
(the token stays in `$P`), in a detached tmux session on a tmux server of its own:

```sh
$skill/scripts/drive-tui.sh build .            # this checkout, committed; again after each commit
$skill/scripts/drive-tui.sh start ui-1 "$web" -- mend ui
$skill/scripts/drive-tui.sh wait ui-1 'projects' 30 && $skill/scripts/drive-tui.sh keys ui-1 j Enter
$skill/scripts/drive-tui.sh capture ui-1 "$E/<feature>/tui" 01-selected
$skill/scripts/drive-tui.sh stop ui-1
pnpm verify drive tui --recipe <feature>        # records those captures as this commit's drive
```

`build` stamps the bundle with the checkout's commit and whether its tree was clean (`source.json`).
`drive tui` passes only for a clean bundle of the head, with every capture in `$E/<feature>/tui`
taken after that build.

`build` is needed because the dashboard cannot run from the CLI's TypeScript source; it bundles with
the checkout's own esbuild, so the checkout needs its dependencies installed (`pnpm install`).
`capture` keeps only the redacted screen, and a code the screen shows (`mend login`'s authorization
code and its `/authorize?code=` link, a pairing code) joins the registry by value first, so it is
redacted wherever it turns up next. Every `mend` typed in the terminal passes the guard: the bundled
CLI is reached only as the guard's real CLI. Lines a program prints before a full-screen redraw
(`mend attach`'s `✓ attaching to …`) are not on the screen or in its scrollback; take them from a
CLI capture of the same command instead.

**Desktop.** `drive-desktop.sh` starts the Electron app (a checkout's `apps/desktop`, built with
`pnpm --filter @mend/desktop build`) on an Xvfb display of its own, signed in through the same
config, with a remote debugging port; `drive-web.mjs --cdp` drives its window with the web's rules:

```sh
$skill/scripts/drive-desktop.sh start <checkout>/apps/desktop "$web" 9335 :95
node $skill/scripts/drive-web.mjs --web "$web" --cdp http://127.0.0.1:9335 --out "$E/<feature>/desktop" \
  --private "$P" --recipe <recipe.mjs>
$skill/scripts/drive-desktop.sh stop
```

The desktop's terminal draws on a canvas (its text is not in the page), so every screenshot masks
it: read a terminal's output from the session (`drive-tui.sh` on `mend attach`, or the record), not
from a screenshot.

**Mobile web.** `drive-mobile.mjs` serves the Expo app's web build and the stack's API on one local
origin (the stack trusts only its own origins), and `drive-web.mjs --viewport 390x844` drives it.
Pair the app with that origin the way the map's pairing recipe says. The server answers a pairing
with its own configured URL, which the web build could not call cross-origin, so the proxy puts its
own origin in that answer and prints `drive-mobile · pairing saved with <proxy>, not <server>`: the
app's `mend-config` keeps the proxy, and every later call goes through it. Once the proxy listens it
records itself in `$P/mobile.json` (its pid and start time, port, the server it fronts), and
`drive-web.mjs` takes `http://127.0.0.1:<port>` only while that process lives and the server it
fronts is the run's live tunnel or the declared outer; the guard and the other drivers never take
it. Start it with `MEND_VERIFY_PRIVATE` set to the `$P` that `drive-web.mjs --private` names.

A client pass on a release candidate drives the outer itself (the server under test): `--outer` in
place of `--web` fronts `MEND_VERIFY_OUTER_URL`, by the URL the CLI config names (its `https://` one
behind an edge; the proxy speaks TLS to it). A plain `http://` URL whose edge redirects to https
gets one line saying so.

```sh
node $skill/scripts/drive-mobile.mjs --app <checkout>/apps/mobile --web "$web" --port 18305 \
  --expo-port 8085 --log "$P.mobile.log" &   # a log beside $P, never in it
node $skill/scripts/drive-web.mjs --web http://127.0.0.1:18305 --viewport 390x844 \
  --out "$E/<feature>/mobile" --private "$P" --recipe <recipe.mjs>
# a client pass on the declared outer: --outer instead of --web "$web"
```

**Web app on the box.** `drive-mobile.mjs --client web --app <checkout>/apps/web --outer` serves the
web app from a checkout the same way: `vite dev` on `--expo-port` in place of Expo, with the app's
own server calling the API through the proxy (`MEND_API_URL`) and taking the browser's origin as its
own (`APP_URL`). It records itself in `$P/web.json`, which `drive-web.mjs` takes as it takes
`mobile.json`, and the recipe opens `http://localhost:<port>`. `pnpm verify drive web --box` does
all of this in front of the box (the declared outer server), waits for vite's first page, and signs
in on the app's own `/login` (SKILL.md, section 9). On a stack, `drive web` needs none of it: the
stack's image serves the app. A recipe that signs in on the app's page itself types the account
through `account` (`recipes/sign-in.mjs`).

Keep every log and profile **beside** `$P`, never inside it: every file under `$P` joins the secret
registry, a non-JSON one whole, and its text would then be redacted out of the evidence.

**T3 gateway.** The map's [t3-gateway.md](features/t3-gateway.md) starts the gateway from this
checkout against `$web` (`MEND_T3_GATEWAY_MEND_URL=$web`, a free port, its state file in a scratch
directory beside `$P`). `drive-t3.mjs` checks no URL the way the other drivers do: it reaches only
the gateway it is given, and the gateway reaches the Mend it was started against, so start it
against the run's tunnel and nothing else. Pair it from this machine, so no code or bearer passes
through a terminal, recorded or not: mint the code with the account's token and keep each answer in
`$P`, where the registry reads it.

```sh
curl -s -X POST "$web/api/me/devices/pairings" -H "authorization: Bearer $(jq -r .token "$P/account.json")" \
  -H "origin: $web" > "$P/pairing.json"
curl -s -o "$P/t3-token.json" -X POST "$gw/oauth/token" \
  --data-urlencode grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  --data-urlencode subject_token="$(jq -r .code "$P/pairing.json")" \
  --data-urlencode subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap \
  --data-urlencode requested_token_type=urn:ietf:params:oauth:token-type:access_token \
  --data-urlencode client_label=verify
jq -r .access_token "$P/t3-token.json" > "$P/t3-bearer.secret"
node $skill/scripts/drive-t3.mjs --gw "$gw" --bearer-file "$P/t3-bearer.secret" server.getConfig \
  | jq -c '.exit.value | {threadFind, threadFindProgressive, providers: [.providers[].instanceId]}' \
  > "$E/t3-gateway/config.json"
```

Keep the fields a step reads, never a whole answer: `server.getConfig` carries
`"sessionCookieName":"t3_mend_gateway_session"`, which the evidence scan reads as a credential
field, and Cleanup then deletes the file and fails the run.

A real t3code client drives the same gateway: `serve-t3-client.mjs` serves the hosted web build of
the pinned tag for the gateway (it refuses one not started against the run's tunnel, and records
itself in `$P/t3-client.json`), and `drive-web.mjs` drives that page with `recipes/t3-client.mjs`.
The map's **Driving the t3code client** says how to build it and what each step observed.

`drive-t3.mjs` makes one call of t3code's RPC per run, as a t3code client does: a fresh socket
ticket from the bearer, `/ws` with protocol 2 and `clientAppVersion` 0.1.0
(`--client-app-version none` leaves it out), then one `{"chunk":…}` line per streamed value
(`--chunks <n>`, default 1, then it interrupts the stream) and one `{"exit":…}` line. Exit 0 on
success, 1 on a typed failure, 2 on no answer (`--timeout`, default 15 s).
