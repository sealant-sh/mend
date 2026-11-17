# The task a flow-driving subagent gets

SKILL.md, step 5, fills the `<…>` below and passes the text, unchanged otherwise, as the task of one
subagent. Everything the subagent needs is in it: it has no other context.

---

You drive a fixed set of flows of Mend's daily box check, as a person signed in to Mend on the box
(VM 131). Another agent checks your evidence afterwards. Do these flows and nothing else.

**Flows, in this order:** <flow ids, one per line>

**Read first:** `.agents/skills/box-main-run/flows.md`, the entry of each flow above (its Do, See
and Needs lines); then, for each, the feature file its Map line names, under
`.agents/skills/verify/features/`, section "Driving it with verify". The worktree is
`<worktree path>`; run every command from there, in `bash`.

**Names:**

- The CLI under test, signed in already:
  `M() { XDG_CONFIG_HOME=<kit>/cli <cli dir>/node_modules/.bin/mend "$@"; }`
- The second account's CLI, for the flows that name `M2`:
  `M2() { XDG_CONFIG_HOME=<kit2>/cli <cli dir>/node_modules/.bin/mend "$@"; }`. Its browser: the web
  driver with `--account <private dir>/account2.json --state <private dir>/browser2.json`.
- The box's web: `<web>`. The project: `boat-check-ubuntu`, written `<p>`. `<sha8>`: `<sha8>`.
- Sessions earlier flows made: <name = session id, one per line, or "none">
- Evidence: `<evidence dir>/<flow id>/` per flow. The web driver:
  `MEND_VERIFY_OUTER_URL=<web> MEND_VERIFY_PRIVATE=<private dir> node .agents/skills/verify/scripts/drive-web.mjs --web <web> --out <evidence dir>/<flow id> --private <private dir> --account <private dir>/account.json --state <private dir>/browser.json --recipe <recipe>`,
  where `<recipe>` is the flow's recipe in `.agents/skills/box-main-run/recipes/`, or a module you
  write into `<evidence dir>/<flow id>/` for a flow with none (default export
  `async ({ page, web, capture, note }) => {}`; `capture(name)` saves the screen).

**Record, for each flow:**

1. `<flow id> start <UTC>` and `<flow id> end <UTC>` lines appended to `<evidence dir>/timeline.txt`
   (`date -u +%FT%T.%3NZ`).
2. Every CLI command with its stdout, stderr and exit code in `<evidence dir>/<flow id>/cli.log`.
3. A screenshot of each state the See line names, through the web driver.
4. `<evidence dir>/<flow id>/result.txt`: the first line `seen`, `failed` or `not run · <reason>`;
   then each part of the flow's See line with what you saw for it, and the evidence file that shows
   it.

A flow is `seen` only when every part of its See line was seen. When a step does not go as the
feature file or the See line says, stop that flow: record exactly what you saw, mark it `failed` (or
`not run · <why>` when it could not start), and go on to the next flow. Do not try another way to
make it pass.

**Never:**

- reach `alpha.mend.run` (VM 130) or ssh to `acer-laptop`; push, tag or commit anything; edit any
  file outside `<evidence dir>`;
- run `mend login`, `mend logout`, or read a token or the account file's contents; print a password;
- run any `pnpm verify box` command, deploy, or touch the box over ssh: the box and its hold belong
  to the agent that started you;
- comment on or file Linear tickets, or fix anything you find;
- start a real agent turn other than a flow's own one-line prompt, exactly as flows.md writes it;
- stop a session a later flow needs, beyond what a flow's Do line says;
- run more than 3 processes at once.

**Reply** with one line per flow: `<flow id> · <outcome> · <minutes> · <evidence dir>/<flow id>`;
then the id of every session you made, as `<name> = <id>`; then anything you could not do, and why.
Nothing else.
