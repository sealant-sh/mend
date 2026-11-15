# Writing and running recipes

Read this before writing a web recipe or a CLI batch, or when a step cannot be driven. In this file,
Launch is `pnpm verify stack up` and Cleanup is `pnpm verify stack down`. `$E` is the run's evidence
directory, `$P` its private directory, `$wt` its outer worktree and `$web` its tunnel;
`.verify/stack/current.json` names each for the run that is up.

Pick the feature's file in the map and follow its `Driving it with verify` section. Map its
placeholders to this stack:

| Map          | Here                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<web>`      | `$web`                                                                                                                                                                                                                                                  |
| `<repo-url>` | `http://verify-stack-fixture:9080/repo.git`: the stack's one-commit fixture, served on its network over HTTP: either git access mode clones it with no signer, so adopt with the default (`mend key`) or `--auth mend-key`; `--auth ambient` is refused |
| `<project>`  | `$wt-1`, `$wt-2` …: no project has the name yet. `verify-fixture` is taken, adopted by Launch                                                                                                                                                           |
| `<scratch>`  | a directory under the inner home (`cwd` in a step, below), made by a step: `git clone <repo-url> <scratch>/checkout` too                                                                                                                                |
| `mend …`     | the inner CLI, below                                                                                                                                                                                                                                    |

**One account on both surfaces.** The browser (`stack up`'s handover) and the inner CLI are both the
stack's first account, so the map's precondition holds: a session the CLI started is the browser's
own, and steps that need its owner (a Service started from the browser, sending review back,
landing) run. Report `both surfaces as verifier@verify-stack.invalid`.

**Web.** Playwright through ARIA roles and accessible names, against `$web`. The map's calls are
`page.…` lines. Put them in a recipe module, and `drive-web.mjs` runs it:

```sh
node $skill/scripts/drive-web.mjs --web "$web" --out "$E/<feature>/web" --private "$P" \
  --recipe <recipe.mjs> --account "$P/account.json" --state "$P/browser.json"
```

```js
// <recipe.mjs>: the map's steps, then capture()
export default async ({ page, web, capture, note }) => {
  await page.goto(`${web}/projects`);
  await page.getByRole("main").getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await capture("projects");
};
```

`--account` signs in at `/login`; `--state` keeps the browser signed in for the next drive. Both are
credentials, so both stay in `$P`.

**Fake logins.** A step that needs a provider to refuse a login (a GitHub token GitHub rejects, a
Claude setup token refused at launch, a Codex `auth.json` Codex refuses) uses `fakes.mjs`'s values
(`FAKES.github`, `FAKES.claude`, `FAKES.codexAuth`) and no value of your own making. They are
published, so Cleanup's scan does not count them; any other made-up value counts as a real one.

**Credentials in a recipe.** Type every credential with `typeSecret(locator, name, value)`, never
`fill`: the value goes into the run's **secret registry** (`$P`, `secrets.mjs`) first, then into the
field by script, so no Playwright log can carry it, and the page's screenshot is withheld while the
field holds it. Register what a page mints (a device token, a pairing code) with
`registerSecret(name, value)` as soon as the recipe reads it. Every snapshot, log line and error is
redacted against the registry by value, and against `redact.mjs`'s shapes: a value the registry
lacks is protected only by its shape, so register it. The registry is append-only: a second value
under a name joins the first, and the values of a rewritten `account.json` or `browser.json` stay. A
value under 6 characters is refused, and the recipe fails: it cannot be redacted by value without
redacting ordinary text, so keep such a value off every captured page.

**CLI.** The inner `mend` runs in the session, signed in as the stack's first account, on a machine
of its own: the inner account's home, kept in the stack's state volume, with `mend`, `git` and a
shell. Write a feature's CLI steps as one list, and `steps.mjs` runs them all in one sibling
session:

```sh
node $skill/scripts/steps.mjs "$E/<feature>/cli" <batch> --worktree "$wt" <<'STEPS'
[
  {"name": "01-clone", "run": ["git", "clone", "-q", "http://verify-stack-fixture:9080/repo.git", "work"]},
  {"name": "02-skill", "run": ["sh", "-c", "mkdir -p sk/one && printf -- '---\\ndescription: One.\\n---\\nHi.\\n' > sk/one/SKILL.md"]},
  {"name": "03-push", "cwd": "work", "run": ["mend", "skills", "push", "--dir", "../sk", "--project"]},
  {"name": "04-pipe", "run": ["sh", "-c", "printf %s <a fakes.mjs value> | mend connect github --from-stdin"]}
]
STEPS
```

- **`run`** is the step's argv: `mend …`, `git …`, or `sh -c '…'` for a pipe, a redirect or a
  heredoc, as a person types them. Every step's stdin is closed, so `--from-stdin` reads what the
  pipe gave it and ends.
- **`cwd`** is a directory under the inner home (default: the home itself), made if missing. What a
  step leaves there stays for the next step and the next batch, until the stack's teardown removes
  the state volume. A clone of `http://verify-stack-fixture:9080/repo.git` has the origin
  `verify-fixture` was adopted from, so a command that finds its project from the current directory
  (`mend skills push --project`, `mend pull`, `mend run`) finds `verify-fixture` there.
- **Evidence.** Each step writes `<name>.cmd` (`cd ~/<cwd> &&` and the argv, quoted as `capture.sh`
  quotes it), `<name>.stdout` and `<name>.stderr` apart (no terminal folds them: no CRLF, no colour)
  and `<name>.exit`, the inner command's own code. `<batch>.{cmd,stdout,stderr,exit}` keep the
  sibling session itself: its `mend run`, its output without the steps' results, and Mend's lines
  with its `session <id8>`. Every file is redacted as `capture.sh` redacts. It prints
  `<name> · exit <code>` per step and exits 0 once every step's result arrived in full. A step's
  failure is its `.exit`, so a refusal the recipe expects does not stop the steps after it. Exit 1
  names each step whose result never arrived or arrived cut short (its byte counts did not match),
  and counts frame lines that fit no step. None of those is kept: a step's files from an earlier
  attempt are removed before the batch runs, so a missing result leaves no file behind.

One batch is one sibling session in the same worktree (the same workspace and Docker daemon): 5
steps took 9 s here, 8 with a `git clone` among them 33 s. Each step gets 30 minutes, then its
container is removed and its `.exit` reads 137. Step names, and the batch's, are unique file names.
The whole list travels as one argv word, so it stays under 131,071 bytes as JSON: split a larger one
into batches. Put a flag that takes an optional value (`--project` of `mend skills push`) last: Mend
main reads the word after it as its value, even another flag.

`stack.mjs steps` holds the stack's lock (shared) while it runs, and records the inner sessions the
steps start (their `sealant-…` containers and networks, from a snapshot of the daemon before and
after), so the stack's teardown removes them. Anything else a step makes on the session's daemon is
not recorded, and stays until the outer session stops.

- **A command that holds the terminal** (`mend attach`, `mend continue`, `mend service connect`,
  `mend service logs`, a harness): a step has no terminal, so run it under `timeout` inside the step
  (`"run": ["timeout", "30", "mend", "attach", "<id>"]`). To see what it draws on a terminal, run it
  as one command through `capture.sh`, with its `timeout` inside the sibling:
  `capture.sh "$E/<feature>/cli" <step> -- mend run --project mend --worktree "$wt" -- timeout 30 node scripts/verify-stack/stack.mjs mend attach <id>`.
  That stdout is the terminal (CRLF line ends, ANSI colour, the inner stderr folded in): compare it
  after `tr -d '\r' | sed 's/\x1b\[[0-9;]*m//g'`. `stack.mjs mend` starts in the inner home too. A
  `timeout` around `mend run` ends only this machine's CLI: the sibling session keeps running the
  inner command, and while it holds the lock the stack's teardown waits for it (Cleanup stops such
  siblings first).
- **What a web drive starts is not recorded.** A session started from the inner web (the Now
  composer, a worktree's `New session` menu) runs outside any `stack.mjs mend` or `check`, so the
  teardown leaves its containers and networks and lists them (see Cleanup). Start an inner session
  through `stack.mjs mend` when the step allows either surface, and note in the feature's
  `steps.log` each one a recipe started from the web.

**A project a recipe adopts** gets the default workspace image, whose Docker service cannot start
inside the stack (it would be Docker in the session's Docker), so its sessions never launch
(`Workspace Docker service … did not become ready`). Right after adopting, give it the fixture's
image, `node:26-bookworm` with no Docker service:

```sh
mend run --project mend --worktree "$wt" -- node scripts/verify-stack/stack.mjs project-image "$wt-1"
```

Recipes that are about the workspace image itself (the map's `workspace-images` and `hot-sessions`)
skip this and set the image the way their steps say.

**Steps this skill does not run,** each reported `not run` with its reason:

- **A CLI step that prints a credential** (`mend pair`, a token minted by hand, a provider sign-in
  such as `mend connect`): a sibling `mend run` is a recorded terminal, and its record outlives the
  run. `not run · prints a credential into a recorded terminal`. Drive the web entry instead, where
  captures are redacted.
- **A local check of an inner tunnel.** The inner CLI's `mend service connect` binds the session
  Docker daemon's loopback, not this machine's, so the map's `curl http://127.0.0.1:<port>/` here
  finds nothing. `not run · the inner tunnel binds the session's Docker daemon`. The tunnel's own
  line (`● <name> → 127.0.0.1:<port>`) is still an observation of the CLI.
- **Slack.** The map's Slack entry points have no driver here:
  `not drivable yet · no Slack driver in the verify skill`. Slack's pages on the web (Settings →
  Slack, `/slack/link#<code>`) are web steps and run. (VS Code has one: [vscode.md](vscode.md).)
- **A step that needs what the stack lacks:** a provider login (Claude, Codex, GitHub), a GitHub
  origin or one that accepts pushes (the fixture serves fetch only and refuses a push with 403), a
  Kubernetes server, an SSH git host, a restart of the inner server with other environment, or a
  repository with package files (the fixture holds one `README.md`). Report it
  `verified-unreachable · <that prerequisite>`, and still drive the steps around it.

The driving conventions, repeated from the map:

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Use roles and names (`page.getByRole(role, { name })`). A name matches as a case-blind substring:
  pass `exact: true`, or an anchored regular expression, whenever it could sit inside another
  (`Worktrees` matches `No worktrees yet`). At 1024 px and wider the sidebar repeats the navigation
  and every project as links: scope page content to `page.getByRole("main")`. A control with no
  stable accessible name is a product finding: record it, and do not invent a selector.
- Wait for the role, name or text the step names, never for `networkidle`: every workbench page
  holds an SSE stream open, so the network never goes idle.
- Treat commands as literal; angle-bracketed words are values you fill in.
- Settings pages always hold a credential field, so their screenshots are withheld and the ARIA
  snapshot is the proof.
- Run commands that hold the terminal in their own PTY or under `timeout`: `mend codex`,
  `mend claude`, `mend attach`, `mend continue`, `mend service connect`, `mend service logs`. For
  the inner CLI the `timeout` goes inside the sibling (see **CLI** above).
- Restore seeded state after a mutation. Keep the evidence.

What differs from a `mend` on your own machine:

- **The inner home, not this machine's.** A step's files and checkouts are in the inner account's
  home, never on this machine: make them with a step (`git clone`, `sh -c 'printf … > file'`). Each
  step is a fresh container, so an `export` or a `cd` in one step is gone in the next. Set `cwd`, or
  put the commands in one `sh -c`.
- **Stdin only from a step.** `mend run` sends no keys, so nothing this machine pipes reaches the
  inner CLI. A step's own pipe does (`sh -c 'printf … | mend … --from-stdin'`). Its text is in the
  step's argv, which the outer server records, so pipe only `fakes.mjs`'s values.
- **One address on a local outer.** Every verifier on this machine reaches a `local-outer.sh` server
  from 127.0.0.1, as its one account. The product's budgets (1200 requests per minute per address
  and per credential) are sized for a small team, and five drivers spent them in seconds (429s,
  dropped tunnels), so `local-outer.sh up` gives that outer its own (`budgets`: 12000 per minute,
  and room for more sessions, launches, streams and tunnels), through an extra Compose file of its
  own; the product's defaults stay. An outer `up` made before this has the defaults: run
  `local-outer.sh budgets` once. The box keeps its operator's budgets: on it, a sibling's watch can
  still end `budget reached · …` (the inner command keeps running), so read the inner record before
  calling such a step's result.
- **One exit code on the terminal.** A step's `.exit` is the inner command's own code, but
  `stack.mjs mend` on the session's terminal exits 1 for any inner failure, whatever code the inner
  CLI returned. There, assert on 0 or not-0, and read the message from stdout.
- **The platform's argv rules.** At most 64 words. Since sealant#347 (Mend #653) only the program
  must be non-empty and trimmed; an outer server on an older sealant refuses any word that is empty
  or starts or ends with whitespace, before it creates anything. Every script this skill passes as
  one word (`sh -c '…'`, the doctor's) starts and ends with a command, so either rule takes it; trim
  yours the same way.
