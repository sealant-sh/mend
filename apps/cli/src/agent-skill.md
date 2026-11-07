---
name: mend
description:
  Set up Mend and run coding work through its CLI. Use for first-time onboarding, conversation
  sessions, steering, review, previews and proof, or handing a session back to the person.
---

<!-- mend-managed-skill:v1 -->

# Mend

Mend runs the person's coding agent in a recorded git worktree. The same session, record and change
are visible in the web app, T3 Code, VS Code and the person's terminal. Use the shell and `mend`
CLI. Mend does not ship an outside-agent MCP server.

Read this workflow before onboarding or running work. Run `mend help COMMAND --json` when you need
the installed version's flag details. Replace uppercase identifiers below with ids returned by Mend.
Keep the session id, web URL, worktree id and pinned review slice with the task.

## Command outcomes

Use `--json` for agent-run commands. Parse the v1 envelope, `{"v":1,"status":…,"data":…}`. Login
also streams authorize and signed-in events. Read every event until the command exits.

| Exit | Meaning                | Next action                                                                    |
| ---- | ---------------------- | ------------------------------------------------------------------------------ |
| 0    | Done or ready          | Continue with the returned ids.                                                |
| 1    | Failed                 | Read `error.code`, `message` and `fix`; inspect state before retrying a write. |
| 2    | Usage or `needs_input` | Supply the named argument or flag. No picker runs without a terminal.          |
| 3    | Waiting on the person  | Show the pending request or approval URL and wait for their answer.            |
| 4    | Not ready              | Resolve the named blocking items and recheck.                                  |
| 124  | Timed out              | Inspect state; accepted sessions and resources keep running.                   |

Set `--timeout` on waits. A timeout is not permission to repeat a write. Report observations,
including uncertainty, and link the session. Say "Turn completed, observed" and what changed. Mend's
findings and captures are evidence for the person to assess.

Keep credentials inside their owning CLI. Never read Mend's credential file, print or request a
token, type a password, or place a credential in an argument. The person opens authorization links,
signs in to each provider once, and decides whether to add a public deploy key. Forward permission
and question requests to them. Send only the answer they give; never approve on their behalf.

## 1. First contact

For "Set me up on Mend", fetch `https://mend.run/agent.md`, then install the CLI and skill.

```sh
npm i -g @sealant/mend
mend agent install --json
```

Read a returned `SKILL.md` path. Installation finds existing `~/.claude`, `~/.codex` and
`~/.pi/agent` homes and installs the same skill into each. If Node is too old, upgrade to the
version named by the error and retry. If a custom Mend skill occupies a destination, preserve it at
another path before retrying.

## 2. Pick a server

Ask one question, "Run Mend on this machine, or connect to a server you already have?" For this
machine, ask for the account email and display name and run the fresh-server setup below. For an
existing server, take its URL and proceed to sign-in. For a server the person can reach with SSH,
run the same install and setup on that host using their existing SSH access. Setup stays on that
host; afterward sign the local CLI in to its reachable URL. Use setup's reported fixes for Docker,
user namespaces, ports or exposure. Do not declare readiness while blocking items remain.

## 3. Sign in and create the first account

On a fresh server, create the first account without a password passing through the agent.

```sh
mend server setup --yes --account-email person@example.com --account-name "Person" --json
mend server status --json
```

Substitute the person's email and name. Same-machine setup signs the local CLI in directly. Give the
person the returned one-time web password link privately so they can set their own web password in
their browser. Treat this link as a one-time approval capability, never as a reusable credential. Do
not open or redeem it yourself. Setup over SSH creates the same account but does not sign the CLI on
your machine in.

For an existing server or a separate local CLI, run:

```sh
mend login --url https://mend.example.com --timeout 10m --json
```

Show the first `authorize` event's URL and device code to the person. They click Authorize. Keep
reading until `signed-in` and exit 0. On denial, expiry or timeout, follow the reported fix and run
login again when the person is ready. Do not invent an account or automate their sign-in.

## 4. Adopt the repository and check Git

Run inside the person's checkout, or give adopt its network Git URL.

```sh
mend adopt --json
mend git check --project PROJECT --json
```

Keep the returned project id. Report read and push as observed, with the transport's reason. For a
duplicate name, use the existing project or supply `--name` with a new name. For auth failures, show
the public deploy key and ask "Add Mend's deploy key to OWNER/REPO?" Only after their explicit yes,
write the returned public key to a file and use their already signed-in `gh`:

```sh
gh repo deploy-key add PUBLIC_KEY_FILE --repo OWNER/REPO --allow-write --title Mend
```

If `gh` is not signed in, give the person the repository's deploy-key settings link. Re-run Git
check afterward. DNS, network and timeout failures need their own reported fixes; adding a key does
not repair them.

## 5. Connect the person's agent logins

```sh
mend connect status --json
mend connect claude --timeout 10m --json
```

Choose the requested provider, for example `mend connect codex --timeout 10m --json`. Show its
authorize event and let the person sign in once. The provider CLI stores its credential privately
and Mend imports it without printing it. For pi, connect Codex and use `mend connect pi --json` to
save the local pi profile; follow the reported fix if no profile exists.

If the person explicitly chooses an API key and gives its file location, pipe it directly without
reading or printing it:

```sh
mend connect claude --api-key --json < KEY_FILE
```

## 6. Check readiness

```sh
mend doctor --harness codex --project PROJECT --json
```

Use the person's chosen harness. Readiness requires a reachable server, your Mend sign-in, that
harness's selected login on the server, and working Git for this project. A Codex-only person needs
Codex connected on the server. They need no Claude login or local agent CLI credentials. GitHub
login matters only when they want to land through GitHub.

Read every item's state and fix. `info` items are advisory, including unused providers and local CLI
credentials. Resolve blocking `todo` or `failed` items. Say "Mend is ready" on exit 0.

## 7. Start and observe a conversation

Use the person's chosen harness, Claude, Codex or pi, and their actual request.

```sh
mend claude --detach --conversation --project PROJECT --json "Fix the flaky login test"
mend wait SESSION --turn --timeout 10m --json
mend history SESSION --json
```

Find active or settled sessions with `mend sessions --all --project PROJECT --json`. Save the
returned session id, worktree, branch and web link. To read a turn and every later turn, use
`mend history SESSION --since TURN --json` with a full turn id from history. On exit 3, show the
person the pending question or permission, including its options and scope. Use their explicit
response only:

```sh
mend respond REQUEST --decision accept --json
mend respond REQUEST --answers '{"QUESTION_ID":["Their answer"]}' --json
```

Use the appropriate decision, `accept`, `accept-for-session`, `decline` or `cancel`, only as the
person directed. For questions use the returned question ids and their words. Then wait again.
Report the observed result and files touched with the session link.

## 8. Steer, resume, interrupt or stop

```sh
mend message SESSION "Also cover the Safari case" --json
mend message SESSION "Continue with the agreed fix" --resume --json
mend wait SESSION --turn --timeout 10m --json
mend interrupt SESSION --json
mend stop SESSION --json
mend stop SESSION --services --json
```

Use message for the person's follow-up; it queues while busy. Use `--resume` when the session
stopped. Interrupt stops the current turn; stop stops the session. Choose the action the person
asked for, then inspect history for what happened. Services keep running after an agent stop. Stop
them with `--services` only when the person asks.

## 9. Review and send the person's comments back

```sh
mend change SESSION --json
mend diff SESSION --slice SLICE --json
mend comment add SESSION src/auth.ts:42 "This swallows the error" --slice SLICE --json
mend comment send SESSION --slice SLICE --json
mend wait SESSION --turn --timeout 10m --json
```

Keep the slice returned by change so the patch and comment refer to what the person saw. Change
includes files, stats, checkpoints, draft findings, proposed checks and record evidence. Walk the
person through them; findings remain observations. Use `--side old` for removed lines, `--change`
for a whole-change remark, or `path:start-end` for a range. To compare checkpoints use
`mend diff SESSION --from CHECKPOINT_A --to CHECKPOINT_B --json` and inspect truncation fields.
Comment send bundles unsent open reviewer comments and returns without attaching. It does not
approve Mend's draft findings. On an uncertain delivery, retry the same command to reconcile the
saved bundle and request key before sending anything else.

## 10. Land when requested

```sh
mend land SESSION --json
```

Report what was pushed, its checkpoint and commit, the pull request URL and GitHub's last observed
state. A failed pull-request step can follow a successful push; preserve both facts. Mend never
merges. If the person asks for a merge, use their normal GitHub workflow with `gh` outside Mend.

## 11. Resources, Services, previews, screens and proof

When the work needs Postgres or another resource, have the session's agent write the named resource
such as `@db` into its `.mend/mend.toml` through an ordinary message. Wait for that turn and read
the change to obtain its project and worktree ids. Then explicitly start the intended level:

```sh
mend resource list --project-id PROJECT --worktree-id WORKTREE --json
mend resource add db --preset postgres --version 17 --project-id PROJECT --worktree-id WORKTREE --json
mend resource start db --project --project-id PROJECT --worktree-id WORKTREE --wait --timeout 10m --json
mend resource env --project-id PROJECT --worktree-id WORKTREE --json
mend service list SESSION --json
mend preview SESSION --json
mend screen look SESSION --out shot.png --timeout 30s --json
mend proof list SESSION --json
mend proof get PROOF --out proof.png --timeout 5m --json
```

Use `--worktree` for a separate worktree resource. If a changed definition needs a restart, show the
named affected worktrees and get the person's consent before passing `--restart`. Service listing
reports attempts, forwarding and target observations separately. If a preview is not ready, ask the
session's agent to start its declared Service and recheck. Give the person the Preview tab link for
their own browser sign-in. Do not request or pass preview tickets.

Resource add writes a declaration without starting anything. Resource env lists names without
revealing values. When the person asks to stop a resource or load a dump, use the explicit project,
worktree and level. A load saves the previous database first; inspect a timed-out load before
starting another.

```sh
mend resource stop db --project --project-id PROJECT --worktree-id WORKTREE --json
mend resource load db --from DUMP_FILE --target shared --project-id PROJECT --worktree-id WORKTREE --timeout 10m --json
mend projects image PROJECT --json
```

If screen look returns `ScreenObservationUnavailable`, read the effective image. If Screen is off,
enable it, then start a new session in a new worktree before observing again:

```sh
mend projects image PROJECT --screen on --json
```

The screen flag preserves the rest of the image. A custom image needs a family image selected in
project environment settings first. If Screen is already on, follow the reported screen-start
failure instead of repeating the setting.

Screen look only observes. The session's own agent drives the screen; the person takes over in Mend.
An outside agent never drives it or impersonates the session's agent. Proof list/get read
screenshots and videos already captured in the session, with checkpoint or unknown source and
observation times. Choose a new output path for each download. Show the saved media to the person
and describe what it captured, without treating the image as proof that the change works.

## 12. Hand the session to the person

At any point give the person the session's web link. For their own interactive terminal they can run
`mend attach SESSION`. They can also open that same session in T3 Code or VS Code. Keep the record
and change links with the handover so they can inspect everything done so far.

When the person asks to clean up, list projects and stop their work before removal. Removal keeps
files and history. Permanent deletion requires their request and the exact name, and can be refused
until uploads finish. Follow the structured error before retrying.

```sh
mend projects --json
mend projects rm PROJECT --json
mend projects removed --json
mend projects restore PROJECT --json
mend projects purge PROJECT --confirm PROJECT_NAME --json
```

When the person asks to sign this CLI out, run `mend logout --json`. Read local sign-out and server
revocation separately. If revocation is unconfirmed, give them the reported fix.
