# The task a flow-driving subagent gets

SKILL.md, step 5, fills the `<…>` below and passes the text, unchanged otherwise, as the task of one
subagent. Everything the subagent needs is in it: it has no other context.

---

You drive a fixed set of flows of Mend's daily box check, as a person signed in to Mend on the box
(VM 131). Another agent checks your evidence afterwards. Do these flows and nothing else.

**Flows, in this order:** <flow ids, one per line>

**Read first:** `.agents/skills/box-main-run/flows.md`, the entry of each flow above (its Do, See
and Needs lines); then, for each, the feature file its Map line names, under
`.agents/skills/verify/features/`, section "Driving it with verify", for how to reach each step. The
worktree is `<worktree path>`; run every command from there.

**Names.** Each is a file; type its full path in every command:

- `~/.local/state/mend-main-run/bin/M`: mend, signed in as the checker account (written `M` in
  flows.md). `~/.local/state/mend-main-run/bin/M2`: mend as the second account (`M2`).
- `~/.local/state/mend-main-run/bin/web <out dir> <recipe> [flags]`: the web driver against the box,
  as the checker account; `…/bin/web2` as the second account. `<recipe>` is the flow's recipe in
  `.agents/skills/box-main-run/recipes/`, or a module you write into `<evidence dir>/<flow id>/` for
  a flow with none (default export `async ({ page, web, capture, note }) => {}`; `capture(name)`
  saves the screen).
- The box's web: `<web>`. The project: `boat-check-ubuntu`, written `<p>`. `<sha8>`: `<sha8>`.
- Sessions earlier flows made: <name = session id, one per line, or "none">
- Evidence: `<evidence dir>/<flow id>/` per flow.

**Run each command as one plain command.** A shell function or variable you define does not reach
your next command, so do not wrap commands in `bash -c '…'`, `source` a file, or define functions:
call the files above by their full paths. Give every removal (`… worktrees rm`, `… secrets rm`,
`… folder rm`, `rm -rf …`) a command of its own: the harness refuses a removal it cannot read.

**Record, for each flow:**

1. `<flow id> start <UTC>` and `<flow id> end <UTC>` lines appended to `<evidence dir>/timeline.txt`
   (`date -u +%FT%T.%3NZ`).
2. Every CLI command with its stdout, stderr and exit code in `<evidence dir>/<flow id>/cli.log`.
3. A screenshot of each state the See line names, through the web driver.
4. `<evidence dir>/<flow id>/result.txt`: the first line `seen`, `failed` or `not run · <reason>`;
   then each part of the flow's See line with what you saw for it and the evidence file that shows
   it; then each step that went differently from the feature file, as `differs · <what>`.

**Judge the See line, and only the See line.** The feature file says how to reach each step; when a
control or a word on the way differs from it (a heading, a button's name, a status word the See line
does not name), find the control a person would use, write the difference as `differs · …`, and
carry on. A flow is `seen` when every part of its See line was seen, `failed` when a part of it was
not, after you reached the step where it should show. Mark it `not run · <why>` only when it could
not start. Add no check of your own to a flow, and do not try another way to make a part of the See
line appear.

**Restore what a flow changed, even when it failed.** When a flow's Do line restores something
(removes what it made, sets a setting back), do that part before you move on, whatever the flow's
outcome, and record it in `cli.log`.

**Never:**

- reach `alpha.mend.run` (VM 130) or ssh to `acer-laptop`; push, tag or commit anything; edit any
  file outside `<evidence dir>`;
- run `mend login`, `mend logout`, or read a token or the account files' contents; print a password;
- run any `pnpm verify box` command, deploy, or touch the box over ssh: the box and its hold belong
  to the agent that started you;
- comment on or file Linear tickets, or fix anything you find;
- start a real agent turn other than a flow's own one-line prompt, exactly as flows.md writes it;
- stop a session a later flow needs, beyond what a flow's Do line says;
- run more than 3 processes at once.

**Reply** with one line per flow: `<flow id> · <outcome> · <minutes> · <evidence dir>/<flow id>`;
then the id of every session you made, as `<name> = <id>`; then anything you could not do, and why.
Nothing else.
