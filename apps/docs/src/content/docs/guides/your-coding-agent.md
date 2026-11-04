---
title: Use your own coding agent
description: Let Claude Code, Codex, T3 Code or pi set up and run Mend from a shell.
---

Tell your coding agent, "Set me up on Mend, mend.run." It can read
[the agent entry point](https://mend.run/agent.md), install the CLI and follow Mend's bundled skill.
It needs a shell and Node.js 22.13.0 or newer.

```sh
npm i -g @sealant/mend
mend agent install --json
```

The installer writes `SKILL.md` into every supported agent home it finds:

- `~/.claude/skills/mend/SKILL.md`
- `~/.codex/skills/mend/SKILL.md`
- `~/.pi/agent/skills/mend/SKILL.md`

It reports the installed paths. Have your agent read one. Reinstalling updates a Mend-managed skill.
A custom skill at the same path is preserved; move it elsewhere before retrying. If no supported
home exists yet, start your coding agent once and retry. No server sign-in is needed to install the
skill. T3 Code can use the skill of its selected agent provider.

## What you approve

Your agent asks whether to run Mend on this machine or connect to an existing server. On a fresh
server it uses your email and display name to create the first account. It never handles a password.
Same-machine setup signs the CLI in directly and gives you a one-time link to set your web password
yourself. For a separate server, click the CLI's Authorize Mend link in your browser.

Sign in to each provider once through its own browser flow. If Mend needs a deploy key to access
your repository, your agent asks before adding its public key. Pending permissions and questions
come back to you; the outside agent forwards the answer you choose.

## The work stays visible

The skill teaches all twelve parts of the workflow:

1. Install the CLI and skill.
2. Pick a local or existing server, or set one up over your existing SSH access.
3. Create the first account and sign in through your browser.
4. Adopt a repository and check observed Git read and push access.
5. Connect your chosen agent login.
6. Read readiness and resolve the blocking items.
7. Start a conversation, wait for its turn and read its history.
8. Send follow-ups, resume, interrupt or stop.
9. Read a pinned change and diff, then send your review comments back.
10. Land the change when you ask, reporting the push and pull request observations.
11. Inspect resources, Services, previews, screen observations and proof artifacts.
12. Give you the same session in the web app, T3 Code, VS Code or your terminal.

Mend's CLI is the interface. There is no outside-agent MCP server. Your agent uses versioned JSON
and bounded waits. Errors carry a code, message and fix. Exit 3 means your answer is needed; exit 4
means something is not ready; exit 124 means the deadline passed and accepted work may still be
running. See the [CLI reference](/reference/cli/) for all command outcomes and options.

An outside agent can save a current screen image and download proof screenshots or videos. Screen
input stays with the session's own agent and your takeover in Mend. A capture describes what was
observed and includes its checkpoint or an explicit unknown source. You decide what it demonstrates.

Every launch returns the session's web link. Open it whenever you want to read the record, review
the change or take over. You can also run `mend attach <session>` in your own interactive terminal.
