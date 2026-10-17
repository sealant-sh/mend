# VS Code remote server: your extensions and settings (working notes)

Status: on hold since 2026-10-17. The T3 Code nightly work, mend#684 and the verify inner-CLI fix
land first. Nothing is built yet. These notes record where the work stopped.

## The feature

When Mend opens a workspace over Remote-SSH, the person's VS Code extensions, `settings.json` and
`keybindings.json` are synced in, so the remote window feels like their own editor. This holds in
every VS Code session Mend opens. It is the 0.36 roadmap item "VS Code remote server: your
extensions and settings".

## What was read

- The Feature playbook and Mend's project playbooks (`.agents/playbooks/`). `check-playbooks.mjs`
  passes.
- The `apps/vscode` file inventory. The open path is `src/workspace-ssh.ts` (64 lines),
  `src/extension.ts` (1457 lines), `src/takeover.ts` and `src/config.ts`. Nothing in `src/` reads
  the local profile, its settings, or its extension list yet. That claim comes from file names
  only. It still needs a grep.
- History that bears on this work: #621 (work against a server on another machine, with a real
  end-to-end run), #622 (Mac mini guide, and which user Remote-SSH runs as), #658 (acceptance on
  Xvfb, first terminal held to a budget), #698 (publishable to the Marketplace and Open VSX), #843
  (takeover destination match).
- Docs that mention Remote-SSH: `apps/docs/src/content/docs/clients/vscode.md`,
  `operate/mac-mini-vscode.md`, `operate/per-person-workspaces.md`, `guides/remote-access.md`,
  `docs/WORKSPACE-SSH.md`, `docs/adr/0016-per-person-harness-homes.md` (1618 lines, not yet read).
- Harness: `scripts/vscode-remote-acceptance.mjs` (513 lines), `apps/vscode/test/e2e/suite.ts` (514
  lines), and `scripts/vscode-acceptance-evidence.mjs`.

A `how` pass with three explorers was planned. The first explorer (the client side in
`apps/vscode`) was stopped by the hold before it reported. The other two never started. The second
covers which user and home Remote-SSH lands as, under ADR 0016 and dotfiles, and whether
`~/.vscode-server` persists. The third covers the harness.

## Open decisions

Each one goes to the orchestrator thread with a recommendation before anything is built beyond a
spike. The leanings below are guesses. The `how` pass has not yet confirmed them.

1. **Source of truth.** The options are the person's local VS Code, pushed by the extension; a
   per-person copy kept in Mend; VS Code's own Settings Sync; and `remote.SSH.defaultExtensions`
   with a server-side `settings.json`. Leaning: local VS Code, pushed by the extension. It is the
   only source that is current with no extra step. Settings Sync needs a Microsoft or GitHub login
   and does not exist in VSCodium or code-server. Whether Mend should also keep a copy depends on
   whether `~/.vscode-server` survives across sessions in a person's home.
2. **Extensions.** The options are a marketplace install on the remote, a VSIX copy, or leaving
   local-only extensions local. UI-kind extensions stay local. Workspace-kind extensions install on
   the remote. Install from the gallery the editor itself uses, which is the Microsoft marketplace
   for VS Code and Open VSX for VSCodium, code-server and Cursor. Check this against
   `product.json` and `vscode.env.appName`.
3. **Default exclusions.** Exclude secret-looking keys in `settings.json` (tokens, passwords, API
   keys). Exclude machine-specific paths, such as absolute paths under the local home,
   `*.path`/`*Path` keys that point at local binaries, and `remote.SSH.*`. Keep the rule in one
   table that tests can read.
4. **When it runs.** Leaning: on every open, skipping anything that has not changed (a content hash
   per file, and the extension set compared by id and version). Measure first-open cost before and
   after, under the performance rule.
5. **Isolation.** Write only into the home of the person who opened the window. Refuse when the
   workspace uses a shared home (the shared layout). Never write into another person's session.
   Confirm how ADR 0016 shows which layout and home a workspace has.

## Next step

1. Finish the `how` pass with three explorers: client open path, server user and home, harness.
2. Run `architect`, then send the decision list above to thread ec2e5833 with a firm recommendation
   for each.
3. After the answer, run the throughput checkpoint and delegate the build to a worktree subagent.
   Verify with `scripts/vscode-remote-acceptance.mjs` and `suite.ts` in Docker-in-Docker on Xvfb.
   Use a throwaway `--user-data-dir`, a pinned `UserKnownHostsFile`, and scratch outside `/tmp`.

Note: the acceptance run and DinD container visible on this machine at hold time
(`st-vscode-…-dind`, `node scripts/vscode-remote-acceptance.mjs`) belong to the
`vscode-redesign-study` worktree, not this branch, and were left alone.

This WIP commit is notes only, so the forced typecheck and lint were not run for it.
