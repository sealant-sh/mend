# Mend for your coding agent

Mend runs your coding agent in a recorded git worktree. The person can read the conversation, review
the change and its evidence, see previews, and take over the same session from their browser or
terminal. Claude Code, Codex, T3 Code and pi can set up and run Mend with a shell.

Start with Node.js 22.13.0 or newer:

```sh
npm i -g @sealant/mend
mend agent install --json
```

Read a SKILL.md path returned by the installer. It installs Mend's bundled skill in every supported
agent home it finds under ~/.claude, ~/.codex and ~/.pi/agent. The skill covers choosing or setting
up a server, first-account creation, browser sign-in, adoption and Git access, provider logins,
readiness, conversation sessions, steering, shell review, landing, previews, screen observations,
proof downloads and handing the session to the person.

The interface is the mend CLI plus that skill. There is no outside-agent MCP server to configure.
Use --json and follow the returned error code, message and fix. Every wait has a timeout.

The person clicks Authorize and signs in to their chosen provider once. On a fresh local server,
setup creates their first account without a password passing through the agent and signs the local
CLI in. The person sets a web password through the one-time link. Ask them before adding a deploy
key or forwarding an agent permission response. Keep passwords and tokens out of agent output.

An outside agent can observe a session's screen and fetch its proof artifacts. Screen input stays
with the session's own agent and the person's takeover in Mend.

More details: https://docs.mend.run/guides/your-coding-agent/
