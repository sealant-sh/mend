# pi profile

pi is shaped by what a person adds to it: extensions, themes, prompt templates, packages, settings.
`mend connect pi` reads that setup from pi's agent directory on the person's machine and saves it as
their pi profile. Every pi session they start then receives it: before pi starts, the session
installs what the extensions and declared packages need, merges the settings, and copies `mcp.json`
and `keybindings.json` into place, printing a `mend:` line for each step. The profile is the
person's alone. Their login is not part of it: pi runs on the ChatGPT login `mend connect codex`
makes.

## Sub-features

- `pi-profile-dry-run` prints what the profile would carry and what stays on this machine, and sends
  nothing.
- `pi-profile-save` sends the profile and reports its revision, or that it is unchanged.
- `pi-profile-dir` reads another agent directory with `--dir`.
- `pi-profile-refused` refuses a missing agent directory or a `settings.json` that is not a JSON
  object.
- `pi-profile-remove` deletes the saved profile.
- `pi-profile-session` delivers the profile into each new pi session's harness home at
  `~/.pi/agent/mend/profile`.

## How to get to it (user POV)

- CLI: `mend connect pi [--dir <path>] [--dry-run] [--remove]`.
- CLI: `mend pi ["prompt"] [--name <worktree>] … [--project <p>]` starts a pi session that receives
  the profile (the same command as `mend codex`; see [Start a session](./start-session.md)).
- Web: the Now page composer at `/` and a project's worktree session menu at `/projects/<id>` offer
  `pi`.
- TUI: the dashboard (`mend ui`, or bare `mend`) offers `pi` in its harness picker.
- Desktop: the launcher's harness menu offers `pi`.
- VS Code: `Mend: New Session…` and `Mend: New session in this worktree…` offer `pi` in the
  `Harness` picker. `not drivable yet`: the verify stack has no VS Code driver.
- Mobile and Slack: session launches offer Claude and Codex only; neither offers pi. Slack is
  `not drivable yet`: the verify stack has no Slack driver.
- These pi entry points use the saved profile, subject to the shared-home limit in Gotchas. Only the
  CLI saves or removes it; no surface shows or edits the saved profile.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` and `<project>` is adopted.
- `<scratch>` is an empty directory the run made. Build a disposable agent directory:
  `mkdir -p <scratch>/pi-agent/prompts`,
  `printf 'Say hello.\n' > <scratch>/pi-agent/prompts/verify.md`, and
  `printf '{"theme":"dark","lastChangelogVersion":"0"}\n' > <scratch>/pi-agent/settings.json`.
- No profile is saved: `mend connect pi --remove` prints `pi: no profile saved` (or
  `pi: profile removed`, after which the next run prints `pi: no profile saved`).
- For the session steps, `mend connect codex` has been run against this instance.

- **Dry run.** Run `mend connect pi --dir <scratch>/pi-agent --dry-run`. Stdout is
  `pi profile · <scratch>/pi-agent · 2 files · 1 KB`, `  extensions  none`, `  themes      0`,
  `  prompts     1`, `  packages    none`, `  settings    theme` and `  --dry-run: nothing sent`.
  Exit code `0`. `lastChangelogVersion` is not among the settings.
- **Save.** Run `mend connect pi --dir <scratch>/pi-agent`. Stdout is the same summary, then
  `pi       profile saved · revision <n> · new pi sessions receive it`. Exit code `0`.
- **Unchanged.** Run it again. The last line reads
  `pi       profile unchanged · revision <n> · new pi sessions receive it`, with the same `<n>`.
- **Changed.** Run `printf 'Say bye.\n' > <scratch>/pi-agent/prompts/bye.md` and save again. The
  summary reads `3 files` and `prompts     2`, and the last line reads `profile saved` with a
  revision above `<n>`.
- **Refusals.** Run `mend connect pi --dir <scratch>/missing`. Stderr is
  `mend: no pi agent directory at <scratch>/missing; run pi once, or pass --dir`. Exit code `1`. Run
  `printf '[1]\n' > <scratch>/bad/settings.json` (after `mkdir -p <scratch>/bad`) and
  `mend connect pi --dir <scratch>/bad`. Stderr is
  `mend: <scratch>/bad/settings.json is not a JSON object; fix it or move it aside first`. Exit code
  `1`.
- **Session receives it.** Run
  `mend pi "Change nothing." --name verify-pi --project <project> --detach` and note `<id8>` from
  `  attach · mend attach <id8>`. In a tmux session run `mend shell <id8>`, then
  `ls ~/.pi/agent/mend/profile ~/.pi/agent/mend/profile/prompts`. The listing shows `prompts` and
  `settings.json`, and `bye.md` and `verify.md` under `prompts`. Run
  `grep '"theme"' ~/.pi/agent/settings.json`; it prints the `"theme": "dark"` line.
- **VS Code entry point.** `not drivable yet`: the verify stack has no VS Code driver. The `Harness`
  picker in either new-session command offers `pi`; launching creates a pi session.
- **Remove.** Run `mend connect pi --remove`. Stdout is `pi: profile removed`. Run it again: stdout
  is `pi: no profile saved`. Stop the session with `mend stop <id8>`.
- **Proof.** Keep every `mend connect pi` transcript with exit codes, the `mend pi --detach`
  transcript, and the `mend shell` capture (`tmux capture-pane -p`) with the delivered files.

## Gotchas

- Without `--dir`, `mend connect pi` reads the real `~/.pi/agent` (or `$PI_CODING_AGENT_DIR`). A
  verification run passes `--dir` so it never uploads the operator's own setup, which can include
  `mcp.json` with keys in it.
- No command or page shows the saved profile. The server answers `GET /me/pi-profile`, but no client
  reads it, and `mend accounts` does not list it. The only read is the revision a save prints.
  Product gap.
- `mend connect pi` never sends `auth.json`, `skills/` or `AGENTS.md`: the summary lists them under
  `left here` when present. Skills go with `mend skills push`.
- A running pi session keeps the profile it started with. Start a new session after a save.
- The session prints `mend:` lines only for steps that do something (an install, a refused
  replacement). A profile with no packages and no extension dependencies prints none, so the shell
  listing is the proof.
- A package that fails to install leaves the session running without it, with
  `mend: pi package <spec> did not install, so this session runs without it: <reason>` in the
  terminal. A profile that cannot be set up at all stops the launch with `PI_PROFILE_NOT_DELIVERED`.
- A pi session starts without `mend connect codex`: pi needs no login to launch, and the dashboard's
  session pane then reads `pi's ChatGPT login not written · no Codex account is connected`. The
  profile is delivered either way.
- In a workspace that shares one home, a pi session that joins a running pi runs on the profile
  already there, which may be another person's.
