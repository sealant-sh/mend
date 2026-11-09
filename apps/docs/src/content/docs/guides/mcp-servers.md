---
title: Use your own MCP servers
description:
  Add the MCP servers you use, such as Figma or a GitHub server with your token, once, and every
  Claude, Codex or pi session you start gets them.
---

Your MCP servers are yours: you add each one once, and every session you start gets the ones that
are on, next to Mend's own `mend` server and the repository's `.mcp.json`. They follow you across
organizations. Nobody else's turn gets them, except in a workspace that shares one home, as
[Shared control](#shared-control) says.

Mend keeps every variable and header value encrypted and never shows it again after you save it.
Sessions receive the values in files only your agent's user can read. No value appears on a command
line, in a process list or in the agent's environment.

## Add a server

In Mend, open **Settings → MCP servers** and choose **Add**. Or use the CLI:

```sh
# An HTTP server, such as Figma's
mend mcp add figma https://mcp.figma.com/mcp

# An HTTP server that takes a header
mend mcp add linear https://mcp.linear.app/mcp --header Authorization

# A stdio server that takes a variable
mend mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN -- npx -y @modelcontextprotocol/server-github

# An SSE server
mend mcp add events https://mcp.example.com/sse --sse
```

The CLI never reads a value from the command line, where it would land in your shell history. In a
terminal it asks for each value without echoing it. In a script, send `NAME=value` lines on stdin:

```sh
op read op://dev/linear/token | sed 's/^/Authorization=Bearer /' \
  | mend mcp add linear https://mcp.linear.app/mcp --header Authorization
```

Mend seals a server's URL the way it seals a header. Settings and `mend mcp` show the parts that may
hold a key as `…`, such as `https://mcp.tavily.com/mcp/?tavilyApiKey=…`. Saving that URL again, as
an edit does when you leave the field alone, keeps the one you typed. A key is still better in a
header than in the URL: Codex is never given a URL that may carry a key (a query string, a fragment,
or a path segment that looks like a token), and the session line says so.

A server's name is 1 to 48 lowercase letters, digits, `-` or `_`, starting with a letter. `mend`,
`executor` and names starting with `mend-` are Mend's own. You can keep up to 16 servers.

List them with `mend mcp`. Turn one off with `mend mcp off <name>` and on again with
`mend mcp on <name>`. Remove one with `mend mcp remove <name>`. To change a server, use Settings.

A session gets the servers that were on when its agent started. Start a new session, or resume this
one, after you change them.

## What each agent gets

| Agent    | Your servers                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | Every server: stdio, HTTP and SSE.                                                                                                                         |
| Codex    | stdio and HTTP servers. Codex has no SSE transport, so SSE servers are left out, and so is a server whose URL may carry a key.                             |
| pi       | Every server, through your [pi profile](/guides/pi/). pi reads MCP servers only through an MCP extension in that profile. Without a profile, pi gets none. |
| opencode | None yet.                                                                                                                                                  |

When a session starts, its line says what it got, for example:

```text
MCP servers · figma, github · not for Codex: events (SSE)
```

If Mend could not deliver them, the line says why, starting with `MCP servers not delivered`. The
agent starts either way.

If a repository's own `.mcp.json` (or `.codex/config.toml`) names a server the same as one of yours,
the agent decides which it uses. Give yours a different name to keep both.

## Shared control

When you steer someone else's session, your turn runs with your own servers, not theirs, and theirs
never reach your turn. What your servers' tools are called with and return lands in that session's
conversation, which its owner and everyone who steers it can read.

In a workspace that shares one home, as described in [Organizations](/organizations/overview/), a
conversation that has been under shared control gets no one's servers, and its line says so. A
terminal session there keeps the owner's servers: whoever types in it can use them. A conversation
already running keeps your MCP servers until its agent restarts. The Shared control confirmation
says both before you turn it on. Another person who joins a workspace that shares one home gets none
of their own servers, and a pi already running there shares its profile with them, MCP servers
included.

## Sign in to a server that uses OAuth

Some servers, such as Figma's, ask you to sign in instead of taking a header. Sign in from a Claude
session in its terminal:

1. Add the server, for example `mend mcp add figma https://mcp.figma.com/mcp`.
2. Start a Claude session, or resume one, so it picks up the server.
3. In the session's terminal, type `/mcp`, select the server and choose **Authenticate**.
4. Claude shows a sign-in link. Select it and copy it, then open it in your browser. Once the
   terminal link fix ships, Ctrl-click (⌘-click on a Mac) opens it directly.
5. Sign in and allow access.
6. Your browser then opens a `localhost` address that does not load. That is expected: copy the
   whole address from the browser's address bar.
7. Paste it into Claude where it asks for the URL, and press Enter. Claude says the server is
   connected.

You sign in once. Mend keeps the sign-in for you, sealed like your other values, and puts it back in
every Claude session you start, so the server is connected without asking again. If Claude renews
the sign-in during a session, Mend keeps the renewed one.

**Settings → MCP servers** and `mend mcp` show a kept sign-in as `signed in · observed <time>`: the
last time Mend saw Claude write it. That says when Mend saw it, not that the server still accepts
it.

To forget a sign-in, choose **Forget** beside it in Settings, or run `mend mcp forget <name>`. Mend
deletes its copy and removes the sign-in from each Claude session that starts from now on, which
asks you to sign in again. A session already running keeps its own until it ends. Changing a
server's URL or transport forgets its sign-in too.

Mend keeps sign-ins only for the HTTP and SSE servers in your list, matched on name and URL, and
only from Claude. Codex keeps its own MCP sign-ins, which Mend does not keep yet.

Known limits:

- **Two Claude sessions at once.** Some servers replace their refresh token each time Claude renews
  a sign-in. If you run two Claude sessions with the same server, the first to renew can sign the
  other out. Sign in again in that session; Mend keeps the newest sign-in for the next one.
- **Long sessions.** About every seven hours, Mend's platform rewrites Claude's credentials file
  when it renews your Claude login, which removes the MCP sign-ins from a running session. The
  server asks you to sign in again in that session, or the next session you start has it back.
- **Shared workspaces.** Mend keeps and puts back sign-ins only in your own home. In a workspace
  that shares one home, a sign-in lasts only as long as that workspace, because anyone working there
  could use it.

## Your organization's Executor

**Settings → MCP servers** also lists your organization's Executor as its own row, when you are in
an organization. It gives agents services such as Linear through Executor; see
[Services through Executor](/guides/executor/).
