# @sealant/mend

## 0.36.0

### Minor Changes

- 4d85059: What Claude Code learns about a repository now outlives the session. Mend keeps each
  person's agent memory per project: every session you start on it receives your memory, and what
  the agent learned is saved back when it ends, keeping both sides' lines when two of your sessions
  changed the same file. A second session of yours in a running workspace does not deliver memory
  that is already in place. `mend memory import`, run in a checkout, brings the memory Claude Code
  keeps for it on your machine. A file both sides have is merged keeping both sides' lines, and a
  note's frontmatter is merged key by key, with your machine's differing value kept as a comment.
  Mend remembers what it imported from each checkout on each machine, so the next import from there
  merges only what changed since and does not bring back a file removed in Mend. `--dry-run` shows
  the plan for each file, and every version an import replaces is kept. The import reads no
  transcripts, logins or settings. `mend memory`, `mend memory show` and `mend memory rm` list,
  print and remove your memory.

  Your memory never reaches anyone else's sessions, and is credited only to you. In a workspace that
  shares one home, the server records whose memory the home holds and only that person's sessions
  read it back. A launch in a worktree another person used first saves their memory for them and
  moves it aside, never deleted. A Codex session there that joins someone else's executor starts
  with memory off. Migration 0111.

- 7102a9d: A project's install command is now an "Automatic install" switch in the Dependencies card
  on its Setup page, on for every project. On, in capture mode, Mend picks the command from the
  lockfile at the root of the repository and runs it before the agent starts. The card shows what it
  detects on origin's default branch as last fetched, for example "detected · pnpm install
  --frozen-lockfile · from pnpm-lock.yaml on origin/main", and says "not read" when it could not
  read the tree. A custom command still replaces the detected one. Off, Mend runs no install for the
  project, in a session or in the install that fills the shared dependency cache; an agent can
  install by hand. A dependency tree already in saved state or the shared cache is restored either
  way. In co-located mode Mend runs no install, and the card says so.
  `PUT /api/projects/:id/install-enabled` sets the switch, and queues the install only when it goes
  from off to on; `GET /api/projects/:id/install-detection` reads the detected command. Migration
  0110 adds the column.
- 815ddef: A Claude workflow started in a protocol session now shows on the phone while it runs. Its
  card sits on the turn that started it and keeps updating after that turn ends: each phase, each
  agent's state, model, tokens and current tool, and the totals. Background agents and commands get
  the same card. When the workflow ends, Claude starts a turn of its own to report it. Mend used to
  drop that turn, so the result never appeared; it is now recorded, reads "the agent continued", and
  its reply reaches Slack like any other. A message sent while that turn runs waits for it.
  Automatic landing decides that turn by the request that started the workflow. A session whose
  workflow is still running is active: the idle stop never ends it, however long the workflow runs
  or goes quiet, and the phone shows it working. Once the workflow ends, the idle minutes count from
  then. A task whose agent process ended reads stopped.
- 974f020: Codex memory is carried per person per project, like Claude's. Mend turns Codex's memory
  on in every Codex session it starts, keeps Codex's memory folder and summary database with your
  other memory, and carries your earlier Codex conversations on the project into each new session,
  so Codex has something to learn from. `mend memory import` also brings the summaries Codex made on
  your machine of conversations held in the repository. `mend memory show codex:MEMORY.md` shows
  Codex's files. Codex's summary databases are merged by conversation.
- 5bbbe92: Workspaces carry `bun` and `unzip` by default. New installs list both in the default
  workspace packages, and migration 0127 adds them to every saved managed family environment that
  lacks them: the instance's, each organization's and each project's own. A custom base environment
  is left as it is. Each project's image rebuilds once, on its next launch, and grows by about 80
  MB. Standby workspaces from before are replaced, since their image no longer matches. pstack needs
  bun for `orch`, `watch-pr` and `ship-pr`. The machine scan under Suggestions from this machine
  also offers `bun` and `unzip`.
- 719ccde: `mend server upgrade --from-preview` moves a server on a preview numbered before the next
  channel (`0.36.0-preview.K`) to a next build or a new-style preview of the same version, once.
  Such a preview sorts above both, so a plain upgrade refuses it as a downgrade; the refusal now
  names this option. Before anything stops, the upgrade reads the migrations both databases applied
  and refuses, naming them, when the target image lacks one, changed one (Sealant's, by hash), or
  would skip one (a Mend migration below the highest id applied). A failure before the target starts
  recovers the preview's own image, as any upgrade does.
- fa75714: A Stop on Garage, the bucket `mend server setup` installs, no longer waits for its upload
  links to expire before its final save seals. Before, every such Stop waited about 10 minutes,
  longer after a large upload. Workspaces now send each upload's SHA-256 (sealantd 0.20), and Mend
  binds every upload link to the bytes it was minted for: Garage refuses any others through it, so a
  link can replace nothing, and the seal stands once the save is read back. An object up to 5 GB
  goes up as one bound upload instead of in parts. A restart of Mend holds no Stop. Mend reads a
  save back once, and checks packs on worker threads, up to eight at a time, as they arrive rather
  than when the session stops. A Stop still waits for an object over 5 GB, for an executor whose
  sealantd does not send SHA-256 (one started before the upgrade), and in the 20 minutes after the
  first start that follows this upgrade.
- 6156c33: `mend server setup` on a terminal with no flags asks its questions one at a time, in
  plain words: how people reach this Mend (just this machine, your private network or Tailscale, or
  the public internet with HTTPS), whether VS Code Remote-SSH reaches it from other machines, the T3
  Code gateway, the mirrors, and one organization or several. It reads Tailscale's name and address
  and what Tailscale Serve forwards, where your domain resolves, and whether 80 and 443 are taken,
  and says what it observed. On an existing install it shows what is saved and lets you change one
  thing. It ends with what changes and the same command with flags, and applies on a yes.

  Flags keep their meaning, and each changes only what it names. `--declare <item>` adds to the
  saved statements and `--declare none` clears them, `--undeclare <item>` takes one back, and
  `--origin none` clears the extra origins. A run with flags on an existing install says what it
  changes. With no terminal and no flags, a fresh install is refused and the message names the
  flags; `--yes` takes the defaults.

- 62ae74f: `mend run` works for scripts. It prints the command's output (it printed record summaries
  such as `pty-out 9B @0`) and exits with the command's exit code. Its own lines go to stderr, so
  `out=$(mend run -- git log -1)` holds the command's output alone. `--detach` returns once the
  command runs, and `--json` prints the session and process ids (and, without `--detach`, how the
  command ended).

  A command the platform would refuse is refused before anything is created: more than 64 words or 1
  MiB, a word over 131,071 bytes, a program with leading or trailing whitespace, or a NUL byte. An
  argument may be empty, start with a newline or span lines, so a `bash -lc` script that starts with
  a newline runs (it used to create a session and then fail its launch).

  New: `mend logs <session> [--follow]` prints any session's recorded terminal output, and
  `mend wait <session> [--timeout <duration>]` (`90`, `90s`, `5m`, `1h`) returns once its command
  ended, with its exit code (124 on timeout).

  `mend run` and `mend logs` give stdout no more than a slow reader takes and exit only once it has
  all of it, waiting at most 5 seconds at exit for a reader that takes nothing. A signal stops
  watching with exit 128 + its number (130 for Ctrl+C) and puts the terminal's modes back, for
  `mend logs` too. Output that could not be delivered in full fails the run (exit 1).
  `mend wait --timeout` bounds every read and retry, never counts a previous process's end while a
  resume starts, and takes `--process <id>`.

- e720140: One model picker, the same on every client, and the server owns the list. The models each
  harness offers live in a table on the server, editable in place, and `GET /api/harnesses/models`
  hands every client the same list with the default and the efforts each model takes. Claude is
  offered by family alias (`fable`, `opus`, `sonnet`, `haiku`), which Claude Code resolves to the
  latest model of each family; a Claude session with no model chosen runs the latest Fable instead
  of Fable 5. Codex lists what `codex debug models` offers, GPT-6.1 Sol first and the default, and
  gains its `ultra` effort. The web composer, the phone's session composer and the VS Code picks
  choose from it with the default preselected; `mend models` prints it, and `--effort` takes `ultra`
  where the model does. Every picker offers only the efforts the chosen model takes, a launch turns
  an effort the model cannot take into the highest it can, and a saved model that is no longer
  listed reads as the default. Every session records the model and effort it was started with: the
  session page, the phone's session header and `mend sessions` show them.
- 7e23de3: Hot sessions keep standby workspaces with per-person workspaces on. A standby starts in
  the layout its owner's new worktrees would run in. Where they run per person, it starts as its
  owner: their own Linux user, their logins written into their own home, no dotfiles at start, and
  its restore giving the worktree to them and the `mend` group. Their next session in a new worktree
  of theirs claims it, and the workspace's per-person preparation runs then, as a cold per-person
  launch's does; their dotfiles are fetched while the standby moves onto the worktree. Where new
  worktrees run with one shared home, standbys start with one shared home, as before.

  A standby serves only a launch decided in the layout it started in, for its owner, in a worktree
  they started: another person's session, the operator's `harnessLayout` asking for the other
  layout, or a worktree that has already run per person starts cold, and is never handed a standby
  that would then be stopped. Once claimed, a standby's layout stands: if Mend learns between the
  claim and the launch that the image cannot run per person, the launch runs with one shared home in
  that standby and says why. While the Sealant control plane cannot be asked, the pool keeps the
  standbys it has. A database migration records each standby's layout; standbys from before it start
  with one shared home, as they did.

  A claimed standby whose worktree changed since the claim is stopped before anything runs in it,
  and the session starts cold. A change to a person's dotfiles does not replace their standbys,
  which fetch dotfiles when claimed. While the Sealant control plane cannot be asked, an image known
  to run with one shared home still has its standbys claimed.

- 0dc3fde: Per-person workspaces (ADR 0016) are on by default. Each person who runs anything in a
  new worktree's workspace gets their own Linux user and home, and everything they run runs as them:
  their agent, shells, Services, `git push` and the `mend` helper, with their own Mend key or signer
  and Git author. `MEND_HARNESS_LAYOUT` is `person` unless set (an empty value counts as unset);
  this includes a loopback server on the capture store, the default `mend server setup`.
  `MEND_HARNESS_LAYOUT=shared` keeps new worktrees on one shared home. A worktree that has run per
  person stays per person whatever the setting.

  Each person's agent runs on their own Claude, Codex, GitHub and ChatGPT logins, written into their
  own home and removed when their last process there ends, never on another person's. A session
  whose owner has not connected the provider its harness needs is refused before it starts, whether
  it is the first in the worktree or a join:
  `Connect Claude to start a session here. Connect it in Settings → Connected accounts, or run mend connect claude.`
  Logins, the session token and the Git author reach the home through a single-use pickup only that
  person can redeem, never through a command's arguments. The workspace's own token is refused for
  Git and the helper.

  Everything Mend delivers goes into each person's home, as them: skills, agent memory, secret
  files, the pi profile, carried Codex conversations, the default shell profile and dotfiles. Each
  person's conversations and memory are read back from their own saved directory, so two people in
  one worktree each resume their own conversation. Your agent waits for your dotfiles' `install.sh`
  when you started the workspace, or when "Start my agents after install.sh" is on
  (`PUT /api/dotfiles/start-after-install`). Otherwise it starts beside it and the session line says
  `install.sh running`, then `install.sh finished after the agent started`. Dotfiles that take over
  two minutes leave the agent starting anyway (`dotfiles still applying`), and Mend puts its links
  back once they land. When Sealant restores a worktree saved per person, each person's saved files
  come back as theirs and the worktree is given to everyone working in it, so each person's
  processes can edit it and use `sudo`.

  Where a workspace cannot run per person, a new worktree runs with one shared home and the session
  says why: a nix image, an image without `sudo`, an image Core reports it cannot run that way, a
  Kubernetes or Cloudflare workspace runtime (ruled out before any launch), a Docker host that sets
  no-new-privileges (checked before anyone is made), or a Sealant that does not run processes as a
  person. A worktree already saved per person is refused there, with the reason. A remembered "no"
  is checked again by the next shared launch when a shared workspace can see every reason (no
  `sudo`, no ACLs and the like), and after a day when a person could not be made; a "no" from
  no-new-privileges, an owner map refused or Core is kept until the image changes. A per-person
  workspace's first setup sends one short line per member of the organization, so an organization of
  any size stays far below Linux's limit on a command's length.

  Starting a session where someone else's runs says that everything you run runs as you, on your own
  logins, but either of you can read the other's files, logins included. A live session reads
  `Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.`
  A turn that waits for another person's agent says what it waits for. The API's session list and
  view list the people live in each workspace (`livePeople`). Everyone in a per-person workspace has
  passwordless `sudo` and can read the others' files: see Known issues.

- 4f26ac6: pi and opencode run as Mend sessions beside Claude Code and Codex: `mend pi`,
  `mend opencode`, and the web and VS Code launchers. Both run in the unified image (Sealant 0.39
  bakes them in) without permission prompts: opencode through its own permission setting at launch,
  never by writing your opencode config; pi asks none, and Mend answers its project-trust question
  with `--approve`. pi takes a model, a thinking level and an opening prompt, keeps its home
  (`~/.pi`: settings, sessions, extensions and packages) with the session, resumes with `--session`,
  and gets Mend's workspace note and skills in its own folder. opencode opens its TUI on the prompt,
  keeps its data and state directories with the session (its conversations, the model it last used,
  its prompt history), and reads Mend's note and skills from Claude Code's. A stopped opencode
  session resumes its own conversation (`opencode --session <id>`), never another session's in the
  same worktree; when Mend cannot tell which conversation is the session's, the resume is refused
  and says so, and a shell resume opens the shell. Neither tool's logins are kept with the session:
  not their `auth.json`, and not opencode's MCP logins (`mcp-auth.json`).
- 36e7fd3: `mend connect pi` sends your pi setup to Mend, and every pi session you start receives
  it: your extensions, themes, prompt templates, settings, `mcp.json` and keybindings. A setup Home
  Manager links in is read through its links, and a package named by local path is copied in. Before
  pi starts, the session installs what your extensions import and the packages your settings
  declare. A package that fails to install, such as one that needs a compiler the image lacks, is
  left out of that session and the terminal says why, instead of stopping pi. Settings changed
  inside a session keep their values. `--dry-run` shows what would be sent and what stays on your
  machine: your login, sessions and installed packages never leave it.
- d5464b9: A pull request the agent opens with `gh pr create` is recorded when the turn that opened
  it ends, not when the agent stops. The look reads the pull request the turn named, in a command's
  output or the agent's own message, and keeps it only when GitHub says it was opened during that
  turn; it runs before automatic landing decides the turn, so a landing updates that pull request
  instead of opening a second. Mend now keeps each pull request's title, and the project and
  worktree lists carry each change's newest pull request (`#412 · open`, the state GitHub last
  reported, its title and URL) from one indexed read, never from GitHub. The web app's Now page and
  project worktree tree show it on each row, opening GitHub in a new tab. Migration 0104 adds the
  title column and that index.
- 00504e1: Any project of the store can be added to a running session from inside its workspace:
  `mend repo add <project>` puts a worktree of that project at `/workspace/repos/<name>`, on a
  branch of its own for the session, and `mend repo list` and `mend repo projects` show what is
  there and what can be added. Each repository is a worktree of its project, so it keeps its own
  change. On a capture-mode server the files are saved with the main repository's captures and come
  back on a resume; the session page lists each repository with its state and how it is saved. The
  review of a repository's own change follows once the capture daemon carries repository roots
  (docs/adr/0011-repositories-in-a-session.md). Removing a worktree that holds repositories refuses,
  naming each, and offers **Remove anyway** (`force=true`, `mend worktrees rm --force`). A private
  project can be added only from a session in another private project of yours; the refusal says
  why.
- d58ace9: Secret files: a file you keep in Mend, encrypted at rest, written into every session you
  own before its agent starts, such as `~/.aws/credentials`, a kubeconfig or an `.npmrc` token file.
  `mend secrets add <path> --from <file>` keeps one (or reads stdin), `mend secrets` lists them by
  path and size, `mend secrets rm <path>` removes one; the web app's settings page has the same list
  with add and remove, and the phone shows it. They are yours alone, the content never comes back
  out of the server, and a secret file is never captured: it goes into your own home directory in
  the workspace, outside what sessions capture, a path under a captured directory such as `.claude`
  is refused, and the workspace refuses to write through a symlink. In a workspace someone else
  launched that shares one home, none of your secret files is written, and the session line names
  them: `secret files · 1 not written · this workspace is another person's · ~/.aws/credentials`.
- 2dda87f: The packaged server knows its edge and its posture. `mend server setup --edge <host>`
  runs the Caddy TLS edge in front of Mend: the repository's `compose.edge.yaml` and `Caddyfile` are
  written into the install's generation beside `compose.yaml`, `MEND_EDGE_HOST` goes into
  `server.env`, the browser origin becomes `https://<host>` and Mend's own port stays on loopback.
  `--exposure` and `--tenancy` declare the posture the same way, and with `multi` or `public` the
  multi mode gate's settings follow (`MEND_SOURCE_POLICY=tenant`, `MEND_CAPTURE_REQUIRE_SIZES=true`,
  and for `public` `MEND_URL_BEARERS=refuse`) through a `compose.posture.yaml` that reads every
  value from `server.env`. Every `start`, `restart` and `upgrade` runs the generation's overlays
  with its `compose.yaml`, so an upgrade never drops the edge or the posture; `--no-edge` takes the
  edge away. `mend server status` reports the edge host, whether its container runs and whether
  Caddy's data holds a certificate, the exposure and tenancy declared beside what the running server
  observes, and, when this machine is signed in as the operator, every item of both gates.
- 9538d48: `mend server setup` runs two mirrors beside Mend, on by default: an npm mirror (nginx
  caching registry.npmjs.org, capped at 10g, least recently used out) and a Docker mirror
  (registry:3.1 caching Docker Hub, each layer kept seven days after it was fetched). A guard runs
  the Docker mirror: it clears the cache when it passes its cap (20g) and pauses the mirror while
  less than 5 GiB is free on its disk; session Docker daemons pull from Docker Hub meanwhile.
  Neither mirror publishes a host port. Each has a healthcheck that passes without reaching Docker
  Hub or registry.npmjs.org. `mend server upgrade` adds both to an install from before them.
  `--no-npm-mirror`, `--no-docker-mirror`, `--npm-mirror-max-size` and `--docker-mirror-max-size`
  change them. `--docker-hub-username` with `--docker-hub-token-stdin` and
  `--docker-hub-public-only` gives the Docker mirror a Docker Hub login, kept in `server.env` only:
  the last flag is the operator's statement that the token is scoped Public Repo Read-only, because
  every session can pull what it can read. `mend server status` reports each mirror's container,
  cache size, free disk and traffic as observed, and a paused Docker mirror with what its guard
  found left of the cache.
- f32ce88: A session's dependency install goes through the server's npm mirror
  (`MEND_NPM_MIRROR_URL`, which `mend server setup` sets): a plain `pnpm install`, `npm ci` or
  `npm install` gets `--registry=<mirror>` when the package manager, asked in the project as the
  person who runs the install (`npm config list` and `<pm> config get registry`, each bounded at 15
  s), reports the public registry and no login for it; when no config file or variable the install
  script reads, nor a `pnpm-workspace.yaml` in the project or above it, sets a registry; when every
  flag the command passes is one that cannot choose its own configuration; and when the mirror
  answers its ping. Scoped registries and their logins are untouched. A run through the mirror that
  fails, for any reason, runs once more as written, against the registry itself, and the engine logs
  `dependency install · retried without the npm mirror`. The public exposure gate's `core-private`
  item names the mirrors when sessions are pointed at them.
- 0dc3fde: In a per-person workspace, the default, shared control runs each turn on its sender's own
  login. A shared Claude or Codex conversation lives in a directory of its own in its owner's saved
  files, and each agent process of it runs in that one conversation home as the person whose turn it
  runs. Neither person's memory, instructions, settings or MCP servers reach the conversation, and
  scheduled prompts are off in it; its transcripts, tool outputs, sub-agents and task list stay with
  the session whoever sends the next turn. A resume continues the conversation's own file and never
  starts a new one in its place: if the file is missing, the turn fails and says so. A terminal
  session with shared control on runs as before: only its owner types there.

  When Bob sends a turn to Alice's conversation, Mend waits until Alice's agent has finished its own
  work (a running turn, background tasks, sub-agents, a goal, a background terminal, a monitor, a
  wakeup), stops nothing, and then continues the same conversation in a process of Bob's, on Bob's
  login, with the turn and any turn sent meanwhile; Bob is recorded as the turn's payer. While the
  turn waits, both people can read why; the person whose agent runs the work, or the session's
  owner, can end a task, a monitor, a terminal or a goal; a scheduled prompt is waited for at most
  10 minutes and then ends with Alice's agent, which the session line says. Alice's agent is never
  stopped on a guess: if Codex will not say what it runs, Bob's turn fails after a minute and
  Alice's agent goes on. Right before the stop Mend looks once more: if Alice's agent started
  something of its own, or Bob withdrew the turn, nothing is stopped. If Bob's process cannot be
  started after Alice's stopped, Alice's is started again on Alice's login, Bob's turn fails with
  the reason, and the next try waits a minute. If Bob's logins cannot be written, Mend tries once
  more, then refuses the turn with the reason; it never runs on another person's agent or login.
  Only the person an agent runs as answers its questions; anyone else is asked to send a turn
  instead. A steerer who has not connected the harness's provider is told to connect it before
  anything is sent, follow-ups and launches that open with their words included. Taking a shared
  conversation over into a terminal continues it in the same place. In a worktree that runs per
  person, only the person who made the worktree keeps Claude's scheduled prompts. The Shared control
  switch asks before it turns on, in words true to the session's workspace: in one that shares one
  home, each turn runs on the owner's logins and Git access, whoever sends it.

  Four rules hold in either layout: shared control cannot be turned on for an opencode session,
  which is one person's, and another person's turn to one is refused; turning shared control off
  cancels the turns other people queued instead of sending them; removing a person from the
  organization cancels the turns they queued; and a queued turn is withdrawn only by the person who
  sent it or the session's owner.

- 3b17bf6: The t3code gateway (docs/adr/0012): `mend server setup --t3-gateway` turns it on.
  t3code's desktop, mobile and web clients add it as an environment, pair with a code from
  `mend pair`, and see this Mend's projects and sessions as their projects and threads: start a
  thread in a new or an existing worktree, from a base branch, send messages and images, @-mention
  project files, queue, edit and reorder what waits, answer approvals, choose the permission mode
  for the agent's next start, rename, stop, archive and delete, read each turn's diff, the thread's
  files and its change, and open a terminal, each as the person who paired and under Mend's own
  rules. t3code shows a provider as connected only when Mend holds that person's login for it.

  It runs in the Mend container on a listener of its own, published on 127.0.0.1 only (port 3120, or
  `--t3-gateway-port`), and setup and `mend server status` say whether it answered there. Reaching
  it from another machine is an exposure the operator puts in front of it: while the gateway is on,
  the public exposure gate lists `t3code-gateway` as open until `--declare t3code-gateway`.
  `--no-t3-gateway` turns it off. Off, nothing of it runs and the gate lists nothing about it.

  It speaks t3code `v0.0.46-nightly.20261010.2922` (a client of the previous nightly still pairs)
  and checks every call against the paired client's scopes, as t3code's own server does. Its state
  file holds every paired person's Mend device token and is readable only by the gateway's user
  (`0600` in a `0700` directory). Failed pairing codes count per client, and a client Mend
  rate-limits gets `429` with Mend's `retry-after`. Revoking a `t3code · …` device in Mend signs
  that client out: t3code shows "Connection failed: The environment credential is invalid." and
  stops reconnecting. While Mend cannot be reached, the gateway answers new connections and snapshot
  reads with a retryable `503`. Deleting a thread's worktree from t3code says that Mend keeps it and
  where to remove it.

- 2ea4fba: Only a session's owner types in its terminal, even while control is shared. Attaching to
  a session someone else owns prints "This session runs in a terminal. Only <owner> types here; they
  can continue it as a conversation.", then streams the terminal without sending your keys or your
  terminal's size; Ctrl+] or Ctrl+C detaches. `mend shell` in someone else's session is refused: a
  shell is the owner's alone, and so is `mend service run`. `mend session share` says so in its
  help.
- d403ac5: The dashboard's panes are numbered the way lazygit numbers its panels: `[1] projects`,
  `[2] worktrees`, `[3] sessions` and `[0]` for the session pane. A digit jumps to its pane, Tab and
  Shift+Tab cycle through them and come back round, and Esc goes back to the pane you came from. `?`
  lists every key the dashboard answers to, read from the same table it runs on. `/` filters the
  focused list, and `+` and `_` cycle the screen mode: normal, half and full. The footer always ends
  with `? keys`. Tab used to step one pane right and stop at the end; Enter, `l` and `→` still do
  that. A digit or Tab into a starting session's pane hands the keyboard to its snake too.
- 17534ac: A workspace SSH key can now be removed. `mend ssh keys` lists every key your account
  registered, from every machine, and marks the one this machine offers;
  `mend ssh keys remove <fingerprint>` removes one, and Settings → Workspace SSH lists the same keys
  with a Remove action. The gateway looks a key up on every new connection, so the next connection
  with a removed key is refused; a connection already open stays open until it ends. You see and
  remove only your own keys. Removing a member removes all of theirs: a key the platform refuses
  stays owed, the removal says how many, and Mend retries until none is active.
  `mend uninstall --home` removes this machine's key, found by its public half, before it revokes
  the terminal's device token, and exits 1 naming the fingerprint when it cannot. The organization's
  audit log records each key registered and removed.
- 2dfea84: `GET /api/worktrees/:id/contents` reads a worktree's files: one file with `path=` (as the
  worktree stands, or at one of its checkpoints with `at=`), at most 1 MiB of it, its size, and
  whether it is binary; or, with `query=`, the lines that match a search across the worktree as it
  stands, untracked files included and ignored ones not, with `caseSensitive`, `wholeWord`, `regex`
  and a `limit` up to 500. A path must stay inside the worktree: `..`, an absolute path and `.git`
  are refused, and a symlink that leads out of the worktree reads as nothing there. The file is
  opened directory by directory without following a link, and what was opened is checked to be
  inside the worktree before it is read, so a directory swapped for a link while it is read never
  yields bytes from outside. A search is bounded as a whole (its limit, 4 MiB of output, 10 seconds)
  and answers what it found with `truncated`, each line cut at 2,000 characters: a large file never
  fails it. Anyone who can see the worktree may read it; to anyone else it is not there. The t3code
  gateway shows files and searches them with it (ADR 0012).
- e6eb644: `GET /api/worktrees/:id/diff?from=&to=` renders a slice of a worktree's checkpoint chain:
  from one checkpoint (or, with no `from`, the worktree's base) to a later one, with each file's
  status and line counts, and `whitespace=ignore` as the review diff takes it. Both ends are
  immutable commits, so a slice never moves. It reads through the same worktree reads as the change
  and review diffs, and anyone who can see the worktree may read it; to anyone else it is not there.
  A checkpoint not in the worktree's chain answers 404 naming it, and a slice that runs backward is
  refused. The t3code gateway reads one turn's work with it (ADR 0012).

  The answer is bounded: `files` lists the slice's files (the first ones, with `truncated`, when
  listing them passes 8 MiB or 10 seconds), and `diff` carries the patches of at most 200 of them
  within 8 MiB, each whole, within a 20-second deadline. `truncated` says when some have no patch
  and `omitted` names them; `path=` asks for one file's patch alone. A large slice answers with what
  fits, never an error.

### Patch Changes

- 4d5156d: On arm64 hosts (Apple silicon, ARM servers), Arch workspaces now build natively for
  `aarch64` instead of running `x86_64` under emulation (Sealant 0.39.0-next.721, sealant#360).
  Dependencies with native modules installed in an existing worktree (`node_modules`, `.venv`,
  `target/`) are `x86_64` builds: reinstall them (`pnpm install`, `uv sync`, …). The first Arch
  build on such a host downloads the Arch Linux ARM rootfs (829 MB) from `os.archlinuxarm.org`,
  outside the mirrors, and keeps it for every later Arch build there; a mirror slower than 1 MB/s is
  left for another (sealant#362). Every image plan now names its platform, so each workspace image
  is built once more at its next launch (on amd64 from the layer cache). The Mac guide and the
  workspace images guide say Apple silicon runs every workspace family natively again.
- 22fa719: The packaged server's Sealant worker starts up to four workspaces at once, and stops up
  to four, instead of one at a time. A launch held the only slot until its executor was ready, the
  restore of a large save included, so on a box shared by several people and agents a session could
  wait half a minute behind another before its own start began. `WORKSPACE_BUILD_QUEUE_PREFETCH` in
  the server's environment still sets the number.
- 42e1426: Reading an agent's memory and transcript back from a save fetches each pack once. A Codex
  memory read-back of 33 small files fetched the same 64 MB pack 33 times, 28 s of a Stop on the
  box.
- eef4f1d: A run's changes that Core never read are no longer shown to Mend's inference as an empty
  change. Core now says when it did not read a run's changes (the reading failed, none was recorded,
  or the run has not ended) and why; Mend's client kept only the files and the diff, so
  `read_change` showed an empty diff for something never observed. It now answers
  `changes not read · <reason>`. A control plane from before sealant#313 sends no such field, and
  its readings are read as made, as the SDK reads them.
- 539d69f: Claude Code no longer updates itself inside a workspace. 10–30 s after the first Claude
  started, it updated itself (2.1.287 to 2.1.289) and left its native binary as a 500-byte stub, so
  every later `claude` in that workspace (a join, a second session) failed with "claude native
  binary not installed". Every workspace now starts with `DISABLE_AUTOUPDATER=1` (and opencode's and
  pi's own update switches), which reaches a `claude` typed in a shell too, and Claude's launch seed
  sets it again for workspaces started before this release. A project variable of the same name
  still wins.

  A launch that exits non-zero now settles `failed` whichever of Mend's two observers sees its end
  first. Core settles an interactive session's run `completed` whatever its process exited with, so
  a join that could not start read `completed` when the run's supervision saw it before the terminal
  watcher did.

- a9a107a: Claude sessions now start with the plugins their settings enable already installed,
  pstack among them. Claude Code 2.1.292 did not install them itself in a workspace: a conversation
  session added the marketplace and then missed the plugin, and a terminal session loaded it only in
  an executor's first Claude, without its SessionStart hooks. Before Claude starts, its launch seed
  now reads `enabledPlugins` from your own `~/.claude/settings.json` and the repository's
  `.claude/settings.json` and `.claude/settings.local.json`, adds a marketplace it does not know
  from their `extraKnownMarketplaces`, and runs `claude plugin install --scope user` for each plugin
  not yet installed, as the person whose Claude it is. It asks no one: whoever can commit to an
  adopted repository can enable plugins (hooks, MCP servers, agents) that then run in every member's
  Claude sessions on it, as that member. Every install at one launch shares 30 seconds; one that
  fails or runs out of time is named and Claude starts without it. The terminal names the plugins as
  their install starts (`mend: installing Claude plugins · pstack@pstack-claude …`) and what was
  installed before Claude starts (`mend: Claude plugins · installed: pstack@pstack-claude`); when
  every plugin is installed already, only the last line shows. A plugin that wants to run its
  marketplace's command at install is not installed. A new workspace installs them again:
  `~/.claude/plugins` is not saved between workspaces yet.
- 1b52238: Three CLI fixes from the live pass. Pull, keep working, pull again now fast-forwards.
  Before, every bundle committed the checkpoint anew on the agent's head, so any second `mend pull`
  was refused as non-fast-forward, even with nothing new. The clone now records the commit each pull
  left (`refs/mend/pulled/<branch>`). The next pull sends it (`GET /changes/:id/bundle?onto=<sha>`),
  and a server that sent you that commit for this change, and still holds it, builds the new
  checkpoint on it and leaves it out of the bundle. With nothing new, the branch stays and the CLI
  says `unchanged since the last pull · nothing moved`. A branch that cannot fast-forward (you
  committed on it, or the server no longer holds the last pull) is left as it is. The CLI says why,
  and `mend pull <session> --branch <name>` fetches into a new branch instead. Mend never
  force-updates a branch. An older server ignores `onto` and bundles as before. `mend server`
  refusals (an unknown flag, no server configured, a held lock) print just the refusal, without
  `Server storage operation failed:`, a doubled period and filesystem advice that does not apply.
  The advice now follows only the operating system's own failures, and anything else under the lock
  reads as `Server command failed unexpectedly`.
- bf33c63: Sessions can no longer reach the cloud metadata address (169.254.169.254, fd00:ec2::254),
  so a session on a cloud VM cannot read the instance's credentials: a connection from a workspace
  or from its Docker service's containers is refused at once, and the workspace gets no raw sockets
  to send packets past that. The bundled Sealant adds the refusal with a pinned busybox image that
  the Mend image names (`dev.sealant.mend.network-guard-image`) and hands its worker
  (`SEALANT_DOCKER_NETWORK_GUARD_IMAGE`); `mend server setup` and `mend server upgrade` pull it with
  the server's images, and an `--offline` setup refuses until it is loaded. Workspaces already
  running at the upgrade keep the address until they stop.
- 6cf4d21: Codex sessions Mend starts run with Codex's background server off
  (`-c features.daemon_auto_start=false`). Codex 0.160 starts a shared server by default, and that
  server first copies Codex's own release, about 427 MB, into the saved harness home, where every
  later session in the worktree would receive it. Mend's launches already stayed off the server as a
  side effect of another setting; the flag makes it explicit on every launch: conversation,
  terminal, prompt, resume, handoff, join and claimed standby.
- fef5a30: A resumed Codex conversation whose thread Codex cannot find
  (`no rollout found for thread id …`) fails the turn with "Codex could not find this conversation's
  thread. Nothing was sent." Before, Mend quietly started a new, empty thread under the same
  session, so the next turn went to a conversation with no history. A resume that fails for another
  reason, such as an unknown model, shows Codex's own message.
- fdf9e20: The dashboard says what each session is doing:
  - A starting session names its launch phase, such as `booting`, `preparing the workspace` or
    `waiting for the previous save`, instead of a bare age.
  - A live session reads `up 4m` from its agent's own start, and a settled one `ended 5m ago`.
  - A worktree reads `starting` or `stopping` where it read `running` or `settled`.
  - A save with nothing queued reads `saving · no uploads pending`, not `saving · 0 B left`.
  - A stopping session with no save to report reads `workspace end not confirmed`. It is never
    hidden, and ⇧K no longer offers to stop Services it does not have.
  - Footer messages use `·` between facts, not em dashes.

- 67fdfbf: `mend doctor` and `mend server setup` no longer tell you to raise Docker's
  `shutdown-timeout` to 3600. dockerd's own shutdown already waits for each container's stop
  timeout, so the setting changed nothing. The `docker` line now reports what a Docker stop waits
  for: the longest stop timeout among the running containers, against the `TimeoutStopSec` of the
  systemd unit that runs the daemon, or `live-restore on`. A workspace that would outlast the unit
  is named, with the session to stop before you restart or upgrade Docker. Setup warns before it
  starts the containers. Until sealant#361 bounded it at 60 s, a capture workspace asked for 3600 s.
  `systemctl stop docker` then timed out, and the next `systemctl start docker` hung in "Restoring
  containers" for up to an hour. The self-hosting, VPS and troubleshooting pages say what to do
  before a Docker upgrade, and how to unstick a Docker that is already waiting.
- b83fe27: A session whose workspace image build fails now ends `failed`, with the build's reason,
  and frees its worktree. Before, Mend read the failed workspace as an executor kept for recovery
  and asked Sealant to stop it, which Sealant refused as "still launching" every time, so the
  session read `stopping · saving` until the machine was wiped. A launch that never ran an executor
  (no runtime, no drain) has nothing on any disk to save. A workspace whose executor ran is still
  kept.

  A session stopped while its image builds reads `stopped` from then on, not `starting` while the
  build runs on, and the build failing afterwards no longer rewrites it as `failed`.

- 190ebe9: A new session's executor is no longer replaced about two minutes after launch. Mend plans
  the replacement ahead of the platform's 8 h cap and moves it earlier when what is pending would
  take longer to upload, at the rate it observed between two flushes. A fresh executor ships a few
  KB of small captures a second while its ~800 MB `node_modules` bulk is still being built. That
  read as ~13 KB/s, an upload of 16 h, and the replacement fell due at once. It ended open shells,
  made a join wait 25–60 s for the replacement, and left a Stop nothing of its own to save. The plan
  now counts the upload at no less than 1 MB/s (one registration a second for captures), since the
  observed rate shows what was shipped, not what the store can take. What is pending moves the
  replacement no earlier than halfway through the executor's life. A replacement still starts in
  time when a large upload would not finish before the cap.
- 12b0eab: Fixes from the fresh-install test on stock Ubuntu 24.04:
  - `mend run -- bash` (or `sh`, `zsh`, `fish` and the other shells, given no script and no `-c`) is
    refused before anything is created. An attached `mend run` shows output and sends no keys, so
    the shell would sit waiting for input. The refusal points to **Open a shell** on the web,
    `mend shell`, or `mend run --detach` followed by `mend attach`. The line a Ctrl+C prints now
    also names `mend stop <id>` as the way to end the command.
  - On Node 22 the CLI installs and runs without warnings. The terminal dashboard's renderer is
    pinned to the version Mend is tested with, which declares no Node engine, so npm no longer
    prints `EBADENGINE`. The `node:sqlite` ExperimentalWarning is no longer printed. The CLI,
    `install.sh` and the docs all require Node.js 22.13 or newer, the first 22 release with
    `node:sqlite` unflagged. An older Node is refused in one line. The dashboard still needs
    Node 26.
  - A settled session with no run no longer reads "recording: off — launched before the platform's
    supervised path". A failed launch says it failed before a run started, and any other such
    session says no run started.

- 92be3f3: A fresh install on stock Ubuntu 24.04 now deals with the user namespace block before it's
  too late. `mend server setup` reads the Docker host's kernel before it pulls the Mend image. When
  the kernel refuses unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`,
  the default since Ubuntu 23.10), setup says that no session can start and asks "Allow them now?
  [Y/n]". On a yes it writes `/etc/sysctl.d/60-mend-rootless-docker.conf` on the Docker host and
  applies it through a short privileged container on the Docker socket it already uses, then reads
  the kernel again. On a no, without a terminal, or on a rootless daemon, it prints the command to
  run on the host, and repeats it as its last line. `--allow-userns` and `--no-allow-userns` answer
  for a script.

  On such a host, a launch now fails at once with doctor's words and the command, before any image
  is built or any workspace is created. Before, it built for minutes and then failed with a raw
  `docker exec … is not running`. The web shows the finding on the Now page and in the sidebar's
  machine block, and a failed session's line sets the command apart.

  When setup changes Mend's URL, it says so with the command every other CLI runs
  (`mend login --url <new>`). When this machine's CLI points at the old URL and that URL no longer
  answers, setup offers to point it at the new one; the sign-in carries over, since a device's token
  is not bound to a URL. `mend doctor` recognises a CLI left on the old URL while the server on this
  machine answers at its new one, and says so instead of "start the Mend server". A setup re-run
  says to create the first account only while the instance has none. In the guided public HTTPS
  setup, a domain that does not resolve from this machine makes Enter at "Apply?" change nothing,
  and setup says why.

- 1fd102a: A change of sender under shared control no longer settles the session. The hand-over
  stops one person's agent before the next person's starts, and in that gap the session read as
  settled: Mend queued the owner's automatic tour and suggestions on the owner's login, a Slack
  thread could get its end-of-session summary mid-conversation, and phones were notified of a settle
  that did not happen. The session now stays running through the hand-over and settles once, when
  the conversation ends.
- e32509e: Picking a session up on the phone, or taking it back in a terminal, starts the other mode
  in the workspace the session already runs in. It used to save and stop that workspace, then boot a
  new one and restore the save: 2 minutes 14 seconds for a pickup on a self-hosted box.
- f308f78: No session saves a login or token another person's session could pick up. An audit of
  Claude Code, Codex, opencode and pi, after a clean exit and killed in the middle of a turn, found
  credentials the saved harness state still held: Codex's MCP server logins
  (`~/.codex/.credentials.json`) and its shell snapshots (`~/.codex/shell_snapshots/`, every
  exported variable with its value), pi's own MCP logins (`~/.pi/agent/mcp-auth.json`) and its
  `mcp.json`, Claude Code's copies of `~/.claude.json` (`~/.claude/backups/`) and of every file it
  edits (`~/.claude/file-history/`), and clones and logs that keep a URL's token. Mend's list of
  them is one table, which the platform's must match and the docs page "How Mend handles your
  provider logins" lists in full. The Sealant runtime this release bundles leaves them out of what a
  remote workspace saves as well.

  Codex's machine state is never saved either, listed apart since none of it is a login:
  `~/.codex/packages/` (the runtime a `codex` typed by hand unpacks, about 427 MB) and the
  `app-server-daemon/` and `app-server-control/` directories its background server leaves.

  Codex sessions Mend starts run with its shell snapshot off (`-c features.shell_snapshot=false`),
  so the snapshot is never written. A pi session Mend starts runs on its owner's freshly delivered
  pi profile, on none, or does not start, whether it launches fresh or joins, resumes or follows up
  in a workspace where no pi is running: Mend moves aside the profile and settings an earlier
  session delivered into the worktree, never deleting them, then delivers the owner's. In a
  workspace that shares one home (`MEND_HARNESS_LAYOUT=shared`), a pi session beside a running pi,
  anyone's, runs on the profile already there (known issues); in a per-person workspace, the
  default, each pi runs on its own person's profile. A pi typed by hand in a session that is not a
  pi session is not set up (known issues).

- e4380af: The Helm chart runs the package and image mirrors as optional components:
  `mirrors.npm.enabled` (nginx-unprivileged caching registry.npmjs.org, capped at
  `mirrors.npm.maxSize`) and `mirrors.docker.enabled` (registry:3.1 caching Docker Hub under the
  packaged install's guard, capped at `mirrors.docker.maxSize`, `mirrors.docker.ttl`). Both leave
  `mirrors.minFree` free on their claims. An optional Docker Hub login comes from
  `mirrors.docker.upstreamCredentials.existingSecret`, and only with `publicReadOnly: true`, the
  operator's statement that the token is scoped Public Repo Read-only: every workspace can pull what
  it can read. Each mirror is one non-root replica on its own claim behind a ClusterIP Service,
  admitted only from Sealant workspace Pods. The API tier gets `MEND_NPM_MIRROR_URL`; NOTES.txt
  names the Sealant chart's `workspaces.docker.registryMirrors` value that points workspace Docker
  daemons at the mirror.
- 867466a: On a Docker host that refuses unprivileged user namespaces (Ubuntu 23.10 and later, by
  default), no session can start. `mend server setup` now says so as its last line and `mend doctor`
  reports it on a `workspaces` line, each with the command that allows them.
- ba09aa9: A dependency install that Mend runs with pnpm no longer waits about 70 s on one stalled
  registry download. It gives up on a silent connection after 15 s instead of 60 s, and waits 2 s
  before the first retry instead of 10 s, so a stall now costs about 17 s. A tarball that keeps
  arriving, however slowly, still downloads in full. pnpm's update check is off for that install. If
  the shortened install fails after reporting retries, for example behind a proxy that always takes
  longer than 15 s to answer, Mend runs the command once more with pnpm's defaults and logs
  `dependency install · retried with defaults`. Settings already in place take precedence: in the
  command itself, the project's `.npmrc` or `pnpm-workspace.yaml`, your user config (`~/.npmrc` or
  `NPM_CONFIG_USERCONFIG`) or pnpm config, the image's global `npmrc`, or the environment. Other
  package managers, and custom commands that are more than a plain `pnpm install`, keep their own
  timeouts. The engine's install line now ends with the number of download retries pnpm reported:
  `dependency install · completed · exit 0 · fetch retries 2`.
- 6d30e0c: A second person can now join a live session's worktree. On a server with more than one
  person, the join used to wait about 30 minutes on a session line that read "the previous session
  in this worktree is not answering", then failed with "worktree leased". Mend asked Sealant about
  the first person's workspace as the second person, and Sealant only answers the person who created
  a workspace. Now Mend asks about a workspace as the person who created it:
  - Looking a workspace up, reading its records, saving it and ending its processes always work this
    way, whoever asks. So a check whether an executor still runs never mistakes "you may not see it"
    for "it is gone".
  - Running anything in it (a terminal, a shell, a Service, a command, a repository clone) works
    this way for a joiner while they can see the project and both people remain organization
    members. Otherwise Mend refuses it and says why.
  - Starting a workspace and using inference still run on your own account. A harness run through
    Sealant is only started by the workspace's creator.

  Removing a member now ends every agent, shell and Service of theirs, including in executors other
  people started. Any executor they started is retired: the sessions of others working in it are
  stopped with words telling them to start again in a workspace of their own, and it saves through
  the normal Stop. If the platform does not close a process, Mend keeps it recorded as running,
  tries again, and the session line says "could not be stopped · stop again". If the platform
  answers that it cannot find a running session's workspace, the waiting line now says so instead of
  "not answering", and the log records Sealant's answer.

  Known limit: in a workspace that shares one home (`MEND_HARNESS_LAYOUT=shared`, or an image that
  cannot run per-person homes, ADR 0016), every process in an executor runs as root in the home of
  the person who started it. A person who joins someone else's executor therefore:
  - runs their agent on that person's Claude or Codex login, and a conversation records its turns as
    billed to them;
  - gets root shells and Services in that person's home, which can read their Claude and Codex
    credential files and the executor's `GITHUB_TOKEN` and `GH_TOKEN`;
  - signs `git push` and `git fetch` from the workspace as that person: their Mend key, or their
    machine in bridge mode. The push is recorded on their session. A repository the joiner adds is
    cloned the same way.

  Landing a change is not affected. See Known issues in the docs.

  Mend also checks access again at startup and every minute. A removed member's sessions are
  stopped, and so is a session in someone else's workspace whose owner can no longer see the
  project. Each one's line says why, and the organization's audit log records it. A session in your
  own workspace keeps running when a project becomes private, as the setting says. Typing into an
  existing terminal and restoring a running agent after a restart follow the same rules. A member
  who lost project visibility can still watch their own terminal, but cannot type in it, and can
  always Stop their own session, which saves their work. A Stop of one person's session in a shared
  executor no longer ends anyone else's agent or the executor itself while someone else still works
  there.

  A Stop wins over a replacement or relaunch that is saving the executor from the moment it is
  asked, even while the platform is slow to close the agent: nothing starts on a new machine after
  it. A refused Stop leaves a replacement or relaunch that is still saving as it was; if it finishes
  meanwhile and ends the agent, the Stop counts as done and nothing starts after it. Its warning
  names the process, survives a Mend restart, and clears once that process is observed ended. One
  failed Stop does not interrupt the other sessions being stopped, and counts and audit entries
  report only sessions whose processes ended.

- 328ff0c: A session resumed on a server while another session in its worktree holds the executor
  continues its own conversation. The resume joined that executor and started Claude, Codex,
  opencode or pi with no resume arguments, so the harness opened a new conversation while the
  session's process named the old one. The join now passes the same resume arguments as a resume in
  a fresh executor.
- cadd89c: A session starts without waiting on one exec per file. The skills, agent memory, pi
  profile and pasted images Mend writes into a capture-mode workspace now go in one exec per
  delivery, and a skill that sits in each harness's directory travels once. On the Docker box a new
  session wrote a 1.9 MB skills library in 103 execs and its memory in 11, about 60 s of a 90 s
  start; both now take one exec each.
- 17a9126: A foreground `mend claude` or `mend codex` now stops its session when its terminal closes
  (a closed window, `tmux kill-session`). The CLI's write to the dead terminal failed with EIO and
  the CLI exited before its stop went out, so the session kept running; the stop now goes out first,
  as on SIGHUP, and the CLI exits quietly.

  On the web, clicking a line number in a review puts the cursor in the comment box it opens, and a
  right-click menu takes focus once it shows, so Escape closes it and the arrow keys move through
  it. The worktree menu's `Copy worktree path` is now `Copy directory name`, which is what it
  copies: a captured worktree has no directory on the server.

  `Send review to session` is no longer offered for a `mend run` session, on the web and on the
  phone: a command has no agent for the review to start. The review says so instead, and the server
  refuses such a delivery in those words before recording anything.

- c9864ad: The phone names a pi session's harness "pi". Every harness other than Claude Code and
  Codex used to read "OpenCode" in the session lists, so pi and shell sessions were shown as
  OpenCode ones.
- 8ae89d7: The phone shows the change's pull request. The session's conversation has a card where
  Mend first recorded it: the number and title, its state as a dot and a word, its branch, whether
  it was opened outside Mend, when it was observed, and `changed since landing · 3 files` when the
  worktree moved on, with `Open on GitHub` and, for the change's owner, `Refresh`. A terminal
  session shows the newest one at the end of its transcript, the review shows it as a line above the
  change, and every session row on Now, Projects and a project's screen ends with `#412 · open`,
  which opens it on GitHub.
- b70e131: The phone's "Stop session" asks before it stops anything, and lives in the session
  header's "more" menu instead of beside the Shell button: one bump on it ended a session while its
  owner was using the shell.
- eea1a74: The phone's Stop button (the one beside the composer while the agent works) no longer
  reports a "JSON Parse error". The server stopped the turn and answered with no body, and the phone
  tried to read one.
- 2c41a76: A repository URL with a login or token in it
  (`https://oauth2:TOKEN@gitlab.com/org/repo.git`) is refused at adoption and for reference
  repositories, as it already was for dotfiles, on every client and the API, with a message that
  points to `mend keys` and the agent bridge. Before, the adopted URL was stored as typed and every
  project read returned it to everyone who could see the project: on a shared project, the whole
  organization. Migration 0126 removes the credential from stored URLs. A project whose Git store
  still holds one (or includes another config file) is refused for fetch, push, landing, new
  worktrees and session launches until an operator removes it, and the server log names the command
  for each such project, at every refusal and at start; the store is never rewritten. Repository
  URLs in responses, Git errors, log lines and `--json` output no longer carry a credential. A
  co-located launch whose selected references or linked projects cannot be read is refused too,
  rather than mounted unchecked. A private repository that fetched only because its URL held a token
  now fails to clone or fetch from inside a session: switch its origin to SSH
  (`git@github.com:owner/repo.git`), which goes through Mend's git transport.
- 5a27a65: opencode has models to pick. The server's catalog lists the Codex models for opencode as
  it names them (`openai/gpt-6.1-sol` and the rest, through your ChatGPT login), so the web
  composer, VS Code and `mend models` offer them, and a session records the one it was started on.
  None is the default: a launch that names no model sends none, so the model in your project's or
  your own opencode config still decides, then the one opencode last used. An operator's own
  opencode rows are kept, and a row an operator flags as the default is the default. In VS Code,
  opencode's model pick leads with "opencode's own choice", so a plain Enter sends no model.
- 41d2e38: A pasted image is now written by the process of the person who pasted it in a per-person
  workspace, as them, into their own saved directory
  (`/workspace/harness-home/people/<account id>/paste/`; a new directory is 0700 and the image
  0600). Before, Mend wrote it as root into the shared harness home. Root writes nothing of the
  person's: a first paste makes only that person's user and home, writes none of their logins and
  delivers nothing to them (no dotfiles or install.sh, skills, secret files or shell profile). Each
  paste fetches its image with a Mend token of its own, which redeems that paste's pickups and
  nothing else, is never revoked along with the person's other tokens, is revoked when the paste
  ends however it ends, and lapses 15 minutes after it is issued in any case.

  In every layout the paste writer follows no link, creates the image only where nothing is, and
  never changes the mode of a directory: a new directory is made with its mode in one step. Before,
  a `paste` link planted in the harness home led the root write outside it, and the writer widened
  the directory it found there to 0755. The co-located store's writer on the server follows the same
  rules, and refuses a paste on a server where no `/proc/self/fd` reaches a directory (a server run
  outside Linux, not the packaged one).

  Slack images take the same path, as the person who asked: in a captured session's running
  workspace, as that person where it runs per person. On the capture store, a Slack request that
  starts a session attaches no image, because its workspace does not exist yet when the opening turn
  is written. The turn and the requester's note say
  `not attached · the session has no running workspace to place it in yet`. Before, Mend wrote such
  an image on the server, where the workspace never saw it.

- 712f7d6: While a workspace gets ready, the session line now says where it stands, as Sealant
  reports it: "queued · waiting for a worker", "building the workspace image · step 3/12", then
  "booting". A first launch after an update can take many minutes to build its image without the
  launch giving up, and when a build stops making progress or runs past its limit the session says
  so, with the step it was on.
- 6f403f5: pi and opencode run on your ChatGPT subscription through the Codex login you connected.
  At each launch Mend writes that login into the tool's own `auth.json` (pi's `openai-codex`,
  opencode's `openai`), as a copy that cannot refresh; a login made inside the session is never
  replaced, and pi defaults to it only when you chose no provider. With that login and no recent
  model of its own, opencode starts on `openai/gpt-6.1-sol`; `--model`, your opencode config and a
  model picked inside opencode still come first.
- d8dff71: With `MEND_HARNESS_LAYOUT=person`, the default, a worktree whose workspace started before
  0.36 is moved over without losing anything. Mend credits the memory saved in the old shared home
  on the server: to the person the home's record names, else to the only person who had sessions
  there, else to nobody, and the worktree lists what it credited to nobody. When the worktree turns
  per person, it reads the old home's last capture once more and credits only what is new. A live
  workspace that shares one home is replaced on its own once nothing would stop that anyone would
  miss (no terminal session, shell, Service started by hand, agent turn, process Mend did not start
  or running container, and nothing it could not check) and only after its final save; until then it
  takes joins, turns and follow-ups from its launcher only and says why. The change's owner can
  replace it sooner with "Replace this workspace now", which lists everything that would stop and
  ends nothing that was not listed. An opencode conversation from that shared home cannot be resumed
  per person, and the session says so. With `MEND_HARNESS_LAYOUT=shared`, nothing changes. A session
  from before the worktree ran per person resumes from its conversation as last saved; it is copied
  into its owner's directory only if they lack it, and nothing is moved or deleted.
- 430b2fd: `mend projects --json` prints JSON (it printed the table). A session id given first on a
  `mend service run` line is no longer ignored when `--name` is absent.
- 652abc2: Fixes from the 0.36.0-next.754 feature-map drive:
  - The web's "Discard unsaved and stop…" works. It always answered an internal error before, and it
    is the only way out of a stalled save.
  - A `mend run` session has no agent to resume. Resume on its own harness is gone from the web, the
    phone and the dashboard's picker; a shell or another harness is still offered. The server
    refuses in words:
    `This run session has no agent to resume. Resume it as a shell, or start another session in its worktree.`
  - The dashboard's review screen no longer opens the send editor on a `mend run` session. It says
    there is no agent to send the review to, as the web and the phone do.
  - `mend server status | head` no longer leaves a stale `server.lock`. A server command whose
    reader went away, or whose terminal closed, finishes what it started, releases the lock and
    exits 0. Every exit through `process.exit` releases a lock still held.
  - `mend uninstall` refuses with the lock's words while a server lock is held: which process holds
    it, and how to clear a stale one. It no longer crashes with a stack trace.
  - `mend uninstall --all` removes the edge's Caddy image too, after `--no-edge` took the edge away.
  - A managed OS family's packages save only when they are in Sealant's catalog. A name the platform
    matched to another project (`tree` → `python-urwidtrees`) is refused at save, not at every
    launch.
  - `mend memory rm codex:memories_1.sqlite` removes Codex's database, as the listing names it.
  - A removed member's open page lands on sign-in with the reason, even when the server closes its
    event stream before the reason goes out.
  - A failed hand-over's summary no longer ends a sentence with `..`.

- 7c7e755: Fixes from the 0.36.0-next.761 client pass:
  - `mend run -- bash -c '…'` runs bash. Any `bash` with arguments used to be swapped for the
    workspace's login shell (zsh by default), so bash builtins such as `mapfile` and `shopt` were
    "not found", sometimes with exit 0. The program you name now runs as itself, with exactly your
    argv. Only a bare shell session still opens the login shell.
  - Back-to-back `mend run` in one worktree no longer fails with "the executor is ending: a final
    capture flush closed admission" when the previous run's save is slow (a large untracked tree). A
    launch that joins the worktree's executor now counts as in use, so the previous run's save waits
    for it. If that save has already begun, the launch waits
    (`waiting · the previous session in this worktree is saving`) and then starts on a fresh
    executor.
  - "Discard unsaved and stop…" is offered once a save has stalled
    (`not saved · … · workspace kept`, or a step past its bound), not while it is still saving. If a
    discard waits on a save that then saves everything and ends the workspace, the session reads
    what that save recorded, not `unsaved work discarded`, and no discard is audited.
  - The session page no longer shows its owner the non-owner view ("runs as another account", "its
    owner shares control · Turn off", `PROJECTS/PROJECT`) for a few seconds. Ownership lines wait
    for the data they depend on. `sessions.recipes`, which reads the workspace and can take seconds,
    is no longer batched with the rest of the page's reads.

- 44dcc04: Fixes from the 0.36.0-next.761 fresh install on Ubuntu 24.04:
  - `mend uninstall --server` and `--all` finish in one run with live sessions. Both used to stop on
    `network sealant-…-network has active endpoints (mend-docker-mirror)`, because they removed the
    workspaces' networks while the Docker mirror was still attached to them. Workspace containers go
    first, then the server's own containers (the mirrors among them), then the networks.
  - An `--all` that stops before its images, sysctl file or build cache now says each one was "not
    reached". It used to say "kept · Docker's build cache" after a y, and say nothing about the
    rest. A yes to the build cache is carried out once the server is gone.
  - `mend uninstall --all` offers the metadata guard's busybox image even on a re-run, after the
    Mend image (whose label names it) is gone. It used to leave the image there without a word.
  - A launch refused because the host blocks user namespaces now prints a command that works when
    pasted: `… | sudo tee /etc/sysctl.d/60-mend-rootless-docker.conf && sudo sysctl --system`. The
    server's error scrubber had turned the path into `<path>`. The command crosses whole only when
    it is exactly the one Mend writes.
  - `mend server setup --yes` without `--allow-userns` says to re-run with `--allow-userns`, so that
    setup writes the sysctl file and `mend uninstall` can undo it. The command to run by hand comes
    second: a file written by hand has no marker, so uninstall leaves it.
  - The guided `mend server setup` asks about the host's user namespaces before its first question.
    The kernel probe uses the busybox image every install already needs (a few megabytes), not
    `postgres:17-alpine`, so nothing of the release is pulled before the question.
  - After a URL change, setup says that other accounts and other machines sign in again with
    `mend login --url <new>`, which asks for a new browser authorization. It used to say their
    sign-ins "move with" it.
  - A re-run of `mend uninstall` names only the containers, volumes and image Docker still holds, in
    its plan and in what it says it removed.

- 2687915: Fixes from the RC 0.36.0-next.768 re-checks.
  - A session whose workspace the host's Docker stopped or killed (a `systemctl restart docker`, a
    stop past its timeout) no longer reads `completed`. Core restarts such an executor on its own
    disk to save what it held. When that boot is what answers Mend, the session's line says
    `ended · the host's Docker stopped it`, with the last capture `not confirmed`, and then
    `saved at … · capture N` once the save is observed.
  - `mend doctor`, a launch refused on a host that blocks user namespaces, and the web's notice now
    name `mend server setup --allow-userns` first. Setup writes the sysctl file with its marker, so
    `mend uninstall --all` removes it and puts the kernel back. The manual command is still given as
    the alternative, and a file written by hand stays on uninstall.
  - When "Discard unsaved and stop" was asked but the save under way finished first and kept
    everything, the session now says
    `stopped · the save finished before the discard, so nothing was discarded`, not plain `Stopped`.
  - `mend doctor` on a MacBook that serves Mend now says, on a `lid` line, that closing the lid
    sleeps the Mac unless an external display and power are attached, which pauses the Docker VM. It
    reads `ioreg`'s `AppleClamshellCausesSleep`, so the line is there even when `pmset -g` reads
    `sleep 0`. A Mac mini has no lid and keeps only the `sleep` line.

- 9949ff7: A relaunch, resume or executor replacement waits for the session's own earlier executor
  to give up the worktree before it creates the next one. Mend read a lease that an earlier executor
  of the same session held as free: the next executor booted and waited for that lease until the
  platform gave up on it. Ending one executor also no longer releases a lease that a later executor
  of the same session holds.
- c268fd2: VS Code Remote-SSH, SFTP and `scp` into a per-person workspace run as its launcher's own
  Linux user, in their 0700 home with their logins, not as root. The launcher is the person whose
  launch started the workspace; after it stops, whoever launches the next one. Only the launcher can
  open Remote-SSH there. The API's session list and view name them (`workspaceLauncherUserId`), so
  an editor can say so before it opens instead of ending in a bare permission denial. Mend binds
  each account's person in Sealant once (`users.bindPerson`). If it cannot (an older Sealant, a
  refusal), Remote-SSH stays root and the session says
  `Remote-SSH: root, Core can't bind your person`; a Sealant that runs SSH only as root gives
  `Remote-SSH: root, this Sealant runs it as root`. When a workspace falls back to one shared home,
  Mend sets its SSH user back to root off the launch path, and until that lands the session says
  `Remote-SSH unavailable · the workspace's SSH user is not yet back to root · retrying`. A person
  launch whose Remote-SSH runs as root for any reason, a claimed standby included, says so on its
  session line.
- 651ceb8: A worktree whose change was never landed can now be removed from the web app and the CLI,
  in two steps. The web app's worktree menu shows the store's refusal in its own words, with the
  files and line counts not on origin, and offers "Remove anyway", which is the same removal with
  `force=true`. Clear settled says how many worktrees it kept for that reason.
  `mend worktrees rm <name>` removes a worktree from a terminal, prints a refusal as the server said
  it, and `--force` removes it anyway. A worktree whose workspace is still saving is refused either
  way.
- 618285c: A conversation session started with approvals on (`ask`) keeps them when it comes back.
  Resuming it, a follow-up to it after a stop or an idle stop, and a Slack reply that relaunches it
  now run with `ask` again, where they ran with approvals off. A relaunch that names a permission
  mode still runs on the one it names.
- 7fb0587: `mend resume <id>` resumes the session it is given. Without `--with` on the line it
  skipped the id and resumed the project's newest settled session instead, which may be another
  worktree's.
- 204613d: - The t3code gateway asks Mend whether a device is still paired when a socket opens with
  a bearer in its `Authorization` header, as it already did for a ticket. A device revoked in Mend
  is refused at once instead of reading for up to 15 seconds.
  - `mend pull` works for a branch whose name has characters above U+00FF (CJK, for example), which
    made the bundle download fail with a 500. The download names the file in UTF-8 (`filename*`)
    with an ASCII fallback, and sends the branch percent-encoded in `x-mend-bundle-branch-encoded`,
    which the CLI reads first.
  - The docs no longer call a workspace that shares one home the default: per-person workspaces are.
- b3f89db: Opening a review or marking a checkpoint while a session is stopping no longer hangs. The
  checkpoint uses the Stop's final save, which holds everything the session saved, and Mend does not
  ask the stopping executor again. The web, phone and terminal reviews say where that checkpoint
  came from, with the time of that save, for example
  `from the Stop's final save · capture 12 · 10:16`. They never show it as a fresh observation. A
  landing during a Stop waits for the Stop to finish, then lands what it saved. If the Stop takes
  longer than 45 seconds, the landing is refused with "the session is stopping", and nothing is
  landed. Opening a review answers within 90 seconds, or says it did not finish.
- efcba11: A Stop whose session committed a large file no longer verifies the git pack twice. The
  register copies it down and verifies it once; the seal compares the stored index with the one
  verified and reads the pack again only if that changed. A 627 MB pack cost 7.9 s less on the box.
- 0dc3fde: The bundle runs Sealant 0.39 (0.35.1 ran 0.38.1): its API, worker and SSH gateway images,
  pinned by digest. Its workspaces run sealantd 0.20.
  - Every workspace image carries pi beside Claude Code, Codex and opencode, at fixed versions
    (Claude Code 2.1.292, Codex 0.160.1, opencode 1.18.34 and pi 1.0.4), so rebuilding an image no
    longer changes which version a session runs.
  - Sessions start faster: Mend sees each command it runs in a workspace end within about 25 ms,
    where it could wait a few hundred, and a launch runs about twenty of them. A workspace's
    readiness is read back sooner too.
  - Sealant no longer stores the arguments a process or terminal was started with, since they can
    carry secrets: a run's record shows the program and how many arguments it had. Upgrading runs a
    one-time purge of the arguments already stored, before Sealant starts. On a database the size of
    a small team's server it takes 15 to 45 seconds.
  - A command's arguments may be any string: empty, starting with whitespace or spanning lines. Only
    the program must be trimmed. A request Sealant refuses says why without quoting what was sent. A
    registry URL's user and password are sent as Basic auth and never printed, and what Sealant's
    API observes is redacted unless it is known to be safe.
  - Workspaces send each upload's SHA-256, pack indexes included, so a Stop on Garage can seal
    without waiting for its upload links to expire. No harness login is captured with the harness
    home, so the next session in the worktree never inherits one. A final save and a restore use
    every core, and the `socat` relay comes over HTTPS, checked against a pinned checksum.
  - A Stop is recorded once the executor has ended, before its remains are removed, and a run's
    changes are read from a refreshed copy of the index. A run no longer fails when the same
    telemetry event reaches its record twice.
  - A workspace's SSH sessions, VS Code Remote-SSH included, can run as its owner's own Linux user,
    the person their Sealant user is bound to. SFTP runs as that user too. The Fedora and Ubuntu
    images carry an `sftp-server`, with every sshd unit masked.

- 1c9b7a3: The bundle runs Sealant 0.39.0-next.722 (sealant#361). A workspace container's own stop
  timeout is now 60 s, so restarting or upgrading Docker with a live session finishes inside
  systemd's 90 s instead of leaving Docker waiting in "Restoring containers" for up to an hour. A
  planned Stop still gives the workspace its full grace, read from the container's
  `sealant.stop-grace` label. A workspace that Docker's own stop kills keeps what it had not saved
  on its disk, and it is recovered. Workspaces started before the upgrade keep their 3600 s until
  they stop: `mend doctor` names them. The upgrade page and release notes say so.
- 7014ef6: Files Mend places in a captured workspace (secret files, the pi profile, agent memory,
  skills, carried Codex conversations, pasted images) no longer pass through the platform's exec
  arguments, which Sealant Core before 0.39 stored in plaintext.
  - **The pickup ticket.** A launch puts a single-use pickup ticket in the exec instead of the
    bytes. The ticket is bound to the session, its owner and the executor's launch. It dies when its
    exec ends, with a ten-minute backstop. The same exec redeems it over the session channel and
    writes the bytes straight into place. Secret files and the pi profile's `mcp.json` are written
    0600, and never through a link.
  - **Node.** Secret files need `node` on the image's `PATH`. Without it the session line says so.

  A credential in an adopted origin no longer reaches a workspace: not its `origin` remote, the
  `mend repo add` clone, or what `mend repo projects` lists.

  **If you ran a 0.36 prerelease.** Secret files, pi profiles, agent memory and `mend repo add` are
  new in 0.36, and prereleases before this fix sent them as exec arguments, which Sealant stored.
  The Sealant this release bundles purges stored arguments when it upgrades; a database backup taken
  before then still holds them. If you used such a prerelease, rotate every credential kept as a
  secret file, every key in a pi profile's `mcp.json`, any secret written into agent memory, and
  every token in an origin added to a session with `mend repo add`. Upgrading from 0.35.1 needs none
  of this.

- 983d74f: New: `mend service run --wait` returns once the Service's port answers, waiting while its
  process runs, up to `--timeout <duration>` (default `10m`). It opens no tunnel and refuses a
  recipe that declares only a port, and the exit status says what was observed: `0` the port
  answered, `1` Mend refused the start, `2` the Service's process ended first (with its status and
  exit code), `3` the server no longer has the session, `124` still starting at the timeout. The
  wait judges only the process its own start began: the start sends an id the server stamps on that
  attempt, so another client's start, restart or stop never decides it. A server older than the CLI
  stamps none; there a start an edge cut is not followed, and a command that exits inside the
  server's minute reads as the refusal the server answers with (exit `1`).

  `mend service list` prints each Service's current attempt's process id, and `--json` prints the
  Services as JSON. `mend logs --service <name-or-id>` reads a Service's current attempt, and
  `mend logs --process` takes a Service's id or name too: a full id names its Service before any
  name, and a name two Services carry is refused with both ids listed. A Service with no attempt yet
  is refused with a line that says why nothing is recorded.

  A reader that closes the pipe early (`mend service list | grep -q web`, `| head -1`) no longer
  kills the CLI with an unhandled EPIPE and a stack trace: every command exits 0, quietly.
  `mend run` and `mend logs` still fail when their command's output could not be delivered.

- 36f4575: A session and its run settle together. A session settled by any path, a failed launch, a
  lost executor, the sweep after a restart, now settles the run it left open with the same outcome
  and summary. Startup and the lease reaper settle a run left `running` under a session that had
  already settled, once, with the session's words. A resume of such a session no longer fails on the
  one-active-run index with an unhandled error: the stale run is settled first and the resume goes
  on, and a run that is still live is refused in words, `a run of this session is still open`, and
  never settled.
- 3df5968: `mend server setup` on a machine with two Docker engines, such as Docker Desktop and
  OrbStack on one Mac, no longer installs a server it cannot reach. Before anything is pulled, setup
  checks that Mend's web and SSH ports are free where they are to be published, and says what holds
  one that is not: "127.0.0.1:3105, Mend's web port, is taken: another Mend, 0.27.4, answers there".
  On a terminal it offers the next free port; with flags it refuses and names `--port` or
  `--ssh-port`. After starting, it waits for health from the server it started, by version and by
  the instance id the server now reports in `/api/health`, so another Mend answering on the same
  port is said as one rather than read as this server's health.

  `--context` and `--docker-socket` choose the Docker engine and answer no question:
  `mend server setup --context orbstack` on a terminal now asks the questions and the Apply prompt,
  and without a terminal a fresh install with only those flags is refused like one with none
  (`--yes` takes the defaults). A fresh install without `--context` takes `DOCKER_CONTEXT`, as
  docker does; an existing install stays on the context its data is on and says so.

  When this machine's CLI points at another server, or where nothing answers, setup offers to point
  it at the server it installed. A sign-in made at another server stays behind, and the offer leads
  with no while that server still answers.

  `mend doctor` reads the Docker daemon of the installed server's own context for its docker line,
  so an OrbStack server is no longer told to restart Docker Desktop. When the CLI's loopback URL
  answers with a server other than the one installed here, the server line says so and gives
  `mend login --url`. The exposure line names the command to run
  (`mend server setup --edge <domain>`, or `--url https://<origin>` behind HTTPS you run) instead of
  an internal setting.

  The private-network question no longer offers Docker, OrbStack or vmnet bridge addresses, or
  network addresses ending in .0. On the public HTTPS walk, workspace SSH defaults to this machine
  until you state that you checked it from outside, so the defaults no longer undo each other, and
  the question about stating what you checked says what it is for.

- 4343382: `mend server setup` no longer offers a public address as a private network. Under "my
  private network or Tailscale" it offers only the tailnet, LAN or VPN addresses (RFC 1918, ULA) and
  carrier-grade NAT space, and pre-selects one of them. A public address is said as observed and
  left out, and so is "every address" when the machine holds a public one. On a VPS whose only
  address is public, setup says so and installs on this machine, with the ways to reach it from
  elsewhere: a tunnel, Tailscale, or public HTTPS. Before, Enter there published a fresh install on
  the public address as `private`, with registration open to whoever reached it first. A fresh
  install now refuses `--bind` on a public address without the edge, with flags too. On an existing
  install, a run that publishes Mend's port or workspace SSH on a public address while the exposure
  is not public says so beside the declared exposure. A Tailscale Serve name with Funnel on is said
  to be public and offered as a browser origin with No as the answer, and not at all on a fresh
  install. Moving the web to another address on a rerun keeps workspace SSH where it was published
  by default, instead of moving it along.
- 5ff702a: `mend server setup --ssh-bind <ip>` publishes workspace SSH on its own address. With
  `--edge`, the web port stays on loopback and the edge carries HTTPS only, so until now the SSH
  gateway stayed on loopback too and Remote-SSH from another machine (VS Code on a laptop,
  `mend ssh`) could not connect. `--ssh-bind 0.0.0.0`, or a private address, publishes it; the
  setting is kept across reruns and upgrades, and naming the `--bind` address takes it away. A
  release whose compose asset cannot honour it is refused rather than left on loopback.

  SSH published that way is its own item of the public exposure gate, `workspace-ssh`. The server
  reads where it is published (`MEND_SSH_PUBLISHED`), reports loopback as observed, and anything
  else as open until the operator states who reaches it (`MEND_EXPOSURE_DECLARED`, which
  `mend server setup --declare <item>` now writes). A `public` start waits for that statement, and
  setup refuses `--exposure public` with SSH beyond loopback until `--declare workspace-ssh`. Setup
  also says what it observed from its own machine: each address it tried, and whether an SSH banner
  answered.

  A rerun with `--port` now moves a saved plain-http `--url` that names the old port explicitly (the
  LAN or tailnet case) to the new one, as it already did for `http://localhost`; before, `APP_URL`
  kept pointing at a port nothing published. An `https` URL, or one whose port is implicit, is an
  endpoint in front of Mend and stays as it was.

- 22b7247: A shallow repository (a `git clone --depth` copy, a CI checkout, a mirror made from one)
  is now refused at adoption, and a project adopted from one before is refused when a session starts
  on it: "Mend doesn't support shallow repositories yet. Make the repository complete where it is
  hosted (`git fetch --unshallow`), then adopt it again." A session on one could never save: every
  save's git section failed verification at the shallow boundary, and its Stop read `saving` for up
  to 10 minutes, then `final seal not confirmed`. A project whose repository has grafts
  (`info/grafts`), which cut its history the same way, is refused at a session's start too. A Stop
  whose final seal Mend refused because that capture's git section failed verification now reads
  `not saved · final seal refused · git section failed verification · workspace kept` on the first
  final flush, and keeps the workspace; a seal withheld because a check could not finish keeps the
  ordinary wait. A shallow checkout on your own machine still adopts through its `origin` URL, in
  full.
- 5129189: Sign-in for a Mend on a Mac mini, reached from other machines. A server clock that
  disagrees with yours no longer breaks it. After a Mac sleeps, OrbStack's VM clock can run hours
  behind, and `mend login`, the VS Code extension and the authorize page compared the server's
  `expiresAt` with their own clock, so the request read as expired the moment it opened. The server
  now also sends `expiresIn` (seconds left, by its own clock) and clients count down from when the
  answer arrived. Against an older server they read `expiresAt` against its Date header. The server
  still judges expiry by its own clock alone. `mend doctor` says when the server's clock is more
  than two minutes off this machine's (`this server's clock is 116 min behind this machine's`), with
  what resets it. On a Mac with a server installed, it also says when the Mac still sleeps on its
  own (`pmset -g`): OrbStack and Docker Desktop pause their VM while it sleeps. The Mac mini guide
  says to turn automatic sleep off and Wake for network access on.

  `mend login` over SSH, or on Linux with no display, prints the link and code and opens no browser.
  Before, it opened the page on the far machine's screen. `--open` and `--no-open` decide outright.

  In VS Code, polling no longer waits for the "open the external website?" dialog, which can sit
  behind other windows on Linux. The sign-in shows the link and code with "Copy link" and "Paste a
  device token instead". The plain-http warning is shorter, says nothing over Tailscale (by address
  or `.ts.net` name), and says "anyone on this local network can read the token" on a LAN. "Open in
  VS Code" is in the session row's right-click menu too.

  The authorize page names the client asking: "Authorize VS Code?" for the extension, "Authorize
  this terminal?" for `mend login` (migration 0128 keeps which client opened a request). A guided
  `mend server setup --context orbstack` now puts `--context orbstack` in its "Same as:" command.

- 176b506: Removing a workspace SSH key (`mend ssh keys remove`, Settings → Workspace SSH) says what
  happens to the connections already open with it. With the Sealant this release pins (0.39), they
  end within a minute. Against an older Sealant they stay open until you stop your running sessions,
  and the removal lists those sessions: the CLI prints `mend stop` for each, and Settings offers to
  stop them all after a confirmation. The published SSH port now has limits before login
  (sealant#359), and the docs describe them.
- b81e4ed: Startup never waits on an executor. The session engine's boot pass folds each unsettled
  row whose processes had all ended and that no drain holds, then stands; the workspace such a
  session left behind is drained after the boot, forked and as the session's owner, with the late
  harvest the restart cut short. Before, a session whose stop or resume was under way when Mend was
  replaced (its agent ended, its old executor still up) had its drain run inside startup, with no
  principal, so every lookup read `unknown` and the drain idled for up to its ten-minute stall
  window while nothing listened on the API port; the bundle restarted Mend at four minutes. Protocol
  pipes are rehydrated and Service forwards re-bound forked too, and the watchers of processes that
  were live across the restart run as their session's owner, so a process that ends after a restart
  is recorded as ended (a watcher with no principal was refused its first lookup and retried
  forever).
- 63e5d8b: A Stop asks its executor for one final save instead of three small ones first. The stop's
  checkpoint and the agent's harvest read that save. On the box this was 8.6 s of a 25 s Stop, and
  `mend stop` answered only after the first of those saves.
- e63d8eb: A Stop made while a status read was on its way makes one final flush and reads `stopped`.
  The person's view asks for the executor's status as they press Stop; the executor answered it
  during Mend's own final flush, and the answer arrived after the final one. The drain could not
  decide on evidence with an answer still unpublished, so it asked for a second final flush (5.1 s
  on the box), and the late `in-progress` answer read as a final flush made outside Mend, so the
  session said `stopped outside Mend · saved at …`. The drain now waits for that answer, and an
  `in-progress` answer during Mend's own final flush is Mend's.
- d24f789: `mend stop <id>`, `mend rejoin <id>` and `mend service logs <name>` take the id or name
  they are given. Without `--project`, `--harness` or `--from` on the line they skipped it, so
  `mend stop <id>` answered "several live sessions".
- d403ac5: The dashboard's session pane names a session's running Services again. It read
  `GET /services` as a flat list of Services, while the server answers one view per Service with the
  Service nested inside it, so every session said `no services running`. `mend service list` and the
  dashboard now read the same view the same way. The harness picker for a new session in an existing
  worktree says the session joins that worktree, where it said `new worktree`, and the new-worktree
  form's base hint stays inside the form's border.
- 765bf12: The dashboard's snake no longer starts behind your back. It waits on the board until it
  has the keyboard, then counts down 3, 2, 1, go in big half-block digits sized to the board (small
  ones on a short terminal), with the snake visible underneath, and moves only after go. Starting or
  resuming a session from the dashboard gives the game the keyboard once the session's pane shows
  it, and so do Enter, `l` or `→` into a starting session's pane. While the game has the keyboard
  its board border is the accent colour, and the arrows and `h j k l` steer it. Space or `p` pauses,
  and the countdown runs again before the game resumes. Esc or `q` hands the keyboard back to the
  list you were in. No other key acts on the dashboard behind the game. The keys are listed under
  the board and in the footer. A dialog that opens over the game, such as the adopt offer at the
  start of `mend snake`, keeps the keyboard until it closes, and then the countdown starts. Another
  session's start failing leaves the game you are playing alone. In a short terminal the session's
  facts give way to the board. A terminal too small for the whole board says to make it taller, and
  the game does not take the keyboard.
- 08847fc: `mend uninstall` leaves a machine that can reinstall. The plan lists live sessions and
  their workspaces. After the same `type delete`, uninstall stops them and removes each with its
  Docker service, their volumes and its network, then the server. The report names each volume and
  network that went and each that did not. The `mend-store` anchor and the identity go last, only
  once everything else has. If Docker refuses something, uninstall keeps them and writes what is
  left to `uninstall-left.json`, so a second run finishes the job and `mend server setup` reinstalls
  over it. With no configuration here, volumes carrying Mend's installation label and no anchor are
  an earlier install's leftovers: setup's refusal now points at `mend uninstall --server`, which
  lists and removes them.

  With Docker stopped, `--server` and `--all` refuse before touching anything. They no longer remove
  the sign-in and ssh key first and leave them registered on a server that still exists. `--all`
  removes the server first, then asks the signed-in server, when it is another one, to forget this
  machine's key and device, and only then removes local files. A sign-in to the server being removed
  is not revoked: its token went with the server, and `--server` clears it from `cli.json`.

  `--all` also offers the images Mend pulled and built, with their size, and removes
  `/etc/sysctl.d/60-mend-rootless-docker.conf` when setup wrote it, putting back the setting it
  replaced. Docker's build cache gets its own question. The last line names what is still here, the
  CLI itself included (`npm uninstall -g @sealant/mend`), instead of "Mend is gone". Any answer to
  the confirmation other than the word removes nothing, says what was read and exits 1.

- d4a9099: `mend uninstall` removes only the `~/.ssh/config` blocks of the servers it removes: the
  one this machine is signed in to, and with `--all` the local installation's. It finds the local
  one by its alias or by its gateway, so a block set up before setup moved the URL is found too.
  Other servers' blocks stay, and the plan names each block that goes and each that stays, with its
  host and port. An older release's unscoped `Host mend-ws` block names no server, so uninstall no
  longer deletes it. It says the block stays and how to delete it by hand. The key directory stays
  while a block that stays signs with a key in it. `mend ssh setup` migrates that legacy block only
  when it points at the same gateway; one for another server stays.

  `mend ssh <session>` prints the exact `ssh ws-<workspace>@mend-ws-…` command for one session's
  running workspace. No other output showed the workspace id, and the Docker container's name is a
  different id that the gateway closes after its banner. `mend ssh setup` now points at it.

  The uninstall plan no longer counts the server's own `mend` container as a session workspace, so
  "N live sessions" is the number of sessions. An image Docker refuses is asked for again after the
  rest, since removing another tag often removes it, so the last line no longer reports an image
  that is gone. One that stays is named with Docker's reason.

  `mend adopt` over https no longer says "your Mend key signed this clone". The Mend key signs ssh
  remotes only, and adopt now says the clone went over https.

- 70cddcd: `mend server upgrade` no longer keeps every database backup it writes. Each one is a full
  dump under `backups/upgrade-UUID/` and can run to gigabytes. After the new version answers health,
  the upgrade records its backup as completed, keeps the newest two completed backups in the order
  Mend wrote them (its own included), removes the older ones and prints each with the space it
  freed. `--keep-backups N` changes the count and `--keep-backups 0` keeps them all. A failed
  upgrade removes nothing. A backup recorded as pending, or whose dump is incomplete, is always
  kept. Nothing is ever removed but an `upgrade-UUID` directory holding exactly `recovery.json` and
  `database.sql`, or what a removal cut short by a crash left behind: an `upgrade-UUID.removing`
  directory, an empty `upgrade-UUID` directory, or a completed record whose dump is gone.

  Backups written by releases before 0.36 carry no outcome. The first upgrade on 0.36 or later
  treats each one whose dump is whole as completed and keeps only the newest N, including the backup
  of an old upgrade that failed after its target started. Copy any you want to keep out of
  `~/.config/mend/backups/` before upgrading. Their removals end in
  `· from before 0.36, no recorded outcome`.

- 1d17c7f: The `/etc/sysctl.d/60-mend-rootless-docker.conf` that `mend server setup` writes on a
  host that refused user namespaces now starts with
  `# written by mend server setup; mend uninstall removes it`, followed by the setting it replaced
  (`# previous: kernel.apparmor_restrict_unprivileged_userns = 1`). `mend uninstall` can then remove
  only a file setup wrote, and put the kernel's setting back.
- 837ae17: Workspaces set `PAGER=cat`: the images carry no `less`, so `git log` in a terminal failed
  with `unable to execute pager 'less'`. Each person's processes inherit it too. A project variable
  named `PAGER`, a shell profile's, or `core.pager` in a person's git config wins; `GIT_PAGER` stays
  unset so that last one keeps working.

## 0.35.1

### Patch Changes

- c72fac3: The CLI speaks HTTP/1.1 to the server. Node 26's built-in `fetch` negotiates HTTP/2 and
  puts the whole process on one connection, and on an instance behind an edge that connection could
  wedge once the dashboard's or the tunnels' event stream opened: a dashboard launch sat at
  `starting` without reaching the server, and `mend attach` timed out waiting for its upgrade
  ticket. Each request now has its own connection, so one cannot hold up another.
- abd1da3: `mend connect claude` logs in afresh every time and keeps no copy on this machine, as
  `mend connect codex` does: the browser login runs against a throwaway directory, the grant is sent
  and the directory deleted (on macOS, with its Keychain item). It used to keep Mend's grant in
  `~/.config/mend/claude-grant` and send that again while it had not expired; once the server had
  refreshed the login, that copy held a spent refresh token, and a reconnect replaced a working
  login with a dead one. The old directory is removed on the next connect. Both logins' throwaway
  directories now live under `~/.config/mend`, where Codex no longer warns that it cannot create its
  helper binaries.
- 462f5ea: A stop sent while a session is still starting now ends it. Before, a stop that arrived
  before the agent's process existed found nothing to end, and the launch went on to start the
  agent: the session read `running` with no machine behind it once the stop's drain ended the
  executor. A launch now stands down just before it starts the agent when a stop came first, and one
  that started the agent anyway is stopped again as it finishes.

## 0.35.0

### Minor Changes

- 5203afa: Phone notifications no longer repeat a Slack thread. A session started from Slack pushes
  only what its thread does not already say: a failure (the thread marks it with an edit and ❌,
  which Slack does not notify), a question or approval in a channel thread whose project is private
  (that thread gets no replies), and everything once the organization's Slack app is removed. A
  finished turn, a completed session, and a question or approval the thread posts do not push. Each
  person now chooses what reaches their phones, in the phone's Settings → Notifications: turn
  finished, needs your input and failed (on by default), and sessions started from Slack (off by
  default). `GET` and `PUT /api/me/notifications` carry the setting; migration 0096 stores it, and
  an account with none saved hears the defaults. The idle stop and a person's own stop never push,
  even while the idle stop is on its way. On the phone, a push about the session on screen, its
  conversation or its terminal, stays silent.

### Patch Changes

- 642baee: `mend connect codex` gives Mend a Codex login of its own: it runs
  `codex login --device-auth` in a throwaway directory, sends that login and deletes it, instead of
  sending this machine's `~/.codex/auth.json`, whose refreshes the laptop would race.
  `--use-my-login` still sends the shared one. `mend accounts` and `mend doctor` say
  `reconnect needed · the provider refused the login` for an account the platform could not refresh.
  ADR 0008 and a new page, "How Mend handles your logins", describe the platform as the only
  refresher of a login and every other copy as one that cannot rotate.
- 6f46cd3: A tour, "Read this change" or "Suggest fixes" runs on the login of the person who asked
  for it, no longer on the change owner's. Passes review prep queues run on the login of the session
  that settled, and the tour a landing asks for on the lander's. A pass queued before this release
  says `the pass was queued before Mend recorded who asked for it · ask for it again`. Automatic
  landing reads a request's intent on the login of the turn's sender, and on no one's when the turn
  records none.
- 361d6a6: A session launches once at a time. A resume keeps the session's row settled until its
  agent runs, so a second resume sent meanwhile (a phone still offering Resume) drained the first
  one's new machine and started another; on alpha three taps started three machines and the session
  ended `failed`. The second resume, launch, handoff or follow-up is now refused with
  `starting · a launch of this session is already under way · nothing new started`, and the session
  reads `starting` everywhere while its launch is under way.

## 0.34.5

### Patch Changes

- 438fd70: An agent on a new machine no longer shows a blank screen while it starts. Until its first
  output, `mend attach`, the dashboard's `a`, and the web and desktop terminals say
  `claude is starting on the new machine · 23s`. The line is erased the moment the agent draws, and
  the agent's screen is not touched. A reattach to an agent that has already drawn shows its screen
  at once and never shows the line. The session line reads `claude is starting on the new machine`
  until the agent's record carries output. Each agent process now records when that happened
  (`firstOutputAt` on the session's processes, null until then; migration 0095).

  A launch now also reads the harness's files on the new machine in the background while the rest of
  its setup runs: the binary, its interpreter, and `claude --version` (or `codex`, `opencode`). The
  real start then finds them already read from the machine's lazily fetched disk. The warm-up runs
  from `/` with a throwaway HOME and removes it afterwards, so it writes nothing to the worktree or
  the harness home. It is abandoned after 60 seconds, and nothing it does can delay or fail the
  launch. A capture-mode standby is warmed when it is claimed, never before.

## 0.34.4

### Patch Changes

- c38952f: `mend attach`, the dashboard's `a`, and every command that attaches put the terminal in
  raw mode before they wait on the server. A slow server no longer leaves the terminal cooked,
  echoing every key locally under `attached · …`: the attach says `connecting to <id> · 12s`, Ctrl+]
  or Ctrl+C gives the terminal back, and after 30 seconds without an open terminal it says so and
  that the session keeps running. On connect the size goes up twice, one row short and then the real
  one, so Claude and other full-screen agents repaint at once instead of on the first key. When raw
  mode cannot be set, the attach says why.

  A long launch (a first launch building a workspace image for minutes) no longer ends in
  `cannot reach the Mend server`. `mend claude`, `mend codex`, `mend run`, `mend resume` and
  `mend rejoin` follow the session until its agent runs, showing the server's own words for what it
  is doing (`starting · building the workspace image`), whether the server answers the launch early
  or holds it, and whether that request times out or an edge cuts it. `cannot reach` is said only
  when no connection opened. `mend attach` on a session still starting follows it, then attaches.
  The dashboard keeps a launch whose request got no answer as a starting row.

- 448e0d3: `POST /sessions/:id/launch` answers within 30 seconds. A launch that takes longer keeps
  going in the background: the session reads `starting` and its line says where it is
  (`waiting · the previous session in this worktree is saving`,
  `building the workspace image (first launch after an update, ~8 min)`, `booting`). It then moves
  to `running` or settles `failed` with the reason. The VS Code extension follows the session line
  until the agent runs.
- 448e0d3: A session whose agent is running reads `running`, with its start time stamped. A client
  that gave up on a launch request (or a phone app sent to the background) no longer cuts the launch
  between the agent's start and its process row, and a session's `started_at` is no longer left
  empty.
- 448e0d3: A session started in a worktree whose previous session is still saving now waits for that
  save instead of failing with `worktree leased · … saving before it ends`. It reads
  `starting · waiting · the previous session in this worktree is saving`, then starts once the
  previous executor's end is confirmed. It is refused only after 30 minutes
  (`MEND_LAUNCH_LEASE_WAIT_SECONDS`), and a stop while it waits launches nothing.
- 448e0d3: Opening a session's terminal now gets an answer within 20 seconds. If the platform is
  slow to hand over the terminal, the attach is refused with
  `the platform did not attach the terminal within 20 s · the session keeps running · attach again`,
  before the CLI gives up on the connection.

## 0.34.3

### Patch Changes

- be11f31: A seal's checks no longer stall the Mend server. On alpha, a seal over a 1.57 GB capture
  (a pnpm `node_modules`) held the API's thread for over ten minutes, and every other request waited
  6–10 minutes. Mend now decodes each dir object once per check instead of once per member looked up
  through it, hashes and decompresses in slices that let other requests run between them, and runs
  one seal verification at a time. On a bucket that refuses overwrites (S3, R2, MinIO), a later seal
  also reuses the member digests and object proofs an earlier one took instead of reading those
  bytes again. On a bucket that does not (Garage), every seal reads everything again, as before.

## 0.34.2

### Patch Changes

- d2c2714: The packaged acceptance gives the degraded dotfiles session as long as the first one (20
  minutes): a session reads completed only once its final save is sealed, which on the bundle's
  Garage store waits about 10.5 minutes.

## 0.34.1

### Patch Changes

- 13c571c: The packaged acceptance waits for a stopped session's executor as long as a Garage-backed
  seal can take (about 10.5 minutes), instead of three minutes, so a release is no longer refused
  for keeping an executor until its work is sealed.

## 0.34.0

### Minor Changes

- 9cbcfe3: Mend reads and registers captures whose directories travel in dir packs (sealantd's
  capture manifest format 2): a pnpm `node_modules` that was about 20,000 uploads, one per
  directory, is now a few packs to upload and a few to restore. `plan.get` tells executors they may
  write it (`manifest_format: 2`); `MEND_CAPTURE_MANIFEST_FORMAT=1` tells them to go back to one
  object per directory. Captures already written one object per directory keep restoring, and so
  does a capture that holds one section of each. Register checks, prices and records dir packs like
  any pack; retention keeps them; the dependency cache promotes them.

  Retention also stops removing the directories below a live capture's older-format section once its
  epoch is fenced. It kept only that section's root, so when a head moved to a new executor and
  carried its bulk section along, the bulk tree's directories were swept once the head had stood for
  the 30-minute grace.

- 85dc7e8: A session that moves between executors of different platforms, such as arm64 and amd64,
  keeps each platform's dependency tree. sealantd now carries the bulk sections built on other
  platforms in the capture manifest (`sections.other_bulk`). `plan.get` answers each executor the
  tree built for its own platform, from `bulk` or `other_bulk`, and `"pending"` when there is none,
  so no executor restores a tree built for another platform. Register checks each carried section.
  It does not ask the bucket again about a section the parent capture already holds. Retention keeps
  every object a carried section names, under fenced epochs as well. The engine skips the install
  command when the head carries a tree for the executor's platform. The dependency cache never
  serves a record under the wrong platform. Manifests without `other_bulk` read and register exactly
  as before.
- ee1236e: A device token minted by hand. Settings → Devices gains "Mint a token by hand": name the
  device and Mend mints the same token a pairing claim would, shown once beside the configured
  origins, for a device that cannot scan a code: an App Review tester, a headless box. It lists and
  revokes like any paired device. `POST /api/me/devices` carries it.
- fb47287: Landing says why it did not land, and a request to land lands. Every turn automatic
  landing decides records a reason and logs it; beside a question, `autopr=false`, landing off and
  someone else's turn, a turn now reads `not landed · the change is empty`,
  `not landed · nothing new since the last landing` or `not landed · the change was not captured`
  (migration 0073). Before it reads the change for a landing, Mend asks the executor to flush its
  captures, up to three times: a stale head is neither landed nor called empty. Follow-ups are read
  before the change, and a request can read as `land` ("land it", "open a PR"), which lands the
  owner's change even when the turn changed nothing, and in a Slack thread even with automatic
  landing off. Inside a workspace, `mend land` lands the session's change as its owner and prints
  what was pushed and what GitHub said, or why not; the opening prompt tells the agent to run it
  when asked to publish, and never to push itself.
- da47b7e: A conversation session (started from Slack, or from the web or phone composer) no longer
  keeps its agent and workspace up until the platform's cap ends it. Mend stops an agent that has
  sat idle for `MEND_PROTOCOL_IDLE_STOP_MINUTES` (default 15; 0 turns the stop off): no turn in
  flight, no question or approval waiting, no live Service and no open shell. The stop is the Stop
  button's, so review prep runs, and the session reads
  `idle · stopped after 15 min · reply to resume`, with an `idle-stop` in its control log. The Slack
  thread's status message says the same and its reaction becomes 💤. The next message, a Slack reply
  or Resume, continues the same conversation. Migration 0072 adds the claim that stops each session
  once across workers.
- 5f18699: A stop no longer loses work an executor has not shipped. In capture mode every stop Mend
  asks for (the Stop button, `mend stop`, the idle stop, a relaunch, a replacement ahead of the
  platform's cap) drains first: Mend flushes, reads what is left and repeats until nothing is
  pending, then terminates the workspace, and releases the worktree lease only once the platform
  reports the workspace gone. While it drains the session reads `saving · 3 left` on the web, in
  `mend status`, on the phone and in its Slack thread. A drain that moves nothing for
  `MEND_CAPTURE_DRAIN_STALL_SECONDS` (default 600) reads `not saved · 3 pending · workspace kept`,
  tells the owner's phone once, and keeps the workspace; only the owner's **Discard unsaved and
  stop** (audited) ends it. The idle stop waits while captures are still shipping.
  `MEND_EXECUTOR_MAX_SECONDS` states the platform's cap, and a planned drain starts ahead of it,
  counted from the executor's own start. An executor the platform does not answer for is no longer
  taken for dead, and a session removed while its workspace is up is removed once the workspace has
  gone. Migration 0075 adds the capture columns to sessions.

### Patch Changes

- 645229d: A sealing register reads each pack at most once. On a bucket that does not refuse
  overwrites (Garage), one register of a large repository had read every pack again for each
  hardlinked file it checked: about 40 GB of reads for 0.78 GB of packs, taking 4.5 minutes. A
  register now answers within 40 seconds. If the seal checks take longer, the capture registers, the
  answer says the seal is withheld while verifying, and the seal is recorded once the checks pass. A
  retried register joins the one already running instead of starting a second.

  Upload URLs now last as long as their uploads need: at least 5.5 minutes, at most 15. On Garage a
  Stop's seal is withheld for about 10.5 minutes instead of 20.

  A capture step that runs past its bound (sealantd's `overdue`) shows on the session as
  `capture step overdue · <step> · running … · bound …`, and such a session never reads idle or
  saved. Migration 0093 adds the columns. Core does not forward the field yet.

  Sessions on SHA-256 projects start: capture 0 names the object format. A launch interrupted by a
  lost create answer now settles `stopped` once its executor ended, instead of staying `starting`. A
  withheld seal reads `final seal not confirmed`, not `not registered`. A session-channel request
  whose token lookup fails gets a 503 instead of stopping the Mend process.

- 8c721d7: A hot-pool standby in capture mode no longer runs anything before a session claims it.
  Mend used to run its helper install and workspace note in every standby right after it booted,
  which told the executor it held a session's work. A standby whose replan then failed wedged for
  about eleven minutes and ended `failed` with a discard needed, and shrinking the pool never
  released it. The setup commands, the helper and the note now run at claim, after the replan.

  After a `docker stop` outside Mend that saved, the session now settles
  `stopped outside Mend · saved at … · capture <n>`. Before, Core reported the executor `failed`
  with its container removed, and Mend read that as kept, so the session stayed `stopping`. An
  executor Core retains for recovery still reads as kept.

- bfa8d08: A seal now stands only while no upload URL of any epoch its objects live under could
  replace one, including packs it carries from an earlier epoch. Migration 0092 records those epochs
  on the seal. Once a seal is recorded, no epoch gets a URL for an object it names. A request for
  upload URLs that waited past its epoch's end records nothing and mints nothing.

  Saving what an executor already holds is never refused for the byte quota. That covers a draining,
  kept or recovering executor's uploads and registers, and every `final` capture's register. The
  byte ledger is now per executor launch, so a new executor starts with its own budget.

  A drain's FINAL answer reads saved only when the executor's recorded evidence does. That is the
  same decision seals and executor ends use. A delayed `complete` no longer logs `saved` or stops an
  executor whose evidence still holds an unsaved answer made after it, or one that cannot be ordered
  against it.

  Mend reads sealantd round 10's stores: the `wide_times` manifest feature (modification times
  before 1677 or after 2262, kept exactly and handed only to executors that read them), linked
  worktree admin under `.git/worktrees/`, and the extra git pack of nested-repository objects.

- a2d5b77: A final flush that Core's deadline or sealantd's own shutdown started is no longer
  refused for the byte or call quota. sealantd marks such requests `"flush":"final"`, and Mend
  exempts them whether or not it is draining the session, logging the bytes it admits over the
  quota.

  Mend refuses to adopt SHA-256 repositories ("Mend doesn't support SHA-256 repositories yet.") and
  removes the clone. A SHA-256 project adopted earlier is refused the same way when a session starts
  on it.

  Status lines no longer call a registered capture saved:
  `executor not answering · last capture 10 at 07:33:53 UTC · not confirmed` replaces
  `last saved capture 10 …`. A session whose executor the platform keeps for recovery reads
  `stopping · retained` instead of `running`, and a resumed session no longer shows the previous
  executor's `stopped outside Mend · saved at …` line.

  A launch that claimed a standby whose re-plan failed, and which held nothing, goes on with a cold
  executor at once (with sealantd's matching fix) instead of failing after about 12 minutes.

  The docs site has a new Known issues page: the seal wait on Garage, SHA-256 repositories, how
  build output carried from another platform is checked, and what a machine failure can lose.

- 9e0f933: A final seal is no longer refused because the store failed a read while Mend checked it.
  A 503 or a timeout from the bucket, or a database error while recording the seal, now answers
  `seal: withheld` with the reason `unavailable`. Mend drops that check, and the executor's next
  register checks the capture again and records the seal. Before, the refusal was cached as
  `unrestorable`, or the seal read `verifying` forever, until Mend restarted. Only bytes that are
  missing or read back wrong refuse a seal.

  A session resumed into a workspace kept by a Service no longer reads
  `running · executor not answering · …` once that executor has answered and started the new
  process. `executor lost · …` stays until a replacement picks the session up.

- 56794c2: A git step the Mend host could not finish no longer marks a sound capture `failed`.
  Before, one `git index-pack` killed by the OOM killer, a full disk while a pack was staged, or a
  large repository whose object walk printed past the 64 MiB buffer recorded the capture `failed`
  for good. Every later plan then restored an older git section under the newest capture, which
  dropped the last turns' commits and left a repository `git fsck` refused, and the final seal was
  refused on every ask. Now only git rejecting a pack's bytes, or a missing object, records
  `failed`. Anything else leaves the capture unverified, and it is checked again on the next
  register, seal re-ask or plan. The object walk no longer buffers git's output.

  A plan never mixes an older git section with a newer capture. If Mend cannot verify the head right
  now, the executor waits and asks again, and the session reads
  `launch waiting · capture <n>'s git section could not be verified on the Mend host · asked again`.
  If git rejects the head's content, the newest capture that verifies is restored whole, and the
  session reads `restored capture <m> · capture <n>'s git section failed verification`. Migration
  0094 resets every capture recorded `failed` to unverified, once, so it is verified again.

- 8c721d7: A recovery boot or an executor's own restart no longer waits on Mend verifying a capture
  it never restores. Before, a host fault on the Mend server (a full disk, a killed git) left a
  crashed executor's recovery unable to ship its staged captures until the fault cleared. Only a
  plan that lays the head down (a fresh launch, a resume or a claimed standby) checks it now.

  If git rejects the head's content, the launch is refused and the session reads
  `launch blocked · capture <n>'s git section failed verification · discard or contact the operator`.
  Mend no longer plans an older capture in its place, which the executor could not restore. A commit
  whose parent is missing now counts as a content rejection, and a check that keeps failing with the
  same unexplained git words is recorded `failed` after five tries instead of waiting forever.

  The `launch waiting · …` and `launch blocked · …` words are added beside the session's summary
  instead of replacing it, so `executor lost · …` is kept until the replacement answers. Words from
  a launch the session has moved on from are ignored.

- 592ab7c: A cold resume no longer changes the saved harness directories' modes and times while it
  moves the new executor's credentials into place. Before, a restored `~/.claude` saved at 0750 came
  back 0700. The move now copies only the entries the restored directory is missing. A session whose
  lost launch Mend recovers reads `stopping · … · stop requested · end not observed yet` until the
  platform reports its executor gone. Before, it said the executor had ended as soon as the stop was
  asked. Mend no longer deletes a skill directory the library replaces or drops. It moves the
  directory to `/workspace/harness-home/.mend/skills-kept/`, even when the directory is exactly as
  Mend wrote it.
- 97d92db: Every executor is one launch: the key its create is asked under names it (migration
  0083). Its session channel token is issued for that launch alone, `plan.get` names it as the
  executor, the store records a completed final flush only when the seal names it, and a stop
  attests the seal only with that launch's own runtime. A new launch never rotates another's token.
  A claimed standby is the session's executor before it is re-planned: when the replan answer is
  lost it drains like any executor, a kept standby refuses the launch, and a cold executor starts
  only once the standby's end is confirmed, under a fresh epoch.

  A create whose answer was lost holds every relaunch, the owning session's too, until its key is
  reconciled: an executor it made drains before anything new starts; nothing on record frees the
  worktree only once Core cancels the key (`cancelCreate`), and on SDK 0.37.2 the next launch asks
  the same create again under the same key.

  A key retention condemned is never registered again (`missing-objects` naming it); sealantd
  uploads the content under a new key generation, and Mend reads both key forms. A completion seal
  is recorded only over a git section Mend verified and worktree metadata that names only what the
  worktree tree holds; metadata naming a missing file is refused. A flush answer that does not
  report snapshot health holds a landing (`snapshot health not reported`), and a suspend flush logs
  `completed` only when the head caught up. A dir entry's nanosecond mtime is read and written back
  exactly.

  A capture whose git section names its trees (`worktree_tree`, `index_tree`, `raw_tree`: the
  `git_trees` feature) is read from `worktree_tree`, verified over all three trees, and planned only
  for an executor that reads the feature; every ref in it is the user's, `refs/sealant/capture/*`
  included. A final flush that answers `changed` (the disk changed after it) is not saved: the drain
  asks again, and never ends an executor on a completed answer it did not ask for in that round.

  An executor that ended on its runtime and that the platform keeps for recovery (`failed` in
  capture mode) is no longer read as dead: its lease and its channel token stay, the session reads
  `not saved · executor kept for recovery`, and only an end the platform confirms releases them. A
  `docker stop` that runs the executor's own final flush reads `stopping · saving`. A runtime that
  is not ready is kept on the kept backoff instead of being flushed every few seconds. The upload
  URL quota is per executor, free for keys already handed out, and never applied while a drain
  saves.

- fcd6e0a: Mend orders capture evidence by the executor's own stamp (`origin`: launch, boot, boot
  generation, observation), never by wall clocks (migration 0087). A seal stands for a lost final
  flush answer only when every unsaved answer the executor gave comes strictly before it; an answer
  nothing orders against it keeps the workspace. Every answer moves a per-executor evidence version.
  An answer still in flight, or one that failed to persist, leaves the executor's evidence unknown.
  A completion attestation, and a `stopped outside Mend · saved` end, commit only on the version
  they read. A stop's attestation carries the seal's stamp.

  Stored capture objects are write-once. Presigned PUTs sign `If-None-Match: *`, and `upload.urls`
  answers a key the bucket already holds as `present` after checking its bytes against its name.
  Cached checks of a key's bytes are bound to the store, and are trusted only once no upload URL can
  replace the object. The directory store publishes objects read-only. Garage v2.4.1 replaces bytes
  despite the header (measured). MinIO refuses with 412.

  A final seal also needs every tracked `hardlinks` group to be one blob of the tree the restore
  checks out, and every `shared` link to name a file its class carries with the tracked file's
  bytes.

- 73f049e: An executor's capture evidence is fenced in the database (migration 0088). A row is
  written before Mend asks the executor anything and deleted in the one transaction that publishes
  the answer: the session's reading, its saved or unsaved word, and the executor's evidence. An
  answer that arrived and could not be published keeps the executor's evidence unknown across
  restarts and engine processes, so an older seal no longer reads saved after a Mend restart. The
  session's queue reading keeps the executor's stamp, so a seal that covers it stands. Evidence that
  nothing orders against a save, or an answer not yet published, reads `completion unknown`, never
  `changes after that were not saved`.

  `upload.urls` answers `present` only to an executor whose `plan.get` listed it in
  `upload_answers`. An older daemon gets a write-once URL for a stored key whose bytes were
  verified, as before.

  On a bucket that ignores `If-None-Match` (Garage), a seal no longer stands while an upload URL of
  its epoch could still replace what it names (migration 0089 records each URL's expiry before it is
  handed out). Once none can, every object the seal names is read back first, and one that reads
  back as other bytes voids the seal. On such a bucket a seal stands up to twenty minutes after the
  last upload URL of its epoch.

  Register checks the worktree metadata against the tree the restore checks out (the raw tree when
  there is one) and the classes restored over it. A final seal also needs every inode the metadata
  links (hardlinks, shared, cross-class) to be promised one mode and one nanosecond mtime.

- 05497dc: `capture.register` now says whether the final seal it carried stands:
  `seal: {state: "recorded" | "withheld" | "refused", reason?}`. sealantd answers a final flush
  complete only on `recorded`. `plan.get` hands a head's `final_seal` on only while that seal
  stands. An upload URL handed out while a seal's objects are being read back leaves the seal
  withheld.

  Register checks worktree metadata against what the restore actually lays down: the workspace class
  over the raw tree, the bulk class where neither holds the path, and every ancestor of a named
  path. Every class entry a hardlink names promises its inode a mode and an mtime, so two different
  promises for one inode are never sealed.

  A SHA-256 repository's git section (`object_format: "sha256"`) is verified in a SHA-256
  repository. Object ids of another width are `unverified`, where before they read `verified`
  without a walk.

  A capture answer that arrives is kept as evidence even when the log line after it fails.

- 164dade: Mend now keeps every unsaved capture answer an executor gave, unless a later answer from
  the same boot or a later boot replaced it. A delayed old answer no longer erases a recovery boot's
  failure and makes an old seal read as saved again. A seal or a completed final flush counts as
  saved only when it came after every one of those answers. Migration 0090 adds the column that
  holds them.

  Issuing upload URLs and accepting a seal now wait on the same row (migration 0091), so a URL
  issued during a seal's verification is always seen. Once a seal is recorded, the stored objects it
  names never get an upload URL: `upload.urls` answers them `present`, or refuses them with
  `409 exists` if the executor does not read `present`.

  A tracked hardlink group, or a shared link's tracked file, has its bytes compared in the files the
  restore actually writes, including the workspace overlay. A group whose members differ only after
  the overlay is applied is not sealed.

  The git section's `ref_format` (sealantd's `ref_format` manifest feature, `reftable`) is decoded,
  handed only to executors that read it, and verified in a reftable repository. A ref backend Mend
  does not read is `unverified`, as is a section whose HEAD is `refs/heads/.invalid`, the
  placeholder in a reftable repository's `.git/HEAD` file.

  A discard logs the request before the stop, and logs `discarded` only after the platform confirms
  the end.

- 0b96ddc: Two retention passes that overlapped no longer delete a capture registered between them.
  A pass that condemned objects now holds a claim on them until it has deleted them and settled
  their tombstones (migration 0080); while any pass holds one, a register naming those objects is
  refused with `missing-objects`, and it registers once that pass is done and the executor has
  uploaded them again. A pass whose claim lapsed stops deleting and leaves the rest for the next
  pass.

  Mend's capture reader writes a file name or symlink text that is not UTF-8 as its bytes, as
  sealantd carries them in `raw_name` / `raw_target`, instead of the escaped name, and register
  refuses an entry whose raw bytes disagree with its name.

  Register validates the manifest as it is stored — a request carrying a different copy is refused —
  and refuses a capture whose worktree metadata document would not restore: an unread format, packs
  outside the workspace section, chunks that do not add up to its size and digest, or a document
  sealantd would reject.

  A capture whose manifest carries sealantd's `final_seal` (a completed final flush) records it on
  the chain for that executor and epoch (migration 0080), when it is complete and names the executor
  and epoch that registered it. It is what Mend reads as "saved".

  `plan.get` refuses a head holding `worktree_meta`, `symrefs`, `other_bulk`, raw names or a
  `final_seal` to an executor that does not list the feature in `manifest_features`, before it
  claims the lease (409 `manifest-features`), and answers the features Mend reads.

  `plan.get` names the executor a completed final flush must seal as. A ref name that is not UTF-8
  counts as a raw name, and the runner writes it into `packed-refs` and `HEAD` as its bytes.
  Register checks the metadata document's cross-class link groups, and a drain reads sealantd's
  `sealing` as "final seal not registered" and keeps asking.

- 323d9ac: Retention no longer deletes packs a capture registered during its pass still needs. A
  final capture that reused packs from a capture being thinned registered, and the pass then deleted
  those packs: the head could not be read. Register and retention now meet on a per-chain guard
  (migration 0076), so one of the two always sees the other; a capture naming objects retention is
  deleting is refused with `missing-objects`, and registers again once the executor has uploaded
  them again.

  Register refuses a capture Mend could not restore: a root no listed dir pack holds, a dir object
  that is not in the bucket, a chunk in no listed pack, a file whose chunks do not add up to its
  size, or a hardlink whose canonical member is missing (422 `unrestorable` or `missing-objects`).
  Sections carried unchanged from the parent are not walked again.

  Reading one file of a capture follows a hardlink member to its canonical member instead of
  returning an empty file, and fails when the bytes read are not the size the entry says. Transcript
  harvesting reads files this way.

  `plan.get` hands a head holding dir packs (format 2) only to an executor that says it reads them
  (`manifest_format` on the request), refusing any other with `manifest-format` before it claims the
  lease, and never tells an executor to write a format it did not say it reads. Rolling sealantd
  back is in ADR 0002 decision 30 and the server environment reference.

- 9b445f6: A resume no longer runs the dependency install when it cannot read the saved capture's
  manifest. Before, one failed read (a 503 from the bucket) counted as "no dependency tree for this
  platform", so `npm ci` ran over the restored `node_modules` and put a patched file back to the
  published bytes. Now Mend installs only when the manifest it read has no tree for the executor's
  platform, or the worktree has nothing saved yet. When the read fails, nothing is installed and the
  session says `dependency install skipped · capture <n> manifest unavailable`. Run the install
  yourself if the dependencies are missing.
- 90512b7: Two status lines now say what was saved. A launch that failed, and whose kept executor
  the platform ended after it sealed, reads `launch failed: … · saved at … · capture <n>`. A session
  Mend stopped because its executor ran a final flush on its own (a `docker stop`, a platform
  deadline) reads `stopped outside Mend · saved at … · capture <n>` once saved, as other sessions
  ended outside Mend do.
- 0a04c67: A resume keeps what you and the agent wrote in the harness's memory files. Mend's note in
  `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` used to run from a `<!-- mend:mounts -->` line to
  the end of the file, and every launch cut the file there, so instructions added below the note
  were lost at the next resume. The note is now a block between two marker lines, and a launch
  replaces only that block. An old note becomes the block when it is exactly what Mend wrote; an
  edited one is left in place and the block is added after it. A file Mend cannot read is left
  alone. Three other launch writes no longer replace your files: Claude Code's `settings.json` and
  `~/.claude.json` are only merged into when they parse, Codex's trust table starts on its own line
  in `config.toml`, and a skill directory that differs from what Mend delivered is moved to
  `/workspace/harness-home/.mend/skills-kept/` instead of being deleted.
- 20bf55b: Mend runs Sealant 0.38.0 (sealantd 0.19.0): the bundle's Sealant API, worker and SSH
  gateway move to 0.38.0, and a capture flush now tells the platform whether it is a final flush, so
  a Stop's final save reaches the executor as a FINAL.
- c19da44: A session's executor is on its row from the moment the platform accepts it, before any
  setup command, relocation, install or harness runs in it. A launch that fails after that (a custom
  setup command that exits non-zero, a relocation, the harness PTY) drains the executor instead of
  stopping it outright, keeps holding removal and the worktree until its end is observed, and
  settles `failed` with the launch's own words. A lease that still names a session with no workspace
  on its row (a launch cut short around its create) holds removal and the worktree too, lapsed or
  not.

  A restart serves the channel of every session a worktree lease names, so an owner that stopped
  while a joined session still works keeps shipping. A relaunch whose opening prompt no process took
  after a restart launches again, or keeps the prompt and says `opening prompt not delivered · …`;
  the plan clears only once a turn with its correlation is accepted or the owner stops.

  Nothing reads `saved` from a capture's kind any more: only the executor's own `complete: true` for
  that executor and epoch, or the store's sealed record of it. An executor stopped outside Mend
  whose final capture registered without either reads
  `stopped outside Mend · last saved capture 21 at … · completion unknown`. A landing waits for a
  small snapshot that read everything: a failing small snap, an unreadable path or a small refusal
  hold it, however empty the queue; a failing bulk snap does not. An agent whose executor never
  answered reads `executor not answering · … · completion unknown`, never the harness's `completed`.
  The planned drain ahead of a platform's cap counts back from `workspace.runtimeDeadline()` once
  the SDK has it, and every drained stop tells Core the completion the store sealed.

  Every capture-mode executor create carries an idempotency key written on the session before the
  create is asked (migration 0082). A create whose answer was lost, in the launch or across a
  restart, is found by that key once the SDK can look (Core's next SDK): the executor goes on the
  session and drains, or, when none was made, the worktree is free again. The executor's runtime
  identity comes from the create's `launch.runtime`, else `workspace.runtime()`.

- 89d3c52: Capture mode: nothing an executor holds is let go on an empty queue alone.
  - Every drain (stop, idle stop, relaunch, replacement) asks for a final flush and counts only the
    executor's `complete: true` as saved. Until the SDK carries it, a drain keeps its workspace and
    reads `not saved · final flush not reported · workspace kept`; an incomplete flush names
    sealantd's reason. Nothing is started, joined or resumed in an executor sent a final flush.
  - The lead before a stated cap grows with what is pending at the executor's observed throughput.
  - A lapsed lease is not an end: another session is refused until the platform confirms the holder
    ended, and a release now clears the holder.
  - Worktree and project removal wait for drains, kept workspaces, unended executors and held
    leases; the session that owns an executor stays while another session works in it.
  - Every landing (Land panel, Slack, `mend land`, a completed turn) checkpoints only once the
    captures caught up; unknown is not caught up, and the landing reads exactly that capture.
  - A turn asked after the idle stop's claim is refused instead of queued against a stopped agent.
  - A relaunch interrupted by a restart finishes: drain, terminate, then the launch it was asked
    for, opening prompt included, exactly once (migration 0077).
  - The owner's stop during a replacement wins: the executor saves and ends, and no new one starts.
  - After a restart, a session still draining gets its executor channel back, so the drain can
    finish.
  - "Discard unsaved and stop" asks the platform for a stop that does not drain, and says so when
    the platform keeps the workspace.
  - An agent whose executor went away without Mend asking reads
    `failed · executor lost · last saved …`, never `completed`.
  - A launch that failed before any executor existed releases its worktree lease.

- 90512b7: Custom-image setup commands now run only on a worktree's first launch. Before, a resume
  ran them again over the restored worktree, so `npm ci` put a patched file in `node_modules` back
  to the published bytes before the shell opened. A launch that restores a saved capture (a resume,
  a recovery, a relaunch, a standby claimed onto saved work) runs none of them. It still installs
  the `mend` helper and git transport, and the session says
  `setup skipped · restored from capture <n>`. Run the install yourself after a resume if a lockfile
  changed. Put anything setup installs outside the worktree in Extra packages or the base image.
- 288727f: A resume leaves a skill directory alone when its files already match the library. Mend
  used to remove and rewrite it at every launch, so a script you made executable came back without
  its executable bit, and empty directories and hard links you added were lost. A skill Mend
  replaces or retires is deleted only when it is still exactly what Mend wrote, modes included;
  otherwise it is moved, unchanged, to `/workspace/harness-home/.mend/skills-kept/`. Mend's note and
  Claude Code settings writers no longer delete a file that happens to have their temporary file's
  name.

## 0.33.0

### Minor Changes

- baa5377: A default zsh profile for workspaces. When a session launches into a zsh workspace, Mend
  writes `~/.zshrc` and `~/.config/starship.toml` wherever your dotfiles left no file: history and
  completion settings, fzf and direnv hooks, the autosuggestions, syntax-highlighting and
  history-substring-search plugins, and a starship prompt. Mend never overwrites a file that exists,
  so your dotfiles always win. Every block checks for its tool first, so an image without one of the
  packages still starts the shell. A project turns it off under Setup → Dotfiles → Default shell
  profile.

  New installs default to zsh and add `starship`, `zsh-autosuggestions`, `zsh-syntax-highlighting`,
  `zsh-history-substring-search` and `direnv` to the default packages. A saved instance,
  organization or project environment is not changed. These package names need a Sealant release
  whose catalog has them.

- 13b1f67: Organizations have their own defaults. An organization's owners set its workspace
  environment and automation switches (background sessions, description and tour, fix suggestions,
  session naming, landing) in Settings; every project in the organization inherits them unless it
  overrides a value, and anything the organization leaves unset follows the instance. Members read
  the values that apply and where each came from. Changes are recorded in the organization's audit
  log.

  The instance's defaults stay the operator's, and Settings now shows their editors only to the
  operator instead of showing them to everyone and refusing the save.

### Patch Changes

- baa5377: Sealant 0.37.2: the package catalog gains `starship`, `zsh-autosuggestions`,
  `zsh-syntax-highlighting`, `zsh-history-substring-search`, `direnv` and `eza` on every managed OS
  family, which the default shell profile uses; and projects on the nix, Fedora and Ubuntu families
  launch again with packages such as `python` and `github-cli`, which Sealant 0.37.1 renamed to
  distro names and then refused. The image copies the released 0.37.2 Sealant API, worker and SSH
  gateway by digest, and `@sealant/sdk` and `@sealant/api-contracts` move to 0.37.2.
- 39bcdcd: Five web actions failed with "internal error": changing a project's visibility, turning
  shared control on or off, changing a member's role, uploading files to a folder, and choosing a
  project's folders. The web server passed plain objects where the API contract expects its request
  classes, which Effect refuses to encode. It now builds the request classes.

  The Slack link page confirmed nothing: its preview reached the API as a cookie-bearing POST
  without an Origin and was refused. The preview now travels as a mutation, which carries the page's
  Origin. Private Slack replies to a top-level mention (the link prompt, `settings` answers) were
  posted into a thread nobody had opened, where Slack shows them nowhere; they now appear in the
  channel.

## 0.32.1

### Patch Changes

- 0a6109c: Connecting a Slack app no longer refuses a valid app-level token with `invalid_auth`.
  Mend sent the `xapp-` token in the request body as well as the `Authorization` header, and Slack
  refuses an app-level token in a body. It now travels as a header only, the way the SDK's own
  Socket Mode client sends it. The app the token belongs to is read from `auth.test` for that token;
  the `app_id` on the socket URL is a hash, not the app id, and comparing it against the bot's app
  refused every pair of tokens.

## 0.32.0

### Minor Changes

- 01f6cb7: `mend doctor --bundle` collects what a maintainer asks for one output at a time into one
  tar.gz: this CLI and its environment, the doctor lines, the server's health, the local server's
  configuration (compose file, `.env` key names only), Docker's version, info, contexts, the Mend
  and workspace containers with their inspect facts, the local server's container logs, the running
  workspace containers' logs, every session with its processes, exit codes, argv and recorded
  terminal output, the connected accounts, and the versions and paths of claude, codex, gh, git and
  docker. Each part is collected on its own: one that fails leaves a `<name>.error.txt` in the
  bundle. One redactor runs over every file before it is written, the archive is mode 0600, and the
  command says so: it still contains logs and configuration, so read it before sharing.
  `--out <path>` and `--tail <n>` (lines per log and per record, default 500) are the options.

## 0.31.0

### Minor Changes

- 8f82bd3: Workspaces commit as you. "Git author" is a new account setting: a name and email in
  Settings, or `mend git-author "Name" you@example.com` (`--clear` goes back to the name and email
  you registered with, which is also what applies until you set one). Before the agent starts, every
  workspace receives it as system git config, co-located or captured, cold or a claimed standby. A
  `.gitconfig` from your dotfiles and a repository's own config still decide over it. Agents no
  longer have to make up an identity to commit.
- f57a064: Landing finds a pull request opened outside Mend and updates it instead of opening a
  second one. Mend looks with the owner's `gh` 45 s after the agent pushes a branch through the
  workspace transport, and again when the agent's turn ends while its workspace is up. "Check
  GitHub" in the Land panel, and `mend land <session> --check`, look on demand, even when nothing
  has landed yet. The lookup covers the worktree's branch, every branch the agent pushed, and any
  pull request that holds the agent's head commit. The next landing pushes that pull request's
  branch and updates it. A pull request from a fork is shown
  (`pull request #367 · merged · observed · opened outside Mend · from anna's fork`) and never
  updated, because Mend pushes to origin only. The lookup that finds the pull request to update no
  longer mistakes a fork's same-named branch for origin's.
- 77bd0d5: A stop ends the agent and leaves Services running, and a running Service keeps the
  workspace up. Every surface now says so: the web session page and project list, the desktop inbox
  and terminal header, and `mend sessions` and the dashboard read, for example,
  `agent stopped · 3 services keep the workspace up`. Stop services (`mend stop --services`, ⇧K on
  such a row in the dashboard, the button on the session page, and the desktop's stop services)
  stops all of them, and the workspace ends once nothing is live. Review prep now starts when the
  agent stops or exits, even while Services keep the workspace up.

### Patch Changes

- c980a4a: On captured workspaces (AWS MicroVM executors), a pasted image now reaches the agent:
  Mend writes it into the live workspace's harness home, at the same path the terminal pastes.
  Before, it landed on the Mend server, where no captured workspace could read it. A session with no
  live workspace now answers that it is not live instead of returning a path nothing can read. The
  owner's skills reach captured workspaces the same way, before the harness starts.
- 149b8ec: Mend caps its database connections: 6 for its queries (`MEND_DATABASE_POOL_MAX`), 3 for
  the job queue (`MEND_JOBS_POOL_MAX`) and 3 for sign-in sessions (`MEND_AUTH_DATABASE_POOL_MAX`),
  where each pool was previously uncapped at pg's default of 10. A refused connection from the job
  queue or the sign-in pool is logged and retried instead of exiting the API. The bundled image
  waits up to 240 s for Mend's first health answer before it restarts the bundle.
- f3f432c: Review passes no longer wait behind each other or run twice. Up to three tours, reads and
  suggestion passes run at once instead of one per kind. A request for a pass that is already queued
  or running for the change is absorbed: review prep, the review page and a landing share one key
  per change, which pg-boss's standard queues never enforced, and a tour whose diff has not changed
  since it was composed is not composed again. A pass reads "queued" from the moment it is
  requested, so the change page shows it waiting instead of "Composing…". Naming a session that
  settled without a first prompt stops there and leaves it unnamed, instead of retrying for an hour.
- f57a064: Sealant 0.37.1, with sealantd 0.18.2: dotfiles `manager: auto` picks stow only for a stow
  layout, so a home mirror keeps its dot entries; a restart keeps dotfiles; and a MicroVM boot
  failure reports sealantd's last output. The image copies the released 0.37.1 Sealant API, worker
  and SSH gateway by digest, and `@sealant/sdk` and `@sealant/api-contracts` move to 0.37.1.

## 0.30.0

### Minor Changes

- d91db01: `mend land <session>` publishes a session's change: Mend takes a checkpoint, commits what
  the agent left uncommitted, pushes the branch to origin (fast-forward only, never forced), and
  opens or updates its GitHub pull request. `--branch` names the branch on origin, `--no-pr` pushes
  only, and `--title` sets the pull request's title. It prints the landing and what Mend observed,
  in the remote's own words when a push is refused, and exits 1 then. Only the change's owner lands,
  and the session's branch is never moved.

  `mend pull <session>`, run in a local clone of the project, fetches the change as `mend/<name>`
  from a git bundle, before landing and without origin. It leaves the working tree and the current
  branch alone, only fast-forwards an existing branch, and refuses a bundle over the server's limit
  with its size.

  `mend codex|claude|opencode` take `--land` and `--no-land`, which override the project's "Land
  when a turn completes" setting for one session.

- 1aa929c: Session Services work in capture-mode (MicroVM) sessions, where Mend is not beside the
  worktree. `mend.toml` recipes are read from the session's live workspace, so
  `mend service run <name>`, the web's recipe list, and the agent's own `mend service run <name>`
  find them there; a session with no live workspace says so instead of answering 500. The agent's
  Mend Services instructions are written into capture-mode workspaces too, and the in-workspace
  `mend service run` and `mend service add` take `--http`/`--https`, so a Service the agent starts
  gets a browser URL.

  `mend attach`, `mend codex|claude|opencode`, and `mend rejoin`, attached to a session on a server
  that is not this machine, tunnel that session's live Services declared `--http` or `--https` to
  this machine's loopback: on the Service's own port when it is free, else on a free one, one line
  each (`web → http://localhost:5173`). A Service that stops closes its tunnel, detaching closes
  them all, and the Services keep running. The dashboard does the same for the selected session and
  shows where each opens in the session pane. `--no-tunnel` opts out; `mend service connect` is
  unchanged.

  The web's and the desktop's Services show `mend service connect <name>` in place of a dead Open
  link when a Service answers only on a remote Mend host's loopback.

- 5a08921: Mend in Slack (ADR 0006): an organization owner connects a Slack app made from Mend's
  manifest (Settings → Slack, Socket Mode, outbound only). `@mend <prompt>` in a thread starts a
  session for the linked person in the project the message, the thread or a default names, reports
  into the thread, and takes follow-ups there.

  Automatic landing (ADR 0007): a session started from Slack pushes its branch and opens or updates
  a pull request after a turn that asked for a change, never for a question. Projects can turn it on
  for their own sessions ("Land when a turn completes") or off for every session; `autopr=` in a
  Slack request overrides it.

### Patch Changes

- ff401b2: The server's clone of a dotfiles repository is bounded. It clones one branch at depth 1
  with no tags, never downloads a file larger than 4MB, is stopped past 64MB on disk or after 60
  seconds (git and every helper it started are killed), and the packed archive is capped at 4MB as
  it streams. Each refusal names the bound it hit, and a file over the per-file bound is named by
  its path. Under the tenant source policy the pinned ssh command keeps `BatchMode=yes`, so a
  dotfiles clone over ssh fails with ssh's own message instead of trying to prompt.
- 79045d4: The dotfiles repository's manager can be chosen. Settings → Dotfiles offers `auto`,
  `copy`, `stow` and `chezmoi`, each with a line saying what it does, and saving sends the choice;
  before, the page always kept `auto`. From the terminal,
  `mend dotfiles repo <url> [--ref <r>] [--subdirectory <d>] [--manager <m>] [--no-bootstrap]` sets
  the repository (the server tries the clone before it saves, as the web save does) and
  `mend dotfiles repo --clear` removes it. `mend dotfiles` now names the manager on the repository
  line, for example `(default branch · dots/ · manager copy · install.sh on)`.
- 74e0974: Adding files to a dotfiles snapshot (a merge, as the web's add-a-file does) now counts
  the files the snapshot already holds against the 4MB cap. Before, only the files being added were
  counted, so repeated additions could grow a snapshot past what one launch can carry. A merge that
  would pass the cap is refused with "snapshot exceeds the 4MB cap with the files it already holds",
  and the snapshot stays as it was.
- d445355: The server's clone of a dotfiles repository, at launch and when it is saved, now runs as
  the account whose dotfiles they are, never with the server's own Git and SSH setup. An SSH URL
  signs with that account's Git access: its Mend key, or its connected signer when its Git access is
  the bridge. An HTTPS URL clones without a credential, so only a public repository clones that way;
  a refused HTTPS clone says so and points to the SSH URL. These clones read none of the server's
  credential helpers, `.netrc`, SSH agent, SSH config or key files. On a single-tenant install
  (`MEND_TENANCY=single`) the operator's own dotfiles still clone with the server's setup, as
  before.
- 3e001fb: Saving a dotfiles repository now runs the launch's own clone and archive once, with the
  same limits and the same Git environment. A repository the server cannot clone, a branch or
  subdirectory it does not have, or a tree over the limits is not saved, and the save shows the
  reason. At launch, a dotfiles source that fails (the repository clone or the synced snapshot) no
  longer fails the session: the workspace starts without that source, the other source still
  applies, and the session records what was left out. The session page shows it, for example
  `dotfiles · repo not applied · <reason>`. Standby workspaces behave the same way. The server's
  clone of a dotfiles repository runs quietly, so a failure reason no longer includes the server's
  temporary directory. The save's clone holds one of the account's launch slots, so saves cannot
  start more clones than the `accountLaunchesInFlight` budget allows; past it the save is refused
  with `BudgetExceeded`. The session page says the dotfiles it lists were `sent at launch`, since
  Mend observes what it shipped, not what the workspace applied.
- 74e0974: A standby workspace is no longer handed to a session after its owner changes the dotfiles
  repository's branch, subdirectory, manager or `install.sh` setting. Before, only the URL and
  branch were compared, so a session could start with the manager the standby was warmed with; now
  any saved change sends the next session cold and the next reconcile warms a standby with the new
  setting. Every standby warmed before this release is replaced once after upgrading.

  `mend dotfiles sync <paths...>` refuses a path outside your home directory before it reads the
  file. Before, `mend dotfiles sync ../file` read the file and uploaded it, and only the server
  refused it. An absolute path under your home directory (what a shell makes of `~/.zshrc`) is now
  taken as its home-relative path.

- ed945d0: Saving a dotfiles repository whose URL carries a token or password is refused: Mend
  stores the URL and shows it on your sessions.

## 0.29.2

### Patch Changes

- 4ee3784: Runs on Sealant 0.37.0 (sealant-sh/sealant#278, #279). Sealant now owns a catalog of
  workspace packages: every id in Mend's default workspace list installs on fedora, arch, ubuntu and
  nix, on x86_64 and ARM64, from the family's repositories or from a pinned, checksum-verified
  release where the family has no package (`mise`, `lazygit`, `uv`). Until now the default list only
  built on Arch x86_64, so a new project on a Lambda MicroVM deployment failed at its first build. A
  package id Sealant does not know is refused when the session's workspace is created, naming it,
  rather than minutes later as a failed build. An Arch image build also fails at the package step
  now when pacman cannot install something, instead of two steps later on a missing `npm`.
  `@sealant/sdk` and `@sealant/api-contracts` move to 0.37.0, and the bundled server image pins the
  0.37.0 API, worker and ssh-gateway digests.

## 0.29.1

### Patch Changes

- f084783: Runs on Sealant 0.36.1 (sealant-sh/sealant#276). Workspace-scoped Docker inside a Lambda
  MicroVM session works on every managed OS family now, and three faults in the families' recipes
  are fixed on every runtime: an Arch project could not be built on ARM64 at all (Docker Hub's
  `archlinux` is x86_64 only; Sealant now builds Arch from Arch Linux ARM's signed rootfs), no
  native harness binary started on the nix family (its image had no FHS dynamic loader path), and a
  recent npm skipped opencode's install script. `@sealant/sdk` and `@sealant/api-contracts` move to
  0.36.1, and the bundled server image pins the 0.36.1 API, worker and ssh-gateway digests.

## 0.29.0

### Minor Changes

- `mend doctor` reports Mend's Claude grant, and `mend connect claude` notices a dead one. Claude
  reports `loggedIn` from what it stored, so a grant whose refresh token is gone or past its own
  28-day expiry still reads healthy; connecting now detects that and logs in again once. Doctor adds
  a `grant` line while Mend keeps a grant of its own: when it expires, that it is signed out, or
  that it cannot be read, each with `mend connect claude` beside it. Nothing is printed for someone
  who connected with `--use-my-login`, because there is no grant of Mend's own to report.
- `mend connect claude` gets Mend a Claude login of its own. Claude rotates its refresh token, so
  two copies of one login fight and whichever refreshes second is signed out; Mend refreshes on a
  schedule, which made your laptop the loser. It now logs in once against a directory Mend keeps
  (`$XDG_CONFIG_HOME/mend/claude-grant`, 0700), checks that Claude really read that directory,
  refuses a grant that is the one this machine already holds, and reports whether your own login
  survived. `--use-my-login` connects the shared login deliberately, and says what it costs.
- The session harness home stops handing out its credential. The mode keeper re-opens read bits
  every 15 seconds so the store-side reader can see harness state, and it was doing that to the
  provider credential the platform injects as well — leaving a refresh token good for weeks
  world-readable on the store. Credentials are now exempt, on the first pass and in the loop.
  Nothing store-side reads them: no harness lists a credential among the paths the harvest collects.
- `mend connect claude` sends the Claude grant alone. The credential document Claude Code writes
  holds `mcpOAuth` beside `claudeAiOauth` — refresh tokens for whichever MCP servers that machine
  authorized — and the whole file used to travel to the platform and into every workspace. Only the
  `claudeAiOauth` section leaves the machine now, the CLI says what it held back, and Mend's API
  narrows the same way so a hand-rolled client cannot widen it
  (`docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md`).
- f51da1f: Add budgets: what one client address, one account and one organization may ask of an
  instance. A request body is refused before it is decoded (1 MiB; 24 MiB on the routes that take a
  file), a WebSocket frame over 1 MiB closes its socket, requests are counted per minute per address
  and per credential with a tighter window for sign-in attempts, and an account holds a bounded
  number of unsettled sessions, launches starting at once, event streams, terminals, tunnels and key
  bridges. A refusal is `429` (or `413`) with the budget's name, and never stops a running session
  or closes an open connection. Every limit is a `MEND_BUDGET_*` variable, `0` turns one off, and
  `docs/operations/budgets.md` lists them. `sessions.create` and `sessions.launch` gain the
  `BudgetExceeded` error.
- b02b45e: Folders and reference repositories reach captured workspaces, and the multi mode gate
  passes. A captured workspace binds no host path, so each folder a project selected now travels
  with the session plan as a gzipped archive — a folder as `tar` of its contents, a reference as
  `git archive HEAD`, the tree an agent reads without the history behind it. sealantd 0.16.0 lays
  each one down beside the worktree, at `/workspace/home/<name>` and `/workspace/ref/<name>`, the
  same paths a co-located install bind-mounts.

  An archive is keyed by its own sha256 under the session's epoch prefix, so a re-plan of unchanged
  content writes nothing, the executor only ever holds URLs under its own prefix, and capture
  retention sweeps the archives with the fenced epoch. A source is a copy: writes inside a session
  stay in that session, because the archives land outside every capture root. A folder that cannot
  be archived is left out with a warning rather than costing the session its start, and one archive
  is capped at 64 MiB — the ceiling the daemon enforces too.

  Both gate items that waited on the platform are in: sealantd declares the length of every upload
  it asks a URL for, and lays down the plan's sources. With the source policy, upload length
  binding, loopback service ports and an operator present, `MEND_TENANCY=multi` no longer refuses to
  start. It requires sealantd 0.16.0 or newer, which the gate's detail names, and which the operator
  pins.

- 8007722: The CLI speaks organizations: `mend members` lists who belongs, `mend invite` prints a
  one-time link (owners), `mend folder list|create|push|rm` manages organization folders,
  `mend session share <id> on|off` turns shared control on or off, and `mend adopt` takes
  `--private` (the default) or `--shared`. The phone app hides steering actions from someone who
  cannot steer a session and stops retrying a terminal whose access was revoked. Projects adopted
  without a stated visibility, from any client, are private.
- 1224d70: Add an error boundary and a browser header policy. Error messages that leave the API are
  scrubbed of what arrived from below (server paths, internal hostnames, credentials and queries in
  URLs, tokens) while Mend's own words pass through; a defect answers `InternalError` with a
  reference id and its detail goes to the server log under that id. `MEND_ERROR_DETAIL=verbose`
  turns the scrubbing off for debugging a private instance. The web tier now sets a
  Content-Security-Policy (this origin only, no framing), `nosniff`, a referrer policy
  (`no-referrer` on pages whose URL carries a credential), a permissions policy, same-origin opener
  and resource policies, and HSTS when the origin is https. The terminal embed keeps working: the
  phone loads it as a top-level document.
- aedabb8: Add `MEND_EXPOSURE` (`loopback`, `private` (the default), `public`) and the public
  exposure gate. How an instance is reached is the operator's statement, since a server cannot
  observe what is published in front of it; Mend reports what it observes beside it.
  `MEND_EXPOSURE=public` refuses to start while an item Mend can observe is open: https browser
  origins, `Secure` session cookies, trusted proxies set and not wildcarded, every multi mode gate
  item (an operator account included), every budget, URL bearers refused, error redaction on, and a
  session channel that is https or declared private (`MEND_EXECUTOR_NETWORK=private`). Items no
  build can observe (Sealant and the database not reachable from outside, the edge's certificate, an
  independent reassessment recorded with `MEND_EXPOSURE_REASSESSED=<version>`) are reported as open
  or declared and never block a start; the first two close only when the operator, having checked
  from outside, names them in `MEND_EXPOSURE_DECLARED`. What the build contains and the API cannot
  see in effect (invitation-only registration, the web tier's header policy) is reported as carried,
  not observed. `mend operator exposure` prints the report; `/health`, which needs no sign-in,
  carries the declared exposure and how many items are open, never which. The gate reports what was
  observed; it never says an instance is fit to expose.

  Session cookies are now explicitly `HttpOnly` and `SameSite=Lax`, and `Secure` whenever `APP_URL`
  is https. The Helm chart (0.3.0) can render an Ingress to the web Service only, refused without
  TLS or with a browser origin that is not its host, and its NetworkPolicy admits the ingress
  controller's Pods by namespace and label. A Compose install run by hand gains an opt-in TLS edge,
  `deploy/docker/compose.edge.yaml` with a Caddyfile that keeps tickets and tokens out of its log;
  `mend server setup` installs do not apply it yet.

- c56e90d: Report how an instance is exposed, not whether a tailnet was found. The shell's machine
  block and `mend doctor` used to say `tailnet · reachable` or `tailnet · not detected`, inferred
  from an interface address in 100.64.0.0/10: a false alarm on a LAN or public install, and never a
  statement about who can reach the instance. They now say what the operator declared and what the
  server observed, for example `exposure · private · https · via proxy`, and `mend doctor` asks for
  https only when the instance is declared reachable beyond the machine. `GET /api/machine` gains
  `exposure` (declared mode, origin scheme, whether the request arrived through a trusted proxy, the
  kinds of address on the host without the addresses, open gate items); `tailnet` stays for older
  clients.
- 820eb92: Add organization folders: directories Mend keeps under the store, which owners create and
  fill and projects select to mount at `/workspace/home/<name>`, read-only unless chosen otherwise.
  They replace host mounts for everyone but the operator of a single-organization install. Uploads
  are capped at 1 MiB a file and 4 MiB a request, and paths never leave their folder. Project detail
  reports whether this deployment mounts them at all (`mountDelivery`).
- 311953b: Warm hot sessions for each person who recently ran a session in the project and can still
  see it, instead of as the first account, and drain a person's standbys once they lose access.
  Nothing runs as a stand-in account any more: a session with no owner cannot launch or be steered,
  the dependency install runs as whoever changed the install command (or the project's creator), and
  the retired queue's runs act as the operator.
- 4a53432: Owners can remove members, change roles, take over a project whose creator left, and read
  the organization's audit log. Removing a member deactivates the account, revokes its browser
  sessions, paired devices and phones, closes its open terminals, tunnels, key bridge and event
  streams on every server process, and stops its sessions through the normal flush and checkpoint.
  The static token now acts as the operator instead of the oldest account. Invitations, role and
  visibility changes, takeovers, folders and references are recorded in the audit log.
- 2540df0: The multi mode gate is computed. Each item answers from this build, this instance's
  configuration, or the platform work it waits on; `MEND_TENANCY=multi` refuses to start while any
  is open and names each with its fix. `/health` reports whether the gate passes and which items are
  open, and `mend operator gate` shows the details.
- adba99f: Recovery without email. Owners hand a member a one-time password reset link from
  Settings; the operator lists organizations, renames them, invites or grants an owner, and issues
  reset links from `mend operator`. A reset link works once for a day, and setting a password with
  it signs the account out everywhere. Every operator act is recorded in the affected organization's
  audit log.
- 3843b11: Add organizations. Upgrading creates one organization that every existing account joins;
  the oldest account becomes its owner and the instance operator, and every existing project stays
  visible to everyone as a shared project. New projects are shared unless adopted as private, and
  project names are unique within an organization. Registration now closes after the first account:
  owners mint single-use invitation links instead, and an account that could not join an
  organization is deactivated. `MEND_TENANCY` defaults to `single`; `multi` is refused at start
  until the isolation work lands.
- a2cab8c: Give each account its own ssh-agent bridge, so a shared signer only ever signs for the
  account that shared it, and send session notifications only to the session owner's phones.
  Reference repositories belong to the organization: owners add, refresh and remove them with their
  own git access, and a project can select only its organization's references. Calls to the GitHub
  API use the host's `gh` login only for the operator of a single-organization install. Adding host
  mounts is refused in multi mode, and multi mode also refuses raw service listeners off loopback.
- 01ba33f: Enforce project visibility on every route. A project, session, worktree, change, process
  or Service the caller cannot see answers exactly like a missing one, and the check runs before any
  effect. Members see shared projects and their own private ones; project settings are for owners
  and the project's creator; removal is for owners, or the creator of a private project; only owners
  change visibility, and organization owners may stop any session they can see. Machine settings and
  the retired queue are the operator's, and adding host mounts needs the operator role. Live events
  are filtered to what each account can see, and one closing stream no longer silences the others.
- 0e5387b: Runs on Sealant 0.34.0, which bakes sealantd 0.17.0 (sealant-sh/sealantd#86): the
  workspace daemon dials the session channel and every presigned object URL over HTTPS with a
  verified certificate, and refuses to boot otherwise, unless the launch states that the network
  between executor and channel is private. Mend now sends that statement with every capture launch
  as `source.transport`, built from `MEND_EXECUTOR_NETWORK=private`, and hands the daemon the roots
  of a private CA from `MEND_SESSION_ENDPOINT_CA_FILE` (the channel) and `MEND_BLOB_STORE_CA_FILE`
  (the bucket). The packaged bundle states `private` itself, since its Compose network never leaves
  the host. The Helm chart refuses to render a plain-http session channel without
  `exposure.executorNetwork: private` or `sessionChannel.tls.enabled`, and takes the channel's CA
  through `sessionChannel.tls.ca`.

  Upgrade note for the chart: set one of those two values before `helm upgrade`, and roll this Mend
  before or with Sealant 0.34; a Mend older than this release does not send the statement, and its
  workspaces would refuse to boot under the new daemon.

  `@sealant/sdk` and `@sealant/api-contracts` move to 0.34.0, and the bundled server image pins the
  0.34.0 API, worker and ssh-gateway digests.

- 188cd59: A session's owner can turn on shared control, letting anyone who can see the session
  steer it on the owner's credentials; the owner or an organization owner can turn it off. Session
  detail says what the viewer may do (steer, stop, change shared control). Interrupts, terminal
  attaches, shell opens, stops and shared control changes are recorded per session with who did
  them, and shared control changes also go to the audit log. While control is shared, notifications
  also reach whoever sent the latest turn. Removing a member turns off shared control on their
  sessions first.
- 55d0b02: Under `MEND_SOURCE_POLICY=tenant`, git dials exactly the address the source policy
  checked, over HTTPS and ssh, so a name cannot resolve somewhere else between the check and the
  connection. The dotfiles clone at each launch is now checked and pinned too.
- 4e78243: Mend checks where its own git goes. Adoption, reference repositories, dotfiles and
  project refreshes are refused for the cloud metadata service and, except for the operator, this
  machine; `MEND_SOURCE_POLICY=tenant` also refuses private and reserved networks and `git://`
  unless `MEND_SOURCE_ALLOWED_HOSTS` allows them. A workspace's git transport now signs only against
  its project's own remote; `MEND_GIT_TRANSPORT_BIND_ORIGIN=false` restores the old behavior for a
  machine one person uses.
- 14c6486: Add upgrade tickets, so no long-lived bearer rides a URL. A WebSocket opened by a browser
  or the CLI cannot set a header, and neither can a WebView loading a page, so the terminal, service
  tunnel and key bridge sockets and the phone's terminal embed carried the session or device token
  as `?token=`, where every proxy on the way could log it. `POST /api/upgrade-tickets` now mints a
  ticket that is single use, lives thirty seconds, and opens exactly one target with exactly the
  parameters it was minted for; the socket routes take it as `?ticket=`. The CLI (`mend attach`,
  `mend service connect`, `mend keys share`), the desktop app, the phone and the embed page all use
  tickets, and the embed page keeps a renewal ticket in memory so a dropped terminal reconnects for
  up to twelve hours. A ticket is bound to the sign-in or paired device that minted it: signing out
  or revoking the device ends every ticket it minted. `MEND_URL_BEARERS=refuse` answers `?token=`
  with 400; the default, `accept`, keeps clients older than this release working and logs each use.
  A client newer than its server falls back to `?token=` only when the mint answers 404 and
  `/health` does not report `upgradeTickets`.
- 341a001: Capture uploads can no longer store more than they declared. Presigned PUT and part URLs
  sign the declared size, so an S3-compatible bucket refuses any other length; a multipart upload
  must complete with exactly the parts its size implies, and an object whose stored size differs
  from its declaration is removed and refused with `size-mismatch` at complete or register.
  `MEND_CAPTURE_REQUIRE_SIZES=true` also refuses keys sent without a size (today's sealantd sends
  sizes only for multipart keys).
- fb73d6f: Settings shows your organization: members with roles, owners' invitation links, folders
  with their files and uploads, projects a departed member left behind, and the audit log. Owners
  change roles, remove members (the page says what removal does first), take over a departed
  member's project, and page back through the audit log. Invitation links open a join page that
  creates the account; a signed-in account is told which organization it already belongs to. A
  removed account's browser is signed out and told why.
- 289f409: The web app shows each person only the controls they may use. A session page names whose
  credentials it runs on, lets its owner turn shared control on or off (an organization owner can
  turn it off), and shows the record instead of the terminal to someone who cannot steer. Menus, the
  Services card and "Send review to session" follow the same rules. Adoption asks who may see the
  new project, owners change a project's visibility in its setup, managers pick the organization
  folders its sessions mount, and setup sections a viewer cannot change are replaced by a note
  saying who can.

### Patch Changes

- Runs on Sealant 0.36.0 (sealant-sh/sealant#267, #268, #270, #271, #273, #275), which bakes
  sealantd 0.18.1. A session on a Lambda MicroVM now boots the image built from its project's
  blueprint, so the project's OS, base image and packages apply there as they do on Docker and
  Kubernetes. AWS's managed image build runs the recipe, under a role that can read one prefix of
  the artifacts bucket, so no recipe step runs on the control plane and a MicroVM deployment needs
  no Docker. One recipe is one image, reused by every session with that recipe, and Sealant's
  retention deletes the ones nothing uses. Nothing changes for a Docker or Kubernetes install.
  `deploy/docker/compose.aws.yaml` and `deploy/aws/tofu` move with it: Sealant's four one-image
  MicroVM settings are retired (0.36.0 refuses to start while one is set) in favour of a build role,
  an artifacts prefix and an image name prefix; the worker's role gains the image actions on that
  name prefix; and the build role loses its write access and its registry access. The server image
  carries the in-VM agent's files beside Sealant's worker, which checks for them at start.
  `@sealant/sdk` and `@sealant/api-contracts` move to 0.36.0, and the bundled server image pins the
  0.36.0 API, worker and ssh-gateway digests.
- Runs on Sealant 0.35.1 (sealant-sh/sealant#263), which bakes sealantd 0.18.0
  (sealant-sh/sealantd#91, #93). That daemon sets the remotes `plan.get` names, so a captured
  session's repository has its `origin` and `git push` and `git fetch` work inside a session again;
  it also sends the reply to a graceful shutdown before it exits. `@sealant/sdk` and
  `@sealant/api-contracts` move to 0.35.1, and the bundled server image pins the 0.35.1 API, worker
  and ssh-gateway digests.
- Runs on Sealant 0.35.0 (sealant-sh/sealant#259, #260). The platform stores a Claude credentials
  file as its `claudeAiOauth` grant alone, dropping the `mcpOAuth` refresh tokens beside it at
  connect and at sync-back, and a connected account now reports how fresh its credential is:
  `accessExpiresAt`, `refreshExpiresAt`, `lastRefreshAt` and `lastRefreshOutcome`. `@sealant/sdk`
  and `@sealant/api-contracts` move to 0.35.0, and the bundled server image pins the 0.35.0 API,
  worker and ssh-gateway digests.
- Install the `mend` helper and the git transport inside captured workspaces. A captured workspace
  mounts nothing, so the two scripts never arrived while git was configured to use them: `git push`
  and `git fetch` over ssh, and `mend service` commands, failed inside every session on a server
  using the capture store (the default since 0.27.0). The scripts are now written into the workspace
  at provisioning and reach the server over the session endpoint. A workspace where they cannot be
  installed is logged, no longer passed over.
- A captured session's repository has its `origin`. sealantd builds that repository itself, so it
  had no remotes and `git push origin` failed with "'origin' does not appear to be a git
  repository". `plan.get` now names the project's origin for sealantd to set
  (sealant-sh/sealantd#91); a password embedded in an adopted URL is dropped first, so no credential
  enters a workspace. It takes effect with the Sealant release that bakes that daemon; an older one
  ignores the field.
- A workspace's git transport recognises the project's own remote when it names a user. Git hands
  its ssh command `git@host`, and the origin binding compared that whole destination with the
  origin's host, so every push and fetch to an ssh origin was refused as "bound to" another host.
  The user is now set aside the way ssh reads it, after the last `@`.
- 6b0eb97: Allow only a session's owner to steer it, including terminal and Service tunnel access.
  Legacy sessions without an owner continue to use the first account as their owner.
- 2c05944: Runs on Sealant 0.33.1, which bakes sealantd 0.16.0 (sealant-sh/sealant#249). That is the
  daemon release Mend's capture channel now expects: every PUT URL the executor mints is bound to
  the length the PUT sends, which is what `MEND_CAPTURE_REQUIRE_SIZES=true` refuses uploads without,
  and `plan.get`'s `sources` are laid down beside the worktree, which is how a project's folders and
  reference repositories reach a captured workspace.

  `@sealant/sdk` and `@sealant/api-contracts` move to 0.33.1, and the bundled server image pins the
  0.33.1 API, worker and ssh-gateway digests.

## 0.28.0

### Minor Changes

- 6a2c50e: Redesign the dashboard with stacked project, worktree, and session navigation beside a
  larger read-only conversation preview. Keep browsing separate from explicit attach, resume, and
  new-session actions, guard duplicate launches and destructive confirmations, and show launch and
  branch lookup failures.

  Use Ayu Mirage backgrounds and accents with brighter text and independent pane-title colors.
  Support narrow terminals, sanitize recorded output, and preserve readable Unicode wrapping in the
  preview.

### Patch Changes

- 4f00a9c: Adopt Sealant 0.33.0 in the public SDK, bundled service images and AWS deployment
  templates. Pin the AWS workspace-image recipe to the same release and retain the platform's
  runtime-specific Docker errors.

  AWS workspace Docker remains opt-in and requires a separate Docker-capable image with matching
  configuration on API and worker. Updating Mend does not install Docker into retained workspaces or
  change a running AWS deployment. The matching `sealantctl` packaging requirement still applies.

## 0.27.5

### Patch Changes

- 11083ed: Prevent coding-agent transcript data from being lost when a capture executor is replaced,
  and show when ended sessions without an observed transcript are omitted from a project's visible
  count.

## 0.27.4

### Patch Changes

- 5ece5a6: The capture store's byte quota is checked before bytes land, and is sized for captured
  dependency trees. `upload.urls` refuses a batch whose declared sizes would take the session past
  its quota with 413 `{reason: "byte-quota", limit, used, requested}` before any URL is minted; a
  key is priced once (reserved at its declared size, settled at the size the bucket reports when a
  register names it), so re-listed packs and retried batches cost nothing again. `capture.register`
  keeps the check as the backstop for keys uploaded without a size and answers 409 with the same
  body — a refusal of that capture, not a transport failure to retry. The floor rises from 512 MiB
  to 8 GiB per session (`MEND_CAPTURE_BYTE_QUOTA_FLOOR`; chart `captureStore.byteQuotaFloorBytes`),
  above which the 4× footprint rule still applies: on the cluster the first bulk capture of a
  Mend-size `node_modules` (775 MB, 134,103 files) was uploaded in full and then refused at
  register, and the executor retried it every 5 s.
- 1467699: The bundle pins Sealant platform 0.31.2 by digest and the SDK moves to 0.31.2; the
  workspace image carries sealantd 0.15.2. A capture-mode session's flush survives load: the
  daemon's orphan reaper was reaping the capture engine's own `git` children, so `capture.flush` was
  refused with `No child process` for 4% of flushes on a quiet machine and a third of them under an
  orphan storm — the failure that took down Mend's own v0.27.3 packaged acceptance on amd64. A
  capture the control plane refuses on the byte quota is now terminal: the shipper acks the 413 and
  stages over it, where it used to re-attempt the same register every five seconds for the life of
  the session. On Kubernetes a workspace pod's exit is observed from the runtime, so a dead executor
  is seen in seconds instead of reading `ready`, and `stop` on a pod that is already gone returns at
  once — the cluster proof spent most of its 122 s to declare an executor lost inside that wait.
  MicroVM launch material is published whole.

## 0.27.3

### Patch Changes

- 82bad9d: Capture mode, after the first cluster session on a Garage bucket:
  - The capture routes ask the bucket only about capture objects. `capture.register` refuses a
    manifest naming a key that is not `…/packs/<sha256>`, `…/trees/<sha256>` or
    `…/manifests/<sha256>` before any HEAD; `upload.urls` and `upload.complete` drop or refuse such
    keys; a plan presigns object keys alone. Every bucket failure inside a route now names the key.
  - Mend verifies a capture's git section itself (`index-pack --verify` plus
    `git rev-list --objects --missing=error` over the refs it names, on the runner) and records the
    outcome in `captures.git_fsck` — `checkpoint`, `turn`, `suspend` and `final` at register, `auto`
    at the first plan that would restore it. A capture whose pack omits a tree it names is accepted
    and marked `failed`; `plan.get` answers the same head with the git section of the newest capture
    that verifies (ADR-0002 16), and reads come from that capture, stamped.
  - The `upload.urls` request quota counts calls, not presigned URLs: 600 calls per session per
    rolling hour, at most 1,000 keys per call (the daemon batches 500). The old 2,000-URL quota
    refused the first bulk capture of any repository with more than a couple of thousand dir
    objects; bytes stay bounded at register (4× the project's footprint).
  - `review prep` logs a change git cannot read with git's command and stderr, the worktree and the
    chain head's verification state, instead of `Cause([Fail(GitError)])`; the passes are simply not
    queued.
  - `scripts/capture-e2e.sh` kills the executor with SIGKILL explicitly and `docs/KUBERNETES.md`
    states the distinction: a graceful `kubectl delete pod` is a planned stop (`final` capture,
    session `completed`); only a forced delete takes the `executor lost · lease expired` pickup
    path.

- 2c9df83: The bundle pins Sealant platform 0.31.1 by digest and the SDK moves to 0.31.1; the
  workspace image carries sealantd 0.15.1, the daemon with the fixes from the first capture-mode
  session on a cluster. Tracked files win over `.gitignore`: the materialiser keeps `.git/index`
  across its sweep, so a tracked file matching an ignore pattern (`tooling/typescript/core.json`
  under `core.*`) no longer vanishes from the next worktree tree. Stored tips are seeded from refs
  alone, so a pack after boot or replan carries every subtree the replacement executor needs instead
  of a negative it never received. Packs and staging survive a long ship: an unchanged snap discards
  only objects no queued capture still lists, a coalesced capture keeps the other class's dir
  objects, and the shipper mints upload URLs 500 keys per call, matching Mend's per-call quota.

## 0.27.2

### Patch Changes

- 4eee050: The packaged acceptance proves the recorded change from the capture store. Under captures
  the session's branch and worktree live on the executor's own disk and its commits reach Mend as
  captures in the bucket and Postgres, so the old
  `git --git-dir=<store>/repo.git rev-parse <branch>` inside the Mend container answered "unknown
  revision" and failed the v0.27.1 release run. The stage now reads the worktree's checkpoint chain
  and a Review slice whose base-to-checkpoint patch the git runner serves from packs, through the
  public API, and every lifecycle stage (setup rerun, restart, stop/start, upgrade) checks that
  chain and patch survive unchanged. The store volume and the executor's disk are never inspected.

## 0.27.1

### Patch Changes

- e1ebb78: The packaged-server acceptance catches up with captures everywhere (decision 8):
  `mend-garage` is the third external, ownership-labelled volume, the way `mend server setup` claims
  it — v0.27.0's release run refused the volume as unproven and leaked it at cleanup — and the
  session stage no longer looks for a workspace that mounts the store. A capture executor mounts
  nothing from `mend-store` (a store mount is now the failure), the session's change is observed
  from a registered capture (n ≥ 1), and the engine's `capture flush · completed · observed` report
  is required when the run ends. The CLI's setup, upgrade and start carry regression tests for the
  bucket's volume: a fresh install labels all three, an upgrade from a generation without Garage
  claims it under the unchanged identity, and a foreign `mend-garage` is refused with the same
  message as a foreign store or control volume. Capture mode's checkpoints have one writer per
  worktree: the engine serialises a worktree's checkpoints behind a per-worktree permit (the
  advisory lock is bypassed under captures), and the `checkpoints` insert is
  `ON CONFLICT DO NOTHING` — a taken ordinal answers with the row that stands when it records the
  same snapshot, else re-reads the chain and takes the next ordinal. Before this a user mark during
  the run-end checkpoint answered 500 (`checkpoints_worktree_ordinal_idx`, observed in v0.27.0's
  acceptance run).

## 0.27.0

### Minor Changes

- ebbe040: Sessions run on the capture store by default (`MEND_SESSION_STORE=captured`): a session's
  work product is a chain of captures in a bucket, and the executor that made it is disposable. The
  Docker bundle (`mend server setup`) ships Garage as that bucket, single-node on its own
  ownership-labelled volume `mend-garage`, laid out once at setup; an install from before the
  capture store is upgraded in place, and a worktree made before captures is backfilled from its
  files at first launch. Projects gain an install command and a per-project dependency cache, so a
  fresh executor restores `node_modules` and its kin instead of installing them again. The review
  header names the capture the bytes were observed at. The bundle pins Sealant platform 0.31.0 by
  digest, which carries the `capture` workspace source, the Compose-network attach for workspace
  containers, runtime-observed exits and `capture.flush`/`capture.replan`, with sealantd 0.15.0
  inside the workspace image.

## 0.26.0

### Minor Changes

- 8db9e9d: First contact is now a three-step setup instead of a bare sign-in form. The web app asks
  the instance whether any account exists (`GET /api/instance`, public): a fresh install opens on
  registration and says so; one with accounts opens on sign-in. Registration asks for the password
  twice, with a reveal on both fields, and continues to a second step (`/welcome`) that asks how the
  account reaches its repositories — the Mend key is created before that page paints and shown with
  where to add it, or the machine's ssh-agent bridge is chosen instead. The key's comment is now the
  account's email rather than `mend@<host>`; existing keys are relabeled in place on the next
  signed-in read (same key material, same fingerprint). The first-run checklist observes what it
  used to guess: the CLI's sign-in (its token is a device of platform `cli`), connected accounts
  (with the platform's own failure when it cannot be reached), paired phones, and git access — and
  every observation updates live over the event stream when `mend login`, `mend connect`,
  `mend pair` or `mend keys init` runs in a terminal, instead of waiting for a reload.
- 29b87fb: `mend uninstall` removes what Mend put on a machine. It asks for a scope when none is
  given: everything, the server only, or this machine's files only (`--all`, `--server`, `--home`;
  `--yes` skips the confirmation). The plan is printed before anything goes, and the server scope
  requires typing `delete`: it takes the Compose installation down with its volumes, removes the
  external store and control volumes only when their ownership label matches this installation,
  untags the release image, and deletes the private configuration's identity, generations and
  backups. The home scope revokes this terminal's device token first, then removes `cli.json`, the
  workspace SSH key and the managed `~/.ssh/config` block. Files Mend did not create are listed and
  kept; workspace containers are named with the command that removes them, never removed.

## 0.25.0

### Minor Changes

- 51c2742: The self-hosted server bundle no longer ships RabbitMQ or a workspace-image registry. It
  pins Sealant 0.29.0, which runs its job queue in Postgres and keeps workspace images in the host
  Docker Engine, so the Mend container now supervises only Mend and the Sealant API, worker and SSH
  gateway. Idle memory drops accordingly. The bundle asset contract moves to v2 (`compose.v2.yaml`,
  `setup-contract.v2.json`): no registry port is published, `--registry-port` is gone from
  `mend server setup`, and setup, start, restart and upgrade no longer run the loopback registry
  round-trip. Existing v1 installations upgrade in place with
  `mend server upgrade --version <target>`; their volume-ownership identity is carried over
  unchanged.

  The Mend API server and web front now run from esbuild bundles inside the images (no
  `node_modules`, no type stripping at start), which also drops code the server never calls, such as
  the OpenAPI viewers Effect re-exports.

## 0.24.2

### Patch Changes

- 8780acb: The dashboard no longer bounces on Enter while a session's workspace is still booting. A
  `starting` row has no terminal to attach yet, so Enter now leaves the dashboard up and says so,
  instead of suspending the screen once per keystroke and returning. A worktree header attaches its
  newest live member that is past starting.

## 0.24.1

### Patch Changes

- 106a49c: `mend server setup`, `start`, `restart` and `upgrade` now announce each slow phase before
  it starts: resolving the release, downloading assets, pulling images, starting containers and
  waiting for health. Image pulls show Docker's own progress on the terminal instead of running
  silently, so a first setup no longer looks frozen for the minutes a pull takes.

## 0.24.0

### Minor Changes

- f02a7ae: Redesign the web workbench around projects, worktrees, and their sessions. Add list and
  card views, compact project/worktree selection when starting a session, consistent page widths and
  setup cards, and a project setting to inherit or exclude global skills.

## 0.23.0

### Minor Changes

- e54c03d: Package Mend, the pinned Sealant runtime, RabbitMQ, and the workspace registry in one
  application image. Keep Postgres separate, preserve application data and SSH identity in named
  volumes, and supervise the application processes as one restartable unit.
- 13999dd: Use `APP_URL` and explicit `MEND_ALLOWED_ORIGINS` for authentication, credentialed CORS,
  pairing, and advertised addresses. Enforce the policy on unsafe cookie-authenticated requests and
  WebSocket upgrades, including the web proxy. Pairing clients honor the server's configured
  addresses. Stop trusting discovered container interfaces and forwarded host headers. Pin the
  Sealant SDK and API contracts to 0.28.0 for the upcoming container bundle.
- 95e3992: Support remote workspace SSH with per-server aliases, effective OpenSSH configuration
  checks, and usable client-key validation. Keep host-key trust explicit and leave unrelated SSH
  configuration intact.

  Adopt repositories by network Git URL only. Reject local paths, option-like sources, and Git
  remote helpers while preserving cwd project selection and session worktrees. Bundle the CLI's
  private workspace dependencies so its npm tarball works outside the monorepo.

- 867ee9d: Add server status, bounded logs, start, stop, restart, and explicit version upgrades.
  Verify installation ownership before operations. Validate target artifacts before stopping writers
  and save a private streamed database backup before activation. Retain the target pin and recovery
  files after possible migrations, with no automatic downgrade or database restore. Bound
  subprocesses and recover pre-startup failures without replacing identity or deleting volumes.
- a2acca0: Install only the CLI through npm or the POSIX bootstrap. Add explicit Docker server setup
  with exact version pins, private configuration generations, persistent identity, daemon volume
  ownership checks, and a real Engine registry roundtrip. Validate release assets and image versions
  before activation. Support explicit private origins, configurable ports, local release assets, and
  offline setup.

## 0.22.0

### Minor Changes

- 0ce748d: Docker inside workspaces on Kubernetes. Mend pins Sealant 0.27.0, which serves the
  workspace Docker switch on Kubernetes deployments whose operator enabled `workspaces.docker` (a
  rootless daemon beside the workspace, in a user-namespaced Pod). Where the deployment cannot serve
  it, the platform refuses at create and the session now shows that refusal in one sentence, naming
  the two ways out, instead of a launch failure minutes later. Platform error codes Mend branches on
  are read from the error body again (the SDK reports the error's tag as its code), which also makes
  the cluster-bindings refusal match the real platform.

## 0.21.1

### Patch Changes

- 2baf887: A new conversation inside an existing worktree (⇧S "session here" in the dashboard, the
  web's new session in a worktree, `POST /worktrees/:id/sessions`) now claims a ready standby
  skeleton like every other launch, instead of always creating a fresh workspace. A standby skeleton
  serves any worktree since 0.18.0; this path had simply been left on the cold road.
- 70a69e5: The Mend key's private half is pinned to mode 0600 on every use, not only when it is
  created. On Kubernetes the volume's fsGroup policy adds group read/write to every file at pod
  start, ssh then refuses the key ("UNPROTECTED PRIVATE KEY FILE"), and every mend-key fetch and
  push, host-side and through the workspace shim, failed with "Permission denied (publickey)".

## 0.21.0

### Minor Changes

- 5d9dd24: Git access is now a per-user choice, asked once on first run and kept in Settings: a Mend
  key of your own on the server (recommended; add it to your git account's SSH keys and every
  repository works, from detached sessions and the phone too, or add it as one repository's deploy
  key), or your own machine's key through the bridge. New projects adopt with your choice; a
  project's setup page still overrides it. `mend keys mode [mend-key|bridge]` sets it from the CLI.

  The Mend key is per user, not per server. A server-wide key from before is claimed by the first
  user who asks, so a public key already on your git host keeps working.

  When your choice is bridge, every attaching `mend` command (codex, claude, opencode, run, attach,
  shell, resume, rejoin) and the dashboard share this machine's ssh-agent for as long as they run,
  and the dashboard header says "agent shared". Projects then fetch their base before a worktree is
  created instead of silently starting on whatever the store last fetched. `mend keys share` still
  runs the relay in the foreground on a machine without one.

### Patch Changes

- 884f34f: Ctrl+V (image paste) and Ctrl+] (detach) in an attached terminal are now recognised in
  every form the kitty keyboard protocol can send them. Codex asks the terminal to report all keys
  as escape codes, and under that flag the lock modifiers ride along: with Num Lock on, Ctrl+V
  arrived as `ESC[118;133u` instead of `ESC[118;5u`, slipped past the matcher, and reached codex's
  own clipboard handler inside the workspace, which has no display and failed with an X11 error. The
  matcher now parses the report (key code, modifiers, event type) and masks the lock bits.

## 0.20.0

### Minor Changes

- 9972147: Ctrl+V in an attached terminal (`mend codex`, `mend claude`, `mend attach`, the
  dashboard) now pastes an image from this machine's clipboard into the session: the CLI reads the
  clipboard (wl-paste on Wayland, xclip on X11, osascript on macOS), stores the image beside the
  session, and pastes its workspace path, which codex and claude read as an attachment. Before, the
  keystroke reached the agent's own clipboard handler inside the workspace, which has no display,
  and failed with an X11 error. With no image on the clipboard the keystroke goes through untouched.

  The dashboard now renders every worktree as a header with its sessions indented underneath, one
  session or many. A worktree with a single session used to collapse into one row that carried the
  worktree's name, so ⇧D on it read as "remove the worktree" while it removed the session.

- 9972147: The dashboard hides settled sessions that never had a conversation — no transcript
  captured at settle, none in the harness home — since there is nothing to resume or hand off;
  `mend sessions --all` still lists them. Mend now records that fact once at settle (and classifies
  older sessions once at boot). ⇧D on a session row removes that session and leaves the worktree; a
  session killed a moment ago removes without a second stop, since the server closes its shells and
  settles it on the way out. ⇧D on a worktree header still removes the worktree.

## 0.19.0

### Minor Changes

- ff25c3c: The dashboard hides settled sessions that never had a conversation — no transcript
  captured at settle, none in the harness home — since there is nothing to resume or hand off;
  `mend sessions --all` still lists them. Mend now records that fact once at settle (and classifies
  older sessions once at boot). ⇧D on a session row removes that session and leaves the worktree; a
  session killed a moment ago removes without a second stop, since the server closes its shells and
  settles it on the way out. ⇧D on a worktree header still removes the worktree.

## 0.18.0

### Minor Changes

- a228468: The CLI explains itself. `mend help` is an index again: one line per command, grouped
  into start, sessions, services, project setup, and this machine, aligned in two columns at your
  terminal's width. Every command now has its own page, `mend help <command>` or
  `mend <command> --help`, with usage, a description, options, examples, and see-also;
  `mend help service` lists a family. Usage errors quote the same synopsis. The same pages ship as
  man pages: `man mend` and `man mend-<command>` after a global install, or `mend man <command>`
  from anywhere. Every description was rewritten to say what the command does in plain words.

  `mend version` (also `--version`, `-v`) prints this CLI's version, then the server's when it
  answers within two seconds, and states a mismatch as a fact.

- 62e947a: Linked projects. A project's setup page gains a "Linked projects" section: pick another
  adopted project and a name, and every next session of this project works in that project too,
  read-write, at `/workspace/repos/<name>`. The linked project's named worktree is bound at launch
  (blank picks, creating it if needed, the worktree named after its default branch); commits there
  are that project's own change, reviewed on its side, never part of this session's change. Distinct
  from references, which are read-only clones for reading, and from mounted folders, which are host
  paths and so cannot exist on a cluster. Linking rewarms the hot pool.
- d9e397e: Hot sessions are standby workspaces. A pooled workspace no longer pre-creates a worktree:
  it mounts the project's worktrees directory and the session that claims it binds its own worktree
  at launch, so the pool now serves a named join into an existing worktree as well as a brand-new
  one, and a skeleton never spends a worktree or a worktree row ahead of time. Every session's
  workspace is created this way (Sealant 0.26, sealantd 0.13), which is also what lets a project
  mount sibling repositories next. Migration 0048 relaxes the pool's worktree columns.

## 0.17.0

### Minor Changes

- 2227524: Paste an image into a session's terminal. Ctrl+V inside claude or codex reads the
  clipboard of the machine the TUI runs on — the workspace container, which has none — so pasting a
  screenshot did nothing anywhere in Mend. Now an image pasted or dropped onto the terminal (web,
  desktop) or the new `img` key on the phone's key bar goes to `POST /sessions/:id/images`: Mend
  stores the bytes in the session's durable harness home (mounted read-write into every workspace
  the session gets, never inside the worktree, so nothing touches the change or the checkpoints) and
  the terminal pastes the workspace path — which codex attaches as an image input and claude reads.
  PNG, JPEG, GIF, and WebP up to 8 MB; the format is sniffed from the bytes.

### Patch Changes

- 8bff8b1: Take a session over from a phone pickup. When a session is live in protocol mode (handed
  off to the phone), `mend attach` and the dashboard's attach now hand it back to a terminal — end
  the protocol agent, resume the same conversation as a TUI, and attach — instead of failing with
  "tty attach unavailable" or dropping you into a bare bash shell. `mend rejoin` already did this;
  the two most natural "get me in" entrypoints now match it.

## 0.16.0

### Minor Changes

- bef9f10: `mend skills` — skill libraries on the server. `mend skills push` scans
  `~/.agents/skills` (the shared agent-skills convention; `--dir` overrides) and uploads every
  bundle to your library, or a project's with `--project`; `--prune` removes server-side skills the
  directory no longer carries. `mend skills` lists a library. Sessions receive the merged libraries
  in their harness home at launch — claude and codex both discover them natively; a same-named
  project skill overrides a personal one.

## 0.15.2

### Patch Changes

- 0688777: Ambient-mode remote git operations now use `StrictHostKeyChecking=accept-new`, matching
  mend-key and bridge: a daemon has no terminal to answer a first-contact host-key prompt, so a
  server with an empty known_hosts (a fresh pod) could never reach any remote. A changed host key
  still refuses, and the failure message now names that one remaining case.
- 0688777: Worktree creation in the dashboard is one floating, fixed-size modal: name, base, and
  harness all visible at once — enter or tab advances (shift+tab and esc step back; esc cancels from
  the name), nothing shifts as focus moves. The base step is a fuzzy finder over the project's
  branches, prefilled with the branch checked out where `mend` ran when creating in that project; a
  name that joins an existing worktree shows the base as fixed. Running `mend` inside a repo the
  store doesn't know raises an adopt offer: the origin URL (or local path, honestly labeled) with an
  arrow-key auth-mode toggle — ambient, mend-key, or bridge.

## 0.15.1

### Patch Changes

- f4a6f5e: Entering a session whose agent terminal has ended now rejoins the shell already holding
  the workspace instead of opening a fresh bash per attempt — the failure mode where Ctrl+C out of
  an agent left a session held open by a stack of orphan shells. Stops and worktree removals in the
  dashboard paint optimistically: the row settles (its live process and service fact lines drop with
  it) or leaves the list before the server answers, and an error refetches truth.

## 0.15.0

### Minor Changes

- be4ece9: The worktree becomes the durable container: sessions are conversations inside it — many
  per worktree, several live at once — with one change and one checkpoint chain per worktree.
  Launching with an existing worktree name joins it (`--worktree` joins only); `s` in the dashboard
  starts a session inside the selected worktree, Shift+D is the one explicit removal (refused while
  anything is live), and deleting a session leaves the worktree, its change, and its checkpoints
  standing. `mend worktrees` lists containers with their sessions; `mend sessions --json` stays
  byte-stable v1, `--json=v2` emits the worktree envelope. Migration 0046 re-keys existing data
  one-worktree-per-session; review slices may now span checkpoints from different conversations of
  one worktree.

### Patch Changes

- fc9ea8e: The dashboard shows what actually lives in each worktree: live agent and shell processes
  hang under their worktree row beside the Services, and unnamed worktrees are called by their
  auto-name label (or short session id) instead of the `session/<uuid>` branch noise. The attach and
  rejoin banners use the same name.

## 0.14.0

### Minor Changes

- 0a90f6f: The dashboard groups everything by worktree: each session row leads with its worktree
  (branch), its live Services hang underneath, and the detail panel is titled by the worktree. A
  stop shortcut lands too — `x` (or `Shift+K`) arms against the selected worktree and a second press
  stops it; lowercase `k` stays vim-up. `mend attach`/`mend rejoin` banners name the worktree as
  well.
- 0a90f6f: The start-a-session flow asks the worktree's name first, then the session details — on
  the dashboard (`n` opens the name input, then the harness picker), the CLI (`mend claude` asks on
  a TTY; `--name` skips the ask), the web and desktop composers, and the phone. A named session gets
  branch `mend/<name>` and worktree directory `<name>`; empty keeps the auto-derived identity. Named
  sessions provision cold (hot skeletons carry pre-created worktrees), and a taken name fails with a
  readable message.

### Patch Changes

- 3204a33: Detach works — and leaves a working terminal — while talking to claude. The claude TUI
  pushes the kitty keyboard protocol through the PTY onto the user's own terminal: Ctrl+] then
  arrives as a CSI-u escape instead of the 0x1d byte the attach loop scanned for (detach silently
  dead), and after any detach the terminal kept encoding every keystroke as CSI-u junk. The detach
  key now matches both encodings, and ending an interactive attach restores the local terminal (pops
  the kitty keyboard stack, disables bracketed paste and mouse reporting, leaves the alternate
  screen, shows the cursor). Reattach replays from 0, which re-establishes whatever the TUI had set.

## 0.13.0

### Minor Changes

- df25891: Background sessions: launches take `--detach`/`-d` (start without attaching) and
  `--foreground` (the session stops when this CLI exits), governed by the new background-sessions
  switch in Settings with a per-project override. New `mend stop <prefix> | --all` ends a session
  explicitly — inside the workspace too, via the staged helper. Attach now tells a dropped
  connection apart from a settled session (no more "session ended" on a network cut), and
  SIGHUP/SIGTERM restore the terminal cleanly instead of leaving raw mode pushed.

## 0.12.2

### Patch Changes

- 559b1cf: The agent bridge reconnects after a server restart on shared storage. A dead pod's socket
  file on an NFS-backed mount answers `lstat` with EINVAL, and the bridge's cleanup (`rmSync`, which
  stats first) threw that at every attach — `mend keys share` could never reconnect after a pod swap
  until someone removed the file by hand. Cleanup now unlinks without statting; anything the
  filesystem still refuses is left for `listen` to report loudly.

## 0.12.1

### Patch Changes

- fdb8ca5: The branches and refresh endpoints answer instead of 400ing. Their handlers returned
  plain objects where the contract's `ProjectBranch` is a class schema — the work succeeded (the
  fetch ran) and then response encoding refused the body, starving the composer's branch picker and
  `mend refresh` alike. Handlers now construct instances, and a contract test pins the invariant:
  class schemas encode instances only, shape-alikes compile and then fail at runtime.

## 0.12.0

### Minor Changes

- 7652f22: Sessions carry their base branch, visibly and currently. A session records the base as
  you named it (`baseRef`) beside the pinned commit, and every surface shows it: the sessions table
  and dashboard, the web lists, session page and review header, and the mobile session screen. The
  web composer and the mobile start rows pick a base from the project's real branches instead of a
  blind text field. Bases are current, not adoption-day stale: provisioning freshens the base ref
  from origin through the project's git auth (best-effort — offline or signer-less still provisions
  on what the store has), and `mend refresh [project]` (`POST /projects/:id/refresh`) fetches every
  origin branch into the store on demand. Nothing is ever pruned; session branches are untouched.

### Patch Changes

- 482be61: External agents stay visible whatever their harness does to file modes. Workspaces run as
  root and codex tightens its state to 0700, which blinded the store-side observer (uid 1000) — a
  codex run in a workspace terminal never appeared. The relocate boot script now keeps the harness
  home group/other-readable (a detached root mode-keeper loop), the observer warns instead of going
  silently blind, and a conversation that went quiet before mend could see it is late-observed: the
  row appears already-ended and the conversation is captured into the record.
- b764702: Project stores defend themselves against root-side git. Workspace containers run git as
  root against the store's shared gitdir, and a root `git gc --auto` could leave the ref database
  root-owned — locking the server (uid 1000) out of creating session refs, failing every new session
  on the project. Stores now run `core.sharedRepository=group` with setgid group-writable trees:
  applied at adoption, healed into existing stores on the next worktree create, and applied to each
  session's worktree gitdir (where checkpoints write). A store already poisoned by an earlier root
  write still needs a one-off root `chown -R 1000:1000` — only root can reclaim root's files.

## 0.11.0

### Minor Changes

- 9a6567a: Harness state is durable by construction: every session mounts a store-backed harness
  home into its workspace, and boot symlinks each harness's `$HOME` state dirs (`.claude`, `.codex`,
  `.local/share/opencode`) onto it. A workspace that dies without settling no longer loses the
  conversation — relaunch commits a capture from the live harness home and resumes natively instead
  of failing with "Saved harness state is missing". The mounted home is also the server-side seam
  for upcoming skills management.
- 19da134: Agents run by hand — in a mend shell, an SSH session, an editor terminal — become
  first-class: their transcript writes through the mounted harness home are observed server-side and
  surfaced as `agent-external` process rows ("claude (observed)"). The session reads as running, the
  workspace lease holds while the agent works, and the conversation is harvested and natively
  resumable like any engine-launched agent's. The row ends when the writes go quiet (five minutes) —
  but quiet is an inference, not an exit: the workspace is never reaped on it, and the next write
  revives the session with a fresh observed row. Mend observes, it does not own the process.
- 6487570: Workspace SSH sets itself up. `mend ssh` shows the observed state (gateway, registered
  keys, ssh config); `mend ssh setup` makes a machine ready once — it prefers the running
  ssh-agent's key so no new key material is created, registers it under the signed-in user, and
  writes one managed `Host mend-ws` block. The VS Code extension discovers the gateway through the
  server and offers the same setup as a single dialog on first open; the manual gateway settings
  become overrides.

## 0.10.1

### Patch Changes

- a421d71: Two protocol-session fixes, both diagnosed live on a Kubernetes deployment:
  - Claude sessions no longer show every assistant message twice. The stream-json CLI echoes each
    completed content block as its own `assistant` event whose content array holds just that block;
    the adapter keyed those echoes by array position (always 0), so with a thinking block at stream
    index 0 the completed text landed on the thinking block's item while the streamed deltas had
    already built the same text under its real id. The adapter now recovers the true stream index by
    counting consumed blocks per provider message id.
  - Resuming (or following up on) a stopped protocol session onto a fresh workspace now restores the
    harvested harness state before the harness starts. `launchProtocol` passed an explicit null
    state to `launchInternal` — the contract that skips both the read and the restore — while the
    composed argv still resumed by provider id, so `claude --resume` exited with "No conversation
    found". Deployments that reuse a retained workspace never saw this; fresh-workspace relaunches
    (Kubernetes, stopped workspaces) always did.

## 0.10.0

### Minor Changes

- 5930a45: `mend login` signs in through the browser instead of asking for a password. The CLI opens
  an authorize request against the server, points the browser at `<server>/authorize?code=…`, and
  polls until you press Authorize there. Approval mints a revocable device token, the same kind a
  paired phone holds. It shows up under Settings → Devices and replaces the old expiring session
  token, so the CLI no longer signs itself out when a browser session would have lapsed. A server
  that is already configured (`--url`, `MEND_URL`, or the config file) is used without asking; only
  a fresh machine with nothing set prompts for the URL, and Enter accepts the default. `--email` and
  the terminal password prompt are gone. `mend logout` now revokes the device server-side before
  forgetting the token locally.
- 8e71837: `mend service run` reaches the Service in one step. On a local server nothing changes:
  the command starts the Service and returns, and the bound endpoint already answers on this
  machine. On a remote server (a VPS, a Kubernetes Pod) the CLI now keeps running and tunnels the
  Service's port to `127.0.0.1` here — the same authenticated WebSocket `mend service connect` opens
  — instead of printing a suggestion to run a second command. Ctrl-C closes the tunnel, never the
  Service. `--no-connect` restores start-and-return. UDP Services are unchanged (no connection to
  tunnel).

  The server side of the tunnel is now authorized as well as authenticated: `/api/service-tunnel`
  refuses callers who are not the Service's session owner with 403.

- 00c683a: The dashboard is a drawn multi-pane workbench: projects and sessions panes side by side,
  a session detail panel beneath them, and the harness picker as a panel in the detail slot — no
  painted background, the terminal's own ground shows through, and chrome is near-mono with color
  only where it states a fact. Async state moved to optimistic mutations: starting or resuming a
  session puts a `starting` row in the list at the keystroke and leaves the keyboard free while the
  workspace provisions, renames land immediately, and review comment triage never waits on a round
  trip. The event stream is now parsed properly — heartbeats and per-record-line progress no longer
  refetch the workbench, so an idle dashboard makes no requests.

## 0.9.0

### Minor Changes

- eb2d1e3: Cluster bindings: a project can declare name-only references to Kubernetes Secrets and
  ConfigMaps (`mend env cluster add secret|configmap <name>`, `remove <kind>/<name>`) and a
  workspace ServiceAccount (`mend env cluster sa <name>` / `sa --clear`); `mend env show` lists them
  as a third section beside Configuration and Secrets. On a Kubernetes deployment the platform
  resolves the names inside the workspace at launch — Mend stores and forwards names, never the
  bound contents. Each session run records the binding names, revision, and service account it
  launched with; a binding or ServiceAccount change drains warm skeletons the same way an env or
  secret edit does. On a deployment that cannot resolve them, launch refuses readably, naming each
  binding, before any workspace is created (requires the platform SDK 0.24.0 surface). Also in this
  release: SessionRepository, the identity-keyed authority for session workspaces.

## 0.8.0

### Minor Changes

- d398efd: The server is now two processes: the Mend API server (`apps/api` — the typed contract,
  auth, the WebSocket data planes, the session engine, and the workers; port 3101,
  `MEND_MODE=all|api|worker`) and a stateless web server (`apps/web` — the TanStack app plus a
  transparent `/api` proxy carrying HTTP, SSE, and WebSocket upgrades; port 3105). Clients keep one
  origin and need no changes. The single-host installer and Docker image supervise both via
  `scripts/serve.mjs`; on Kubernetes the chart deploys them as separate tiers, and the web tier can
  be replicated.

## 0.7.1

### Patch Changes

- 0759bbf: Platform SDK 0.23.0: session attach, SSE output streams, and workspace port forwards now
  carry the owner assertion alongside a service key (Kubernetes deployments authenticate this way —
  attach and Service tunnels were rejected without it), and `workspaces.create` no longer pins the
  runtime family to Docker, so the deployment's default runtime decides.

## 0.7.0

### Minor Changes

- 5e1f3ce: `mend service connect [name…] [--port <n>]` brings live Services to THIS machine's
  loopback: each connection tunnels over one authenticated WebSocket to the server, which pumps it
  into the same workspace forward the server-side listener uses — works identically whether the
  server is your laptop, a VPS, or a Kubernetes Pod. Service status lines now lead with what your
  terminal can actually use (the tunnel on a remote server, the bind authority only on a local one),
  and Enter on an idle session in the dashboard opens a fresh shell in the held workspace instead of
  failing with "attach unavailable".

## 0.6.0

### Minor Changes

- 3f1eea2: Onboarding: `mend pair` prints a QR (and an eight-character code) that pairs a phone with
  this machine — the phone gets its own revocable device token, listed and revoked under Settings →
  Devices. `mend doctor` is a read-only checklist: server, sign-in, connected accounts, adopted
  projects, local harness CLIs, tailnet address — each failing line names the command that fixes it.
  `mend help` now opens with the getting-started sequence. A hidden `mend qr <text>` backs the
  installer's closing QR.
- e63ac2f: Each Mend user is their own Sealant user. Mend now authenticates to the control plane as
  a service principal (`SEALANT_SERVICE_KEY`; `SEALANT_OWNER_USER_ID` is gone) and provisions one
  Sealant user per account on first use, so sessions, records and model calls are attributed to the
  person who made them and run on that person's own connected accounts.
  - `mend connect claude|codex|github [--from-stdin] [--remove]` sends this machine's credential
    (the file the provider's CLI wrote at login, or a pasted one) to the platform under your own
    user; `mend accounts` lists what is connected. The Sealant web app is no longer needed.
  - Settings → Connected accounts does the same on web and desktop.
  - A hot-pool skeleton is claimed only by sessions of the user it was warmed for.

  Requires a control plane with service principals (`SEALANT_SERVICE_KEYS`, `POST /v1/users`).

## 0.5.0

### Minor Changes

- d60fc4b: Start a session with a prompt: `mend claude "fix the auth test"` opens the harness with
  the quoted prompt as its first message, and the session is named from it immediately instead of
  after the 45-second transcript poll. New flags on `mend claude|codex|opencode`: `--model <id>` and
  `--effort low|medium|high|xhigh|max` map to the harness's own model and reasoning flags,
  `--base <ref>` bases the worktree on a branch or sha, `--ask` restores the harness's permission
  prompts instead of the default bypass, and `--fast` requests priority processing (codex
  `service_tier=priority` — 1.5x speed at increased usage). The server composes the harness argv
  from the structured start, so the same launch path backs the web composer. Bare `mend claude` and
  `mend run -- <command...>` are unchanged.
- 196b2c7: Protocol-mode agent sessions: launch codex or claude as a structured byte protocol
  (`codex app-server`, claude stream-json) instead of a PTY. The conversation becomes rows Mend owns
  — authored turns, streamed items, and agent requests (approvals, questions) that block until a
  person answers — with new session endpoints to submit and interrupt turns, list items and requests
  by cursor, and respond to a pending request. A session with a live protocol agent reads `waiting`
  while a request is pending. PTY launches are unchanged and remain the default; protocol mode
  requires a workspace image with sealantd ≥ 0.11.

### Patch Changes

- 06beffc: The CLI now resolves the cwd's project the way you expect: a project adopted from GitHub
  matches any clone of the same remote (https, ssh, `.git` spellings compared equal), and the
  directory-name fallback goes through the same normalization `mend adopt` uses, so a checkout
  called `Mend` matches the project `mend`. Previously a GitHub-adopted project only matched when
  the folder name was spelled exactly like the store name, and `mend claude` from a mismatched
  folder would try to adopt the repository again. The guess is now visible:
  `mend claude|codex|opencode` print `✓ project mend · main · from cwd` before creating anything,
  and `mend projects` marks the cwd's project with `▸`.

## 0.4.0

### Minor Changes

- 6ed7b44: Hot sessions: a project can keep workspaces ready so new sessions attach instantly. Set
  the count on the project setup page (default 0) and Mend pre-provisions that many complete session
  skeletons — worktree, session socket, and a live workspace; starting a session claims one and goes
  straight to the terminal instead of paying the container build, dotfiles, and credential setup at
  launch. The pool drains and rewarms itself whenever the image, variables, secrets, references,
  mounts, or dotfiles change, and the setup page reports what is observed ("2 ready · 1 warming").
  Each ready workspace is a live container on this machine — the count is explicit resource intent.
  Resumes still launch cold: a resume is bound to its existing worktree, which a pooled workspace
  cannot adopt.

### Patch Changes

- ee0fd13: `mend dotfiles` shows the repository's subdirectory when one is set. The dotfiles
  repository knob now takes a repo-relative subdirectory: the launch archive is re-rooted there
  (`git archive HEAD:<subdirectory>`), so a repo whose home tree lives in a subfolder — a `dots/`
  directory, a stow package — applies to `~` without restructuring. Configured in Settings →
  Dotfiles.

## 0.3.1

### Patch Changes

- 0704527: `mend shell` sessions get the agent accounts you actually have. The shell workspace asked
  the platform for credential bundles (Claude + Codex + GitHub, then Claude + Codex, then GitHub)
  and fell back to none when any named account was not connected — a Codex-only user opened a shell
  with no agent auth at all. The ladder now degrades per provider, so a Codex-only (or Claude-only)
  user still lands on that account.

## 0.3.0

### Minor Changes

- 12f71f2: `mend env load [path]` — load a `.env` file into the project's environment store: every
  `KEY=VALUE` line becomes an entry (comments and blank lines dropped; `export` prefixes, quoted and
  multi-line values honoured), routed by name into Configuration or Secrets. Secret-shaped names
  (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, …) land in Secrets, as does everything when you
  pass `--secret` (or only the names in `--secret A,B`). Secrets are encrypted at rest and never
  printed back; the rest are plain Configuration. `mend env [show]` prints the current sets as terse
  facts — names, revisions, byte counts, never secret values. New workspace launches receive both
  sets (secrets through the platform's transient secret channel, redacted from the record); running
  sessions are unaffected.
- e7fa8de: `mend login [--url <server>]` signs the CLI in: it prompts for the email and password of
  your Mend account, exchanges them for a bearer token, and stores it (0600) in the CLI config next
  to the server url, so every other command is authenticated without setting `MEND_TOKEN`.
  `mend logout` clears it. Unauthenticated calls now say which server refused them and point at
  `mend login` instead of the bare "set MEND_TOKEN" hint.

## 0.2.0

### Minor Changes

- fefa161: `mend dotfiles` — your dotfiles on the server, captured from the machine that has them:
  `mend dotfiles sync [--all | paths…]` scans a curated candidate list (shell/git/editor/terminal
  configs — never keys or histories) on the calling machine and streams contents into your
  per-account dotfiles store; `mend dotfiles [show]` prints the store as terse facts. Sessions apply
  the snapshot before the agent starts. Also: the CLI config moves to
  `$XDG_CONFIG_HOME/mend/cli.json` (default `~/.config/mend/cli.json`); a pre-XDG `~/.mend/cli.json`
  keeps working when it is the only one present.

## 0.1.1

### Patch Changes

- d8f049c: Exit interactive CLI commands as soon as the session-end control frame arrives instead of
  waiting for the terminal transport and record finalization to close.
