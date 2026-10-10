# Doctor and the debug bundle

`mend doctor` reads this machine's setup and prints one line per fact: the server, the sign-in, the
platform connection, each provider account, Mend's Claude grant when it keeps one, the projects, the
provider CLIs on this machine, the exposure, the server host's user namespaces and this machine's
Docker shutdown timeout. Many unfinished lines end with `→` and what to do next: a `mend` command, a
provider's own login command, or an instruction in words. Some end with nothing. It changes nothing,
and it exits `1` only when a line is `✗`. `mend doctor --bundle` writes the same facts and much more
into one redacted `tar.gz` with mode 0600, for a bug report. The web Settings page shows the
platform connection as its own panel, checked live.

## Sub-features

- `doctor-checklist` prints the fact lines with `✓` observed, `○` not set up yet, `✗` cannot run.
- `doctor-fix-commands` ends an unfinished line with `→ <fix>` where the doctor knows one: a
  command, or an instruction in words.
- `doctor-exit-code` exits `1` when any line is `✗`, `0` otherwise.
- `doctor-bundle` writes the archive, prints its path, each file with its size, and a notice.
- `doctor-bundle-redaction` runs one pattern redactor over every file: header values, `Bearer`
  tokens, known token shapes, passwords in URLs, values of secret-named keys, and `NAME=value`
  values.
- `doctor-bundle-options` takes `--out <path>` and `--tail <n>` (1..2000, default 500).
- `doctor-web-connection` shows the Sealant connection on `/settings`, with `Check again`.

## How to get to it (user POV)

- CLI: `mend doctor`.
- CLI: `mend doctor --bundle [--out <path>] [--tail <n>]`.
- CLI: `mend help doctor` for the page; `mend server setup`, `mend login` and the install docs point
  at `mend doctor` after setup.
- Web: `Settings` in the primary navigation (`/settings`), the `Sealant connection` panel at the
  bottom of the page. It reports the same platform connection as the doctor's `sealant` line, not
  the other lines.
- TUI, desktop, mobile, VS Code and Slack: not a surface for this feature.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the CLI is signed in to it (`mend login --url <web>`), and the browser
  is signed in for the web step.
- The run knows the token `mend login` saved: read `token` from `$XDG_CONFIG_HOME/mend/cli.json` (or
  `~/.config/mend/cli.json`) and keep it as `<token>` for the redaction check. Never print it in
  evidence.
- `<evidence>` is the evidence directory the `verify` skill names, writable by the run.

- **Checklist.** Run `mend doctor`. Stdout prints one line per fact, each a mark, a label padded to
  eleven columns, and the detail. With this instance up and signed in it shows `✓ server` with
  `<web> · mend <version>`, `✓ signed in` with `token accepted`, and `✓ sealant` with
  `connected · <platform url>`. Then `claude`, `codex` and `github` lines (`connected`,
  `connected · <login or email>`, or `○ … not connected → mend connect <provider>`), `projects`
  (`<n> adopted`, or `○ projects    none adopted → mend adopt`), `claude cli`, `codex cli` and
  `gh cli` (`not on PATH`, `on PATH · credential present`, or
  `on PATH · no credential here → claude setup-token` / `codex login` / `gh auth login`), and an
  `exposure` line starting `declared <exposure> · <scheme> origin`. A `workspaces` line follows when
  the server reports its host, and a `docker` line when `docker` is on this machine's `PATH`. Exit
  code `0` unless a line is `✗`.
- **Fix commands.** Pick a `○` or `✗` line that ends with `→ `, for example
  `○ codex       not connected → mend connect codex` or `○ projects    none adopted → mend adopt`.
  What follows the arrow on those lines is a `mend` command that `mend help` lists. Other arrows are
  the provider's own login (`claude setup-token`, `codex login`, `gh auth login` on the `cli` lines)
  or an instruction in words (`start the Mend server`,
  `serve it over https and set APP_URL to that origin`, `on the server's host: …`, the `docker`
  line's `set "shutdown-timeout": …`). Lines with no arrow at all exist too: `not checked`,
  `not on PATH`, `GET /projects → <status>`, `shutdown-timeout not observed · …`. Assert which kind
  each line is; do not expect a command on every line.
- **Rejected token.** Run `MEND_TOKEN=verify-not-a-token mend doctor`. The second line reads
  `✗ signed in   token rejected → mend login`, the lines that need a sign-in read `○ … not checked`,
  and the exit code is `1`.
- **Unreachable server.** Run `MEND_URL=http://127.0.0.1:9 mend doctor`. The first line reads
  `✗ server      cannot reach http://127.0.0.1:9 → start the Mend server`, the next reads
  `○ signed in   not checked`, and the exit code is `1`. Each HTTP request the doctor makes is cut
  off after three seconds; the command as a whole has no bound (the local `gh auth token` and the
  Docker probe are not timed by it).
- **Bundle.** Run `mend doctor --bundle --out <evidence>/doctor/bundle.tgz --tail 50`. Stderr reads
  `collecting · this can take a minute`. Stdout reads `<evidence>/doctor/bundle.tgz · <size>`, one
  line per file with its size (`cli.json`, `doctor.txt`, `server-health.json`, `sessions.json`,
  `docker.txt` when this machine's Docker answered or `docker.error.txt` when it did not, and the
  rest), and last
  `Contains logs and configuration; secrets are redacted, but read it before sharing.`. Exit code
  `0`.
- **Archive facts.** Run `stat -c %a <evidence>/doctor/bundle.tgz`. It prints `600`. Run
  `tar -tzf <evidence>/doctor/bundle.tgz`. Every entry sits under `bundle/`. On a machine with no
  local server, `bundle/server-config.error.txt` and `bundle/server-logs.error.txt` are present and
  read `no Mend server is installed on this machine (mend server setup installs one)`.
- **Token absent.** Run `tar -xzOf <evidence>/doctor/bundle.tgz | grep -c -F '<token>'`. It prints
  `0` (grep exits `1`). `bundle/cli.json` records `tokenSaved`, never the token, and the names of
  the `MEND_` variables in the environment without their values. This proves the token is absent
  from the archive; it does not prove the redactor removed it, since no collector writes the saved
  token in the first place.
- **Redactor at work.** Find a pattern the redactor covers in what the bundle collected, for example
  an `Authorization` or `Bearer` value in a recorded session's output, or a `NAME=value` line in a
  container log. In the archive the value reads `[redacted]` and the key or prefix stays.
- **Usage errors.** Run `mend doctor --bundle --tail 0`. Stderr reads `mend: --tail is 1..2000`,
  then `usage: mend doctor` and `       mend doctor --bundle [--out <path>] [--tail <n>]`. Exit code
  `1`, and no archive is written.
- **Web panel.** Go to `<web>/settings`, or from any page run
  `await page.getByRole("link", { name: "Settings", exact: true }).click()`. The heading `Settings`
  (`page.getByRole("heading", { name: "Settings", level: 1 })`) shows, and further down the heading
  `Sealant connection` (`page.getByRole("heading", { name: "Sealant connection" })`) with the text
  `A live round-trip to the control plane, checked from this instance.`. Its status reads
  `Connected · observed`, `Unauthorized`, `Responded · surface mismatch` or `Unreachable`, beside
  `control plane <url>` and `checked <time>`.
- **Check again.** Wait at least one second after the page loaded, then run
  `await page.getByRole("button", { name: "Check again" }).click()`. The button reads `Checking…`
  and is disabled, then reads `Check again`, and the `checked` time is later than before. The time
  is shown with `toLocaleString()` to the second, so two checks within one displayed second look
  identical; that is not a missed check.
- **Proof.** Keep the `mend doctor` transcripts (plain, rejected token, unreachable server) with
  their exit codes, the `--bundle` transcript, the `stat`, `tar -tzf` and redaction-grep outputs,
  and the archive itself under `<evidence>/doctor/`. For the web panel keep
  `await page.locator("body").ariaSnapshot()` and a screenshot with `Sealant connection` and its
  status in view, before and after `Check again`.

## Gotchas

- `mend doctor` routes to the bundle only when `--bundle` is present. `mend doctor --out x` or
  `mend doctor --tail 5` prints the checklist and ignores the flags without a word
  (`apps/cli/src/main.ts:4999-5001`). A product gap: no usage error.
- The bundle's `doctor.txt` runs the checks without the Docker shutdown probe, so it has no `docker`
  line even when `mend doctor` prints one (`apps/cli/src/main.ts:2838-2844`). Compare the two
  without that line.
- The troubleshooting page's table of doctor lines has no row for the `docker` line
  (`shutdown-timeout <n> s · <source> · covers the <n> s capture grace`, or `○` below it), which
  `apps/cli/src/docker-shutdown.ts:212-238` prints. A docs gap.
- Lines depend on this machine: the `cli` lines read `PATH` and local credential files, the `docker`
  line reads the local daemon, the `grant` line appears only when an older `mend` left
  `~/.config/mend/claude-grant`. Assert the server-side lines exactly and the machine-side lines by
  shape.
- Marks are painted only on a TTY. On a pipe the line starts with the bare `✓`, `○` or `✗`.
- `○` lines never fail the command. Only `✗` sets exit code `1`; a fresh instance with no providers
  connected exits `0`.
- The redactor matches by pattern only (`apps/cli/src/doctor-bundle.ts:30-57`): header values,
  `Bearer` tokens, Slack `xox…`/`xapp-`, OpenAI `sk-…`, GitHub `gh?_…`/`github_pat_…`, JWTs, AWS
  `AKIA…`, passwords in URLs, values of keys whose names contain `password`, `secret`, `token`,
  `api_key`, `private_key` or `credential`, and `NAME=value` lines. A Mend device token (`mdt_…`,
  `apps/api/src/routes/devices.ts:56`) standing bare in a log line, outside those shapes, has no
  rule and would survive. A product gap.
- The redactor is over-eager on purpose: any key containing `token`, `secret` or `password` and
  every `NAME=value` line is blanked. A blanked harmless value is expected, not a bug. The
  `NAME=value` rule is anchored at the start of a line (`apps/cli/src/doctor-bundle.ts:56`): inside
  a longer line, such as a session's recorded argv (`sh -c 'echo NAME=value'`), the value stays in
  the archive.
- The web `Sealant connection` panel is a `section` with no `aria-labelledby`, so it has no region
  role (`apps/web/src/routes/settings.tsx:1223`); scope to it through its heading. Its status word
  is plain text, not `role="status"` (`settings.tsx:1245`); assert it with `getByText`. A finding.
- The web says `Connected · observed`; the doctor's `sealant` line says `connected · <url>`. They
  are the same observation in two words; do not report a mismatch.
- `Settings` appears in two primary navigations, one hidden by viewport width. Playwright skips the
  hidden one; pass `exact: true` because a first-run hint link also contains `Settings`.
- The bundle can take a minute and reads every session's recorded output. Run it against a
  disposable instance; the archive still holds logs and configuration.
