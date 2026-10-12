---
extends: opening-a-pr
when: Opening, updating or stacking a pull request in the Mend repository.
---

# Mend pull requests

The rules `AGENTS.md` sets for every Mend pull request, placed at the step of pstack's Opening a PR
playbook where each one applies.

- **Before** "Run `/deslop` over the diff before commit." In a fresh worktree, run `pnpm install`
  before anything else, or `pnpm format:fix` rewrites files the change never touched. After code
  changes, run `pnpm format:fix`. Commit `pnpm-lock.yaml` with the `package.json` change that
  produced it, and never edit it by hand.
- **In** "Use the changed area, such as `pstack` or `poteto-mode`, as the scope." Mend's scopes are
  its app and package names, such as `sessions`, `web`, `cli` or `api-contracts`.
- **In** "Without a built-in PR tool, create a child with" In Mend a `--base` is not a stack.
  Register dependent PRs with `gh stack`: `gh stack init` and `gh stack add` for new work, then
  `gh stack submit --auto --open`, or `gh stack link <bottom> <top>` when the branches or PRs
  already exist. Never hand-rebase a branch and `gh pr edit --base` instead.
- **Before** "Open every PR ready, never as a draft." Run `pnpm exec turbo typecheck --force` and
  `pnpm exec turbo lint --force` on the commit you push, and push only after both pass. Forced, so a
  warm cache cannot pass a stale result.
- **After** "Run `origin pr view <number>` or `gh pr view <number>` before you refer to PR status."
  Add `["mend", <number>]` to the `prs` of the PR's feature, under the version it ships in, in
  `~/Developer/OSS/Sealant/roadmap-site/roadmap.json`, then run `node build.mjs` there. A PR that
  starts a feature the roadmap lacks adds the feature with a `name` and a one-line `description`. If
  that directory is missing on this machine, say so in the report.
- **After** "Push back when feedback drifts from intent." Never merge a version PR or push a release
  tag. Those wait for the owner.
