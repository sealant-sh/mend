# A person's own MCP servers

Status: accepted 2026-11-09, for 0.37. Yiannis asked for it on 2026-11-09: "Can we add real MCPs to
Claude right now? Maybe rename the Executor tab to MCPs, have a list of MCPs we can add, and have
the Executor there. I'm talking about things like Figma that won't be added via Executor because
they only work with Claude Code." Read against Mend `4b58b0d5ce`. Builds on
[ADR 0010](0010-secret-files.md) (secrets sealed per person),
[ADR 0016](0016-per-person-harness-homes.md) (per-person homes and shared steering, whose decisions
6 and 7a this amends) and [ADR 0022](0022-executor-per-organization.md) (the organization's
Executor).

## Context

A person wants the MCP servers they use every day in every session they start: Figma's
`https://mcp.figma.com/mcp`, a GitHub stdio server with a token, their team's HTTP server behind a
header. Some of these only work with a harness's own client, so they cannot go through the
organization's Executor. Today a person can reach them only by typing them into each session's
harness, and a session's harness home is the worktree's, so whatever they type there is saved for
the next person or lost with the executor.

Four facts shape the design:

- Core keeps every argv for good, and another user can read `/proc/<pid>/cmdline`. No value may ride
  argv.
- Under shared control a person executor runs each turn as its sender, in a conversation home `H`
  that changes hands at every change of sender. An executor that shares one home runs everything as
  root, on its holder's logins (ADR 0016, 7a).
- Each harness takes servers differently. Claude merges every `--mcp-config` it is given, Codex
  reads `-c`/`--config` overrides, pi reads servers only through an MCP extension in its profile,
  and opencode reads an environment overlay.
- Claude keeps MCP OAuth sign-ins in `.claude/.credentials.json`, which Core rewrites whole when it
  places or refreshes a login.

## Decision

### 1. A server is the person's own, kept sealed in Mend

A row in `mcp_servers` (migration `0212_mcp_servers`) with `scope = 'person'` and the person's
account. It is account-wide, like secret files: it follows the person across organizations. A
nullable `organization_id`, held null by a CHECK, leaves room for servers an organization shares
later.

- The **name** is the key and never changes: `^[a-z][a-z0-9_-]{0,47}$`, unique per person. `mend`,
  `executor` and names that start with `mend-` are Mend's own.
- The **transport** is `stdio {command, args}`, `http {url}` or `sse {url}`. A URL is http or https,
  with no user name or password. A URL is sealed like a header: the row keeps it as shown
  (`mcpUrlShown`: each query value, the fragment and a token-like path segment become `…`, so
  `?tavilyApiKey=…`) with the full URL sealed beside it in the same `transport` column
  (`sealedUrl`), present only when the two differ. Every surface reads the shown URL; only the
  launch unseals the full one. A save that sends back the shown URL keeps the sealed one, so an edit
  or an on/off switch never stores `…`; any other URL replaces it. A row saved before URLs were
  sealed holds its full URL plain: every read shows it redacted, and its next save seals it.
- **Every** variable value (stdio) and header value (HTTP, SSE) is a secret, sealed with the
  machine's secrets key (`SecretCipher`) as one JSON object per server. The transport decides which
  kind a server takes, so nothing is chosen and nothing can be stored plain by mistake. Every
  surface shows the names (`env GITHUB_TOKEN · saved`), never a value.
- `/me/mcp-servers` lists, puts and removes them, behind `PersonCredentialOnly`: an access key can
  neither place a command that runs in the person's sessions nor list what they run.
- No audit events in 0.37. An account-wide row in one organization's audit log would show a person's
  own tools to that organization's owners.

### 2. Delivered at launch, by flag, never by value

Each agent process gets its person's servers that are on, next to Mend's own `mend` server and the
repository's `.mcp.json`. One pure planner (`planPersonalMcp`) decides what each harness gets; the
engine reads, unseals and writes (`personalMcpFor`).

| Harness  | What it gets                                                                                                                                                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | A second `--mcp-config=<dir>/claude.json` after Mend's own inline one. The file holds every server with its values.                                                                                                                                                                                                         |
| Codex    | One `--config=mcp_servers.<name>={…}` per server. A stdio server runs `/bin/sh <dir>/codex/<name>.sh`, a script that exports its variables and `exec`s its command. An HTTP server with headers gets `http_headers_helper = "cat '<dir>/codex/<name>.headers.json'"`. An SSE server is skipped: Codex has no SSE transport. |
| pi       | Nothing on argv. The servers are merged into the delivered pi profile's `mcp.json`; the person's Mend list wins a name, as the explicit and newer source. With no pi profile nothing is merged, because pi reads servers only through an MCP extension there.                                                               |
| opencode | Nothing in 0.37.                                                                                                                                                                                                                                                                                                            |

- **Files.** `<dir>` is `<home>/.mend/mcp` in a person's own home, which is never saved (ADR 0016,
  decision 2: only `PERSON_SAVED_STATE` links into the saved directory), or `/run/mend/mcp` for
  root, outside every capture root. Every file is written 0600 through the pickup writer, as the
  process's user, never through a link. Nothing goes into the process's environment: Codex's scripts
  and helpers hold the values, so two servers that want the same variable name never meet.
- **One attached word per Codex server.** Core takes at most 64 words a command; a prompt's
  follow-up already uses most of them, so each server is `--config=…`, not `-c` and a value.
- **Argv a process row records.** A process row records the command before Mend adds any MCP flag,
  Mend's own included. A stopped terminal's follow-up wraps the agent's command in a prompt decoder
  that keeps the command as a trailing vector (`withPrompt`), so the flags are added at the launch,
  never baked into the recorded script. History preparation records its composed command the same
  way.
- **Every launch site has to say.** `withMendMcp(argv, personal)` takes a required `PersonalMcp`
  (`Delivered` or `None(why)`), and `withHarnessSetup`, `withHarnessBootstrap` and
  `conversationArgv` require it in turn. A new launch path does not compile until it says whose
  servers it carries, or why none.
- **The session line.** A launch that delivered says so after the start
  (`MCP servers · figma, github · not for Codex: slack (SSE)`), and one that did not says why
  (`MCP servers not delivered: …`). A server list that cannot be read, unsealed or written never
  fails the launch: the agent starts without it and the line says so.

### 3. Whose servers a process carries

One rule (`mcpPersonOf`), used for delivery now and for crediting a sign-in later: a process carries
at most one person's servers, the person whose login it spends, and never where another person's
turn runs.

- **A person executor.** The servers of the person the process runs as. A steer hands over to a
  process of the steerer's, with the steerer's servers from the steerer's own home. A join carries
  the joiner's. A terminal never hands over and carries the owner's.
- **An executor that shares one home (ADR 0016, 7a).** Its holder's servers, only in the holder's
  own session and never in a once-shared conversation, whose turns other people send. Another
  person's join there, and a once-shared conversation, get none of their own, and the line says why
  (`this workspace shares one home, and the session is under shared control`). pi is the exception
  to "none": the home holds one pi profile, so a joiner's pi that starts while a pi already runs
  there runs on the holder's profile, its MCP servers included, and the joiner's line says so. Filed
  as a follow-up. A terminal under shared control stays 7a's documented exception: whoever types in
  the owner's terminal uses the owner's servers, and the Shared control confirm says so.

### 4. The Executor is a row in the list

Settings → You → **MCP servers** lists the person's servers and, for someone in an organization, the
organization's Executor as its own row ("Executor · Mend-run" or "Executor · own"). Opening it shows
the Executor's existing controls with their existing wording: "service", "Mend-run", "own", "Mend's
member". The old organization tab redirects there.

### 5. Sign-ins that last are kept by Mend, made by the harness

For an OAuth server such as Figma, the person signs in once through the harness's own flow (Claude's
`/mcp`). Mend never runs, exchanges or refreshes OAuth itself: the client is the harness.

- **Where the tokens live.** Claude writes a sign-in to
  `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` as `mcpOAuth["<name>|<hash>"]`, whose hash
  covers the server's type, URL and headers. Mend keeps the entry whole, unknown fields and key
  included, as Claude wrote it, sealed with `SecretCipher` in the server's own row
  (`mcp_servers.sealed_sign_in`, migration `0213_mcp_server_sign_ins`). Mend never computes the
  hash. Only the person's listed HTTP and SSE servers have one, matched on name and URL. Every
  surface shows `signed in · observed <time>` and nothing of the entry.
- **Harvest.** Mend's helper (`mend mcp`, a stdio child of every Claude process, as its user) looks
  for the `claude.json` Mend delivered to that user (`<home>/.mend/mcp`, or `/run/mend/mcp` for
  root). Where it exists, the helper stats the credentials file every 2 s, reads it only when its
  mtime, size or inode changed, and once more when its stdin closes. It posts the entries of the
  delivered HTTP and SSE servers that changed since its last post to `POST /session/mcp-sign-ins`,
  authenticated like `/session/mcp` and naming its agent process. The channel applies `mcpPersonOf`
  to that process and refuses `Withhold`, so a sign-in is credited only to the person whose servers
  the process carries. Mend then stores it in one statement, only when its `expiresAt` is strictly
  later than the one kept. Posting twice changes nothing, and an entry missing from the file deletes
  nothing.
- **Put-back.** When a Claude launch's person has kept sign-ins for delivered servers,
  `personalMcpFor` writes `<dir>/claude-sign-ins.json` (0600) and `withMendMcp` puts Claude behind a
  `sh -c` program that merges it into the credentials file: an entry only where its key is missing
  or holds an older `expiresAt`, never `claudeAiOauth` or any other key, through a new 0600 file
  renamed over a regular file (a symlink is refused), creating the file and directory when absent.
  It runs inside the seed's wrapper, so it comes after the seed's login write, and at exec, after
  Core's placement in R, in H and in root's home. A merge that fails says one line and Claude
  starts. The process row records the command from before it, like every MCP flag.
- **Forget.** Forget (`DELETE /me/mcp-servers/:name/sign-in`), and a save that changes the server's
  URL or transport, delete the kept sign-in and set `sign_in_reset_at`. A post from a process that
  started before then is refused, so an old process cannot bring it back. The home still holds the
  old entry, so until the person signs in again, each Claude launch's put-back removes that server's
  entries (matched on name and URL) from the credentials file; otherwise the next session's helper
  would harvest them again.
- **Codex** keeps its MCP OAuth sign-ins in its own store, not in Claude's file. Mend keeps no Codex
  sign-ins in 0.37.

### 6. What the isolation means

ADR 0016 gives everyone in an executor passwordless `sudo` and says plainly that this is not
isolation. The guarantee here is about what Mend delivers through its own paths: one person's
servers and sign-ins are never delivered to a process another person's turn runs in. Mend never
claims the files are unreadable to another person in the same executor.

## What was observed

- Claude Code 2.1.318 and the pinned 2.1.292, scratch config directories, a local stdio server and a
  local HTTP server: with Mend's inline `--mcp-config=` and a second `--mcp-config=<file>`, a
  stream-json `mcp_status` control request (no Anthropic login) reported both inline and file
  servers `connected`, and the HTTP server received the file's headers.
- Codex 0.162.1 and the pinned 0.160.1, scratch `CODEX_HOME`: `codex mcp list` read
  `--config=mcp_servers.<name>={command="/bin/sh", args=[…]}` and
  `{url=…, http_headers_helper="cat '…'"}`; an app-server `mcpServerStatus/list` started the stdio
  script with its exported variable and reached the HTTP server with the helper's headers. Codex
  runs the helper with `sh -c`, a cleared environment and its default variables, and reads a JSON
  object of headers from its stdout.
- Phase 0 (Claude Code 2.1.318): `/mcp` prints the sign-in link and accepts the pasted `localhost`
  callback address; sign-ins are kept under `mcpOAuth["<name>|<hash>"]` in `.credentials.json`; a
  copied credentials file reconnects without signing in again; a refresh that rotates the token
  invalidates every other copy.
- Sign-ins that last (Claude Code 2.1.318, MCP SDK 1.32.2's demo OAuth server on loopback, scratch
  config directories): after `claude mcp login demo --no-browser` in directory A, Mend's helper
  posted one entry, `demo|0022233f05dbeaba` with `serverName` `demo`, as its agent process. In a
  fresh directory B holding only a placeholder `claudeAiOauth`, the put-back program merged that
  entry and `claude mcp list` reported `demo … ✔ Connected`, where a third directory without it
  reported `! Needs authentication`. B's `claudeAiOauth` was unchanged and the file stayed 0600.

## Known limits

- **opencode** gets no personal servers in 0.37; its session line says so. Filed.
- **SSE on Codex**: skipped, said on the line.
- **A URL that may carry a key, on Codex.** Codex is given an HTTP server's URL on argv, and vendors
  document keys in URLs (`?tavilyApiKey=…`, `?exaApiKey=…`, a token as a path segment). Codex reads
  servers only from argv or its own `config.toml` (the person's, captured in a home that shares one,
  or the executor's, shared by every person), so a server whose URL has a query, a fragment or a
  token-like path segment is left out of Codex and the line says so (`mcpUrlMayCarryKey`). Claude
  and pi get the full URL in their 0600 files. Settings, `mend mcp add` and the guide advise a
  header for a key.
- **What is shown is a rule, not a parse of every vendor.** A key in the host name, or in a path
  segment shorter than 20 characters or without both letters and digits, shows as typed.
- **The conversation records what a steerer's own servers did.** Their calls and results land in the
  shared conversation, which the owner and every steerer read. The guide says so.
- **A name the repository also uses.** Claude decides between its own `.mcp.json` and a
  `--mcp-config` server of the same name. Codex merges `--config` tables into a repository's
  `.codex/config.toml` recursively, so fields of a same-name entry mix. Rare; filed.
- **A conversation already running when shared control is turned on**, in an executor that shares
  one home, keeps the servers it started with until it next starts.
- **Removed servers' files** stay in the person's own directory until the executor ends; nothing
  names them on a later argv.
- **Two live Claude sessions of one person** each refresh their own copy of a sign-in. With a
  provider that rotates refresh tokens, whichever refreshes first invalidates the other's. Mend's
  stored copy stays the newest.
- **Core rewrites Claude's whole credentials file** when it pushes a refreshed login, about every 7
  hours, which removes restored sign-ins from a running session until it starts again. The stored
  copy is untouched. Core should merge only the login (PLATFORM-FEEDBACK, 2026-11-09).
- **A Forget during a running session in the same home.** A session that started before the Forget
  can still refresh and rewrite its copy into the home's file, and a session that started after it
  reads that file and keeps the sign-in again. It needs two live sessions in one home around a
  Forget. Filed.
- **A credentials file with sign-ins and no login.** The seed writes Claude's login only when the
  credentials file is absent. A put-back in a launch without a Claude OAuth token (an API key login)
  creates the file with sign-ins only, as Claude's own `/mcp` does, so a later launch with a token
  finds a file and its seed writes no login. Filed against the seed.

## Consequences

- A person adds a server once, in Settings or with `mend mcp add`, and every Claude, Codex or pi
  session they start has it, with no value on any argv, process row or environment.
- The next engineer adding a launch path cannot forget the person's servers: the compiler asks.
- Delivering costs one read, and one exec as the process's user when the person has servers.

## Decision log

- 2026-11-09: accepted for 0.37 (Yiannis). Personal, account-wide servers; organization-shared
  servers later. Delivery by file and flag; the sender's own under shared control; withheld in a
  shared home's once-shared conversation. ADR 0016 decisions 6 and 7a amended (its log, same date).
- 2026-11-09: two `--mcp-config=` occurrences load on Claude 2.1.292, so Mend's own inline config
  stays as it is and the fallback (one file holding Mend's server too) is not built.
- 2026-11-09: Codex servers ride `--config=` (one word each) instead of `-c` and a value, to stay
  inside Core's 64 words.
- 2026-11-09: sign-ins that last built (decision 5). The put-back also removes a forgotten server's
  entries from the home, because the reset time alone cannot stop a new session from harvesting the
  old entry it finds there.
