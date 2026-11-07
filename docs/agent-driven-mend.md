# Agent-driven Mend: user stories

Mira uses Claude Code (the same goes for Codex, T3 Code or pi). She has never used Mend. She asks
her agent to set her up, and from then on to run work through Mend. The agent only has a shell. Mira
only clicks approvals in her browser. She never types a password into the agent, and the agent never
sees a token.

Today, an agent gets stuck at stories 3, 6, 7, 8 and 9. The audit is in
`/tmp/mend-agent-research.lW34qN/mend-cli-agent-audit.md`.

## 1. First contact

Mira types: "Set me up on Mend, mend.run."

1. The agent fetches `https://mend.run/agent.md`. It's a short, plain page written for agents: what
   Mend is, then "install the CLI, then run `mend agent install`".
2. The agent runs `npm i -g @sealant/mend`.
3. The agent runs `mend agent install --json`. Mend writes its skill into every agent home it finds
   on the machine (`~/.claude/skills/mend`, `~/.codex/skills/mend`, `~/.pi/agent/skills/mend`) and
   reports each path. From here on, the skill drives the agent.

- Edge case: Node is too old. The JSON error names the version needed and the fix.

## 2. Pick a server

The agent asks Mira one question: "Run Mend on this machine, or connect to a server you already
have?"

- **This machine:** `mend server setup --yes --json`. The result is either ready, with the URL, or
  not ready, with each blocking item and its fix (for example user namespaces, Docker missing, a
  port in use).
- **Existing server:** Mira gives the URL, and the agent goes straight to sign-in.
- **A box she has SSH access to:** the agent runs the same setup over `ssh`. The skill teaches this,
  and Mend adds no new command for it.

## 3. Sign in: Mira's one Mend click

1. The agent runs `mend login --url <url> --json`. The first JSON line comes out at once:
   `{"event":"authorize","url":…,"code":…,"expiresAt":…}`. The agent shows Mira the link.
2. On a fresh server, Mend creates the first account itself (decided 2026-11-04).
   `mend server setup --yes --account-email <e> --account-name <n> --json` creates Mira's account
   and organization. No password passes through the agent. When setup runs on the same machine as
   the CLI, it also signs that CLI in, so there's no Authorize click. Mira sets her web password
   through a one-time link in the setup JSON, which she opens when she first visits the web app. A
   server set up over SSH gets the same account; the local CLI then signs in with step 1.
3. When Mira clicks, the command prints `{"event":"signed-in","account":…,"organization":…}` and
   exits 0. Denied or expired: a JSON error and a non-zero exit, with the fix "run mend login
   again".

## 4. Adopt the repository

1. Inside her repo, the agent runs `mend adopt --json`, which returns the project id and name.
2. The agent runs `mend git check --json`. It reports, as observed, whether Mend can clone and
   whether it can push.
3. If push fails, the JSON includes Mend's deploy key. If `gh` is signed in, the agent asks Mira
   "Add Mend's deploy key to <repo>?" and runs `gh repo deploy-key add`. If not, it gives her the
   GitHub settings link. Then it re-runs the check.

## 5. Agent logins

1. `mend connect status --json` lists Claude, Codex and pi, each connected or not.
2. `mend connect claude --json` starts Anthropic's own login. As in story 3, it prints the
   provider's URL as a JSON event, and Mira clicks. That's her second and last click.
3. API key alternative: Mira tells the agent where the key lives, and the agent pipes it in with
   `mend connect claude --api-key --json < file`. The agent never prints it.

## 6. Ready check

`mend doctor --json` lists every item with its state (`ok`, `todo` or `failed`) and its fix. Exit
code 0 means nothing is left to do. The agent tells Mira "Mend is ready", or what's still open, and
stops there if anything is.

## 7. Start work

Mira: "Fix the flaky login test in Mend."

1. `mend claude --detach --conversation --json "Fix the flaky login test…"` returns the session id,
   worktree, branch and the session's web link.
2. `mend wait <s> --turn --json` blocks until the turn ends. It returns how the turn ended and any
   pending question or permission request.
3. `mend history <s> --json --since <turn>` shows what the session's agent did: messages, tool calls
   and files touched.
4. When the session's agent asks a permission or question, the outside agent shows it to Mira. She
   answers in her own words, and the agent passes the answer on with `mend respond <request> …`. The
   outside agent never approves on its own.
5. The agent reports to Mira in Mend's words, for example "Turn completed · observed, 3 files
   changed", plus the session link.

## 8. Steer and resume

- "Also cover the Safari case": `mend message <s> "…" --json`. It queues if the session is busy, and
  it resumes the session if it stopped (`--resume`). Then `mend wait --turn` again.
- "Stop it": `mend stop <s> --json`. "Interrupt that turn": `mend interrupt <s> --json`.

## 9. Review and send comments back

1. `mend change <s> --json` lists files, stats, checkpoints, Mend's read of the change (draft
   comments and proposed checks) and the evidence links.
2. `mend diff <s> [--from <checkpoint>] [--to <checkpoint>]` prints the patch for a pinned slice.
3. The agent walks Mira through it. Her remarks become comments:
   `mend comment add <s> src/auth.ts:42 "This swallows the error" --json`.
4. `mend comment send <s> --json` delivers the bundle to the same session without attaching to it.
   Then `mend wait --turn`.

## 10. Land

`mend land <s> --json` returns what was pushed, the pull request URL, and GitHub's last answer
(`pull request #412 · open · observed`). Mend never merges. If Mira wants it merged, her agent does
that with `gh`, outside Mend.

## 11. Services, previews, screens, proof

1. "It needs Postgres": the agent writes `@db` into `.mend/mend.toml`, then runs
   `mend resource start --wait --json`.
2. `mend service list <s> --json` shows the session's Services and their state.
3. `mend preview <s> --json` returns a link to the session's Preview tab, which Mira opens with her
   own browser login. The agent doesn't pass around tickets.
4. `mend screen look <s> --out shot.png` saves the current screen so Mira's agent can see it.
   Driving the screen stays with the session's own agent and the owner's takeover.
5. `mend proof list <s> --json` and `mend proof get <id> --out …` fetch the screenshots and videos
   the session captured, so Mira's agent can show them to her.

## 12. Hand over to Mira

At any point the agent can give her the session's web link, or `mend attach <s>` for her terminal.
She can take over in the web app, T3 Code or VS Code. Nothing the agent did is hidden from her: it's
the same session, record and change.

## New commands these stories need

`mend agent install`, `git check`, `history`, `respond`, `interrupt`, `change`, `diff`,
`comment add|send`, `preview`, `screen look`, `proof list|get`.

New flags on existing commands: `--json` (on `login`, `adopt`, `connect`, `doctor`,
`server setup|status`, `stop`, `land`), `--conversation`, `--turn` (on `wait`), `--resume` (on
`message`) and `--api-key` (on `connect`).

## Rules every command follows

- `--json` on every command the skill uses, versioned (`{"v":1,…}`).
- Errors in JSON: `{"error":{"code","message","fix"}}`.
- Exit codes:
  - 0: done or ready;
  - 1: failed;
  - 2: usage;
  - 3: waiting on a human, with the URL in the JSON;
  - 4: not ready, with the items in the JSON;
  - 124: timed out.
- No prompts or pickers without a terminal. A command that would need one fails with `needs_input`
  and names the flag to pass.
- Every wait has `--timeout`.
- Nothing prints a secret.

## Build order (each step a PR, each feature checked on the box)

1. The rules above, plus JSON for `doctor`, `server setup`/`status`, `adopt`, `connect` and
   `git check`.
2. Sign-in: `login --json`, and one visit that creates the account and authorizes.
3. Conversation sessions for agents: `--conversation`, `wait --turn`, `history`, `respond`,
   `message --resume`, `interrupt`.
4. Review from the shell: `change`, `diff`, `comment add` and `comment send`.
5. Previews, screens and proof: `preview`, `screen look`, `proof list` and `proof get`.
6. The skill: `mend agent install`, `mend.run/agent.md`, and a docs page.
7. End to end: a fresh agent on a fresh machine runs stories 1 to 12 on the box.
