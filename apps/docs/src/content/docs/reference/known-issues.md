---
title: Known issues
description:
  Limits of the current release that change what you see or what Mend keeps, and what Mend does
  about each.
sidebar:
  order: 2
---

Each entry says what happens, where, and what Mend does meanwhile. None of them deletes work on its
own: where Mend cannot confirm a save, it keeps the executor.

## A Stop on Garage can wait for its seal

Applies to buckets that ignore conditional writes (`If-None-Match`). Garage, the bucket
`mend server setup` installs, is one.

On such a bucket an upload link Mend handed out could replace an object until it expires, so Mend
does not accept a final save (its seal) while one could. An executor whose sealantd binds each
upload link to the bytes it was minted for has none of those links: Garage refuses any other bytes
through them, so a Stop waits for no link. Mend still reads the save back before it accepts it. It
skips what it has already read and verified since the last link that could have changed anything.
After Mend restarts, the first Stop of each session reads everything that session's save names once.
The wait for links remains:

- for an executor whose sealantd predates bound links, until its links expire plus a 5-minute margin
  for the bucket's clock: about 10.5 minutes after a small Stop, up to 20 after a large one;
- for a seal that carries what such an executor saved, until that executor's links have expired;
- for a Stop that uploaded a single object over 5 GB, which goes up in parts.

A restart of Mend no longer holds a Stop. Before 0.36 every Stop in the 20 minutes after a start
waited those 20 minutes out. The upgrade to 0.36 itself still does, once: for 20 minutes after the
first start on 0.36, a Stop waits as it did before.

Meanwhile the session stays `stopping` and says `final seal not confirmed`, and the executor keeps
running. Nothing is lost: the session finishes stopping once the seal stands.

AWS S3, Cloudflare R2 and MinIO refuse a conditional overwrite, and a Stop there has no such wait.
Only AWS MicroVM executors have a time limit, and they use S3. Docker and Kubernetes executors have
no time limit.

## Sessions cannot start on Ubuntu 23.10 and later until user namespaces are allowed

Each workspace runs its own rootless Docker, which Ubuntu's default AppArmor setting refuses. Mend
does not change a host's kernel settings for you: `mend server setup` and `mend doctor` say what to
run. See
[Every session fails to launch on Ubuntu](/operate/troubleshooting/#every-session-fails-to-launch-on-ubuntu).

## Projects adopted with a token in their URL

Applies to projects and reference repositories added before 0.36 from a URL with a login or token in
it, such as `https://oauth2:TOKEN@gitlab.com/acme/api.git`. Before 0.36 Mend stored that URL as
typed and returned it to everyone who could see the project; 0.36 refuses such a URL
([No credentials in repository URLs](/guides/git-access/#no-credentials-in-repository-urls)).

On upgrade, Mend removes the credential from the stored URL. It does not edit the project's Git
store: a store whose Git config still holds a login or token (or includes another file, which Mend
never writes) is refused. Fetching, pushing, landing, starting or resuming a session there, and
adding the project to a session, say what kind of thing Mend found and that an operator must remove
it. The server log names the exact command, at each such refusal and for every such project at
start. Nothing in the store or its worktrees is lost.

To fix one, adopt the repository again from its SSH URL with your Mend key (`mend keys`) or the
agent bridge, or have the operator run the `git --git-dir=… remote set-url …` command the server log
names. Rotate the token: anyone who could see the project before 0.36 could read it.

## SHA-256 repositories are not supported

Mend refuses to adopt a repository that uses SHA-256 object names:

```text
Mend doesn't support SHA-256 repositories yet.
```

A project adopted before this check is refused the same way when a session starts on it.

Grafts (`info/grafts`) cut history the same way while git calls the repository complete. A clone
never copies them, so only a project whose repository was edited on the Mend host has them. A
session start on one is refused:

```text
Mend doesn't support repositories with grafts (`info/grafts`) yet. Remove the grafts, or convert them with `git replace --convert-graft-file`.
```

Replace refs (`git replace`) are not refused: Mend saves the real history under them.

Converting a session's repository to SHA-256 while the session runs is not supported. Its later
saves never seal, so a Stop never finishes: the executor is kept and the session stays `stopping`.
Discard unsaved and stop is the only way to end it, and it discards what the executor holds.

## Shallow repositories are not supported

A shallow repository holds only part of its history: a `git clone --depth` copy, a CI checkout, a
mirror made from one. Mend refuses to adopt one:

```text
Mend doesn't support shallow repositories yet. Make the repository complete where it is hosted (`git fetch --unshallow`), then adopt it again.
```

Mend clones everything the source holds, so a shallow source gives a shallow project, and fetching
from that source again adds no history. A session on one could not save: Mend verifies each save by
walking the git history it names, and the walk reaches commits whose parents the repository does not
hold. Before this check, a Stop on such a project read `saving` for up to 10 minutes and then
`not saved · final seal not confirmed · workspace kept`.

A shallow checkout on your own machine is not a problem: `mend adopt` and `mend codex` from inside
one adopt its `origin` URL, and Mend clones that in full.

A project adopted before this check is refused the same way when a session starts on it.

Whatever the cause, a Stop whose last save failed git verification now reads
`not saved · final seal refused · git section failed verification · workspace kept` after its first
final flush, and the workspace is kept. Discard unsaved and stop ends it, and discards what the
workspace holds.

## Build output carried from another platform is checked at its top level

A session that moves between an arm64 and an amd64 executor carries the other platform's dependency
tree (for example `node_modules`) along. Before a seal stands, Mend reads each carried tree back.
For trees in the older one-object-per-directory format (`MEND_CAPTURE_MANIFEST_FORMAT=1`, or
captured before dir packs), that read covers the top-level directory and the file contents, not
every nested directory. The default format is read back in full.

## An edited copy of Mend's old workspace note stays in the memory file

Before this release, Mend's note in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` started at a
`<!-- mend:mounts -->` line and ran to the end of the file. The first launch after the upgrade turns
that note into the new bounded block when every line of it is exactly what Mend wrote, and keeps
whatever follows it. If someone edited inside the old note, Mend removes none of it: the old note
stays where it is and the new block is added at the end. The agent then reads both. Delete the old
note by hand.

## Setup commands run on a worktree's first launch only

A resume does not run a custom image's setup commands again: the saved capture it restores already
holds what they produced. Run them yourself if a lockfile changed. The session says
`setup skipped · restored from capture <n>` when it starts. Anything setup installed outside the
worktree is not in the capture; put it in Extra packages or the image. See
[When setup commands run](/guides/workspace-images/#when-setup-commands-run).

## A machine failure loses the last few seconds

A Stop, a replacement or a resume keeps everything. So does an executor killed outright whose disk
survives: the platform keeps it and boots it again to save what it holds. An executor whose machine
fails without warning can lose what was written after its last capture. Captures run 2 seconds after
the files go quiet, and at least every 10 seconds while they keep changing.

## opencode runs in the terminal only

opencode sessions run as terminals, as pi sessions do: attach from the CLI, the web app, the desktop
app or VS Code. The phone and Slack cannot start or steer them. opencode keeps its conversations in
a database rather than a file. A stopped opencode session resumes on the conversation it started
(`opencode --session <id>`), which Mend reads out of that database when the session stops, but Mend
shows no transcript for it and cannot resume it on another harness. Two opencode sessions running at
the same time in one worktree can leave Mend unable to tell whose a conversation is; resuming either
is then refused rather than opening the wrong one. opencode has no shared effort scale, so
`--effort` does not apply to it.

When a repository has a `.opencode` directory, opencode installs its own plugin package there at
startup, and a lockfile committed in it can change. That edit shows up in the session's change like
any other.

opencode's database is saved with the session as its conversation. In a
[per-person workspace](#per-person-workspaces) it is its owner's alone, and Mend deletes a login
made inside opencode when opencode exits. In a remote workspace that shares one home, the next
session in the worktree, anyone's, opens it: a login you make inside opencode to the opencode
console or to one of its integrations is kept in that database, so it travels with it. The logins
Mend gives opencode (your ChatGPT login) never go there. In such a workspace, sign in to the console
or integrations only in a worktree nobody else uses.

In a remote workspace, opencode keeps the logins of the MCP servers it signs in to in a file Mend
keeps out of what the session saves, when Mend starts opencode:

- An MCP sign-in lasts only as long as that workspace. Resuming the session on a new workspace asks
  for it again.
- In a workspace that shares one home, people joined on it share that file. One person's opencode
  uses MCP sign-ins the other made there. In a per-person workspace the file is in each person's own
  home.
- An opencode you start by hand in a session's shell writes that file into saved state until the
  platform leaves it out too (sealantd#136). The next session in the worktree then removes it unread
  before it starts, but the earlier saved states still hold it.
- A session saved before this change may hold MCP sign-ins; every later session in the worktree
  removes them unread before it starts, and removes a link left at that file's place that leads
  anywhere else.

## pi runs in the terminal only

pi sessions run as terminals: attach from the CLI, the web app, the desktop app or VS Code. The
phone and Slack cannot start or steer them yet; that needs the structured mode Claude Code and Codex
have.

## pi packages that build native code need build tools

A pi package that compiles native code when it installs needs `make`, a C compiler and Python.
Workspace images do not include them, so such a package (`@plannotator/pi-extension` is one) fails
to install. The session leaves it out, says so in the terminal, and pi starts without it: pi itself
would stop at startup. Add the build tools to the project's
[workspace image](/guides/workspace-images/) to install it.

A package that failed is tried again at every launch, which adds a few seconds.

## Each new pi session installs its packages again

A session's harness home is its own, so every new pi session installs the packages and extension
dependencies of your [pi profile](/guides/pi/) again: about a minute the first time, a few seconds
when the same session launches again. Agent memory is the only thing carried between sessions.

## Your pi profile is the same in every project

`mend connect pi` saves one profile per person, delivered to every pi session you start, in any
project. A project's own `.pi/settings.json` in the repository still applies on top of it, as it
does on your machine.

A session that is already running keeps the profile it started with.

## A pi started outside a pi session can run the last pi session's profile

Applies to workspaces that share one home. In a [per-person workspace](#per-person-workspaces) a
`pi` you type runs in your own home, on nothing of anyone else's.

In a workspace that shares one home, a worktree's agent state is shared by its sessions. Every pi
session Mend starts, fresh or in a workspace where no pi is running, is set up to run on its owner's
pi profile or on none, and does not start when that cannot be done.

`pi` typed in the terminal of a session that is not a pi session (a shell, Claude Code, Codex) is
not set up: it loads whatever profile the last pi session in the worktree left, that person's
extensions, settings and packages included. Start pi as a pi session (`mend pi`) to run it on your
own profile.

## A pi that joins another person's running pi runs on their profile

pi reads one profile per harness home, and in a workspace that shares one home a worktree's harness
home is shared by its sessions. There, a pi session that joins a workspace where another person's pi
is running runs on that person's profile: their extensions, settings, packages and MCP servers, with
any header or token their `mcp.json` holds. Mend starts it anyway and changes nothing there, so the
other person's pi keeps running as it was. A pi session that starts once no pi is running there gets
its own profile. In a [per-person workspace](#per-person-workspaces) each pi runs on its own
person's profile.

## Agent memory is saved when the agent ends

Mend reads back what the agent learned when its agent ends: on a Stop, when the agent exits, or when
a session is handed to another mode. A conversation that stays open for days saves its memory then,
not before, so a session started meanwhile does not see what that one has learned yet. See
[Agent memory](/guides/agent-memory/).

When two of your sessions changed the same memory file, both sides' lines are kept, so a line both
of them wrote can appear twice. The agent tidies its memory as it goes.

## A session that joins someone else's executor uses their memory

Applies to workspaces that share one home. In a [per-person workspace](#per-person-workspaces) each
person's agent reads and saves their own memory.

On a server, a worktree has one executor. A session you start in a worktree where another person's
session is already running joins their executor, and its agent shares their harness home. It reads
their memory, not yours, and what it learns there is saved to their memory, never to yours:

- what it writes before their agent ends is saved when that agent ends;
- what it writes after that is saved when their next agent in that worktree ends, or when someone
  else next starts a session there.

A joined Codex session starts with its memory off: it neither builds memory nor leaves conversations
for anyone's Codex to build memory from, yours included, later or anywhere else. A session that
joins while the other person's session is still starting can begin before Mend has moved the
previous person's memory out of the way: its agent can read that memory, and what it writes there
ends up kept beside it. Start your session in a worktree of your own to work from your memory.

## A session that joins someone else's executor runs on their logins

Applies to workspaces that share one home: new worktrees on a server where the operator set
`MEND_HARNESS_LAYOUT=shared`, and worktrees whose workspace cannot run per person (a nix image, no
`sudo`, a Kubernetes workspace runtime, a Docker host with no-new-privileges). Per-person workspaces
are the default in 0.36: in a [per-person workspace](#per-person-workspaces) each person's processes
run as their own user, on their own logins.

On a server a worktree has one executor, started by whoever launched first. Every process in it runs
as root in that person's harness home, whoever started the process. A session you start in a
worktree where another person's session is running joins their executor, so:

- your agent runs on their Claude or Codex login, and a conversation records its turns as billed to
  them;
- your shells and Services are root shells and processes in their home: they can read their Claude
  and Codex credential files and the executor's `GITHUB_TOKEN` and `GH_TOKEN`, which are theirs;
- `git push` and `git fetch` from the workspace, yours included, sign as them. The executor's own
  session channel names their session, so Mend's git transport signs with their Mend key, or asks
  their machine to sign in bridge mode, and records the push on their session;
- a repository you add to your session is cloned through the same transport, on their git access.

Landing a change is not affected: Mend asks GitHub as the change's owner, never through someone
else's executor. If the person who started the executor is removed from the organization, Mend stops
the sessions working in it, saves it and retires it; start again to continue in an executor of your
own. If a project becomes private and you can no longer see it, a session of yours running in
someone else's executor stops; sessions in your own executors keep running until they end. Start
your session in a worktree of your own to run on your own logins.

## A worktree someone else used before you

Applies to workspaces that share one home.

A session you start in a worktree someone else used, once their executor has ended, starts from your
memory. Mend first saves theirs for them, then moves it to `~/.mend/agent-memory-kept/` in that
worktree's executors, where it stays: anyone working in the worktree, and their agent, can read it
there. Nothing deletes these kept sets, so in a worktree people take turns in they add up, one copy
of the previous person's memory per turn, and every later session restores them. When Mend cannot
tell whose memory the worktree held (it was used before this release by several people, or their
sessions were removed), nobody is credited and it is only moved.

An executor started before this release is judged by who started it until it ends.

## A `codex` you run yourself in a shared worktree

Applies to workspaces that share one home.

Your Codex sessions on a server never build memory from another person's conversations. A `codex`
you type in a shell session, or one your agent runs in a Claude, opencode or pi session, is not a
Codex session: Mend does not prepare it, and it can build memory from the other conversations in the
worktree into the memory that worktree's home holds. Start a Codex session instead.

The same goes for a Codex session whose command Mend does not recognise as `codex`: one wrapped in
`env`, started by an absolute path or through `npx`, or run from a shell script
(`mend run -- sh -c "…"`). Joining someone else's executor, it starts with Codex's own memory
settings, so the conversations it starts can build their memory.

Two smaller gaps in the same place:

- Codex can turn a withheld conversation back on itself when it reconciles an older conversation's
  file (the resume picker's search does), for conversations recorded before Codex 0.160. Those age
  out of what Codex builds memory from ten days after their last change.
- Conversations you start inside Codex with `/new` are not known to Mend as yours, so your next
  Codex session withholds them too: they do not build your memory.

## Codex memory builds slowly, and on your login

Codex makes memory from a conversation only once it has been quiet for six hours, and only two at a
time when a session or a turn starts, with model calls on your own login. Mend carries your earlier
Codex conversations on the project into each new session so it can, a few at a time. A session
resumed later learns only from what was carried at its first launch. pi and opencode keep no memory
of their own.

Everything else in a session's harness home stays with that session: its conversations, and settings
or plugins changed inside it. A conversation resumes in its own session, not from another.

## Importing brings memory, not conversations

`mend memory import` brings the memory Claude Code keeps for the checkout on your machine. Your past
conversations are not imported: a conversation needs its paths rewritten to resume in a session.
`mend adopt` says when there is memory to import; it does not import it itself.

## Agent memory is in the CLI only

`mend memory`, `mend memory show` and `mend memory rm` list, print and remove your memory for a
project. The web app and the phone do not show it yet.

## Images on a Slack request that starts a session are not attached on the capture store

A Slack mention that starts a session on the capture store (the default `mend server setup`) does
not attach its images. Mend writes the opening turn, with each image's path, before the session's
workspace exists, and nothing is mounted from the server into a captured workspace. So there is
nowhere to put the file yet. The turn and the requester's note say
`not attached · the session has no running workspace to place it in yet`. Images on a follow-up to a
running session are attached, as the person who asked (in a per-person workspace, in their own saved
directory). Before 0.36 such images were written on the server and silently never reached the
workspace. On a co-located store nothing changed: the images are attached when the session starts.

Send the images again in a follow-up once the session is running.

## A server outside Linux on the co-located store does not store pasted images

On the deprecated co-located store (`MEND_SESSION_STORE=colocated`), the server writes a pasted
image into the session's harness home itself, reaching each directory through its open descriptor
(`/proc/self/fd`), so a link or a moved directory never leads the write elsewhere. A server run
where that is not available, such as one started outside its container on macOS, refuses the paste
with `no /proc/self/fd or /dev/fd here to keep the write inside …` and writes nothing. The packaged
server runs on Linux and is not affected.

## Per-person workspaces

Applies to workspaces where each person runs as their own Linux user: by default, every new worktree
whose image can run per person (unless the operator sets `MEND_HARNESS_LAYOUT=shared`), and every
worktree that has run that way once. See [Per-person workspaces](/operate/per-person-workspaces/).

Everyone in a per-person workspace has passwordless sudo, which runs as root: anyone working there,
and their agents, can read and change each other's files, logins included.

### People in one worktree can read each other's files

Each person's processes run as their own user, on their own logins, and use nothing of anyone else's
by default. With `sudo`, and with the `CAP_FOWNER` capability every person's process holds there,
anyone can read and change anyone's files. A person's saved conversations and memory are restored
into every workspace of the worktree. It is not a boundary between people.

Personal configuration inside the worktree is shared by design: `.claude/settings.local.json`,
`CLAUDE.local.md`, `.env`, a repository `.npmrc`, the `env` in `.mcp.json`, and the worktree's
`.git/config` and hooks. A remote URL with a token, or a `credential.helper` an agent writes there,
is used by the other person's `git push`.

### Files and permissions

- Restored worktree files belong to root and the `mend` group. A rewrite (`git checkout`, an
  editor's save by rename) makes a file its writer's. `npm i -g` lands in `/opt/npm-global`.
- A file another person's tool created with an explicit mode (`install -m 644`, `tar x`) is repaired
  in the worktree when someone else's process starts there. Elsewhere it needs a `chmod` or `sudo`
  until the next restore. A toolchain one person unpacked can be extended by another only after such
  a `chmod`.
- Sockets and files a tool leaves to the umask are reachable by the group outside each person's
  private `TMPDIR` and `XDG_RUNTIME_DIR`.
- A pnpm tree installed while the worktree shared one home is reinstalled once
  (`pnpm install --force --prefer-offline`) when the worktree first runs per person.
- A removed member's saved directory stays in the worktree's captures, owned by root, and no user is
  made for them.

### Logins and identity

- **No `GITHUB_TOKEN` in the environment.** Git over HTTPS to GitHub uses Mend's credential helper,
  which reads your GitHub login from your own home. A repository `.npmrc` with `${GITHUB_TOKEN}`
  fails until you run `export GITHUB_TOKEN=$(/run/mend/bin/mend-git-credential token)`. A
  `gh auth login` of your own is overwritten by the platform's next refresh of your connected GitHub
  login.
- **`docker exec` runs as root, with no login.** So does anything else Mend did not start, such as a
  custom image's own entrypoint work: no person's login, no Mend token, and what it writes under
  `/root` is not saved.
- **VS Code Remote-SSH reaches only workspaces you launched,** as your user, in your home: you are
  the launcher of a workspace your launch started, and of the next one when you launch it after the
  last one stopped. You cannot open Remote-SSH into a workspace someone else launched. Your user is
  made when the workspace starts; until then the workspace refuses SSH rather than open it as root.
  Remote-SSH runs as root, as before, in a workspace that fell back to one shared home (until
  Sealant has taken that change the session says `Remote-SSH unavailable`), on a Sealant that does
  not report `workspaceSshUser` (the session says `Remote-SSH: root, this Sealant runs it as root`),
  and where Sealant cannot bind your account to your person (an older Sealant, or a binding it
  already holds for someone else; the session says `Remote-SSH: root, Core can't bind your person`,
  and an operator clears a wrong binding in Sealant's database, as Sealant's upgrade guide says).
- **A removed workspace SSH key ends no connection already open.** The gateway refuses the key from
  the next connection; a Remote-SSH window connected before the removal stays connected until it
  disconnects or the workspace stops. The platform does not record when a key was last used.
- Settings edited by hand in a workspace last until it ends.

### Images

- **nix images take one person.** They run with one shared home.
- An image without `sudo`, `useradd` or ACL support takes one person.
- A custom image that installs toolchains under `/root` keeps them root's: they run for everyone,
  and each person's own installs land in their home.

### Hot sessions

- A [Hot sessions](/guides/project-environment/#hot-sessions) standby serves only its owner's
  session in a new worktree they started. A session in a worktree that has already run per person,
  or in a worktree someone else started, starts cold.
- A standby keeps the image answer it started on. When Mend learns something new about the image (a
  new digest, or that it cannot run per person), ready standbys of the old answer are replaced, and
  one already claimed runs the launch in the layout it started in.

### There is no way back from per-person

A worktree that has run per person always runs per person. Setting `MEND_HARNESS_LAYOUT=shared`
changes nothing for it, and an image that cannot run it (nix, no `sudo`, a uid clash) is refused for
that worktree:

```text
This worktree's sessions are saved per person, and its image cannot run per-person users (no sudo). Pick an image that can, or start a new worktree.
```

A new worktree can use that image. A Mend older than 0.36 cannot resume the worktree's sessions.

### Shared control

- A session once shared stays neutral: after shared control is turned off, its agent still runs
  without the owner's personal memory and instructions until the session ends. A new session has
  them.
- While control is shared, no personal memory, instructions, skills, plugins or MCP servers apply,
  and scheduled prompts are off. Mend installs no Claude plugin there, the repository's included.
  What the owner's agent loaded before sharing stays in the history.
- A change of sender waits for the previous sender's background work and holds the turns behind it.
  It restarts the agent process, which ends "accept for session" approvals and MCP sign-ins made in
  the previous process.
- In a shared Codex conversation, a goal, a queued prompt and the prompt history end at a change of
  sender.
- Full tool outputs Claude recorded before the session was shared are not re-readable by path; the
  conversation keeps what it showed the model.
- If a provider refuses reasoning made on another person's account, the turn fails and nothing is
  retried:
  `Bob's turn failed: OpenAI refused reasoning made on Alice's account. Alice can continue the conversation.`
- Only the change owner's own Claude processes have scheduled prompts; anyone else's have no
  `CronCreate` there.
- A conversation you resume by hand while Mend's process for it runs gets two writers.

### Harnesses

- **opencode is one person's.** Shared control is refused for opencode sessions:
  `opencode sessions are one person's. Shared control is not available for them; start your own session in this worktree.`
- **A login made inside opencode** (`opencode console login`, its integrations) is saved in the
  captures taken while that opencode process ran, in your own directory, where anyone working in the
  worktree can read it. Mend deletes it when opencode exits.
- **Claude's `/rewind` history is never saved.** It ends with the workspace, and in a shared session
  at the next change of sender, so `/rewind` cannot restore edits made before a move to another
  workspace.

### Dotfiles

A joiner's `install.sh` runs beside their agent, so the agent does not see what the script installs
or changes after it starts. The session line says `install.sh running`, then
`install.sh finished after the agent started`. Turn on **Start my agents after install.sh** to make
your joins wait for it. See [Dotfiles](/guides/dotfiles/#per-person-workspaces).

### Workspaces started before 0.36

A workspace that shares one home keeps it until it is replaced. Until then it takes only its
launcher's sessions and turns; anyone else is refused:

```text
This worktree's workspace started before Mend 0.36 and shares one home; it takes another person once it is replaced.
```

opencode conversations saved in such a workspace cannot be resumed per person:

```text
This opencode conversation was saved in a workspace that shared one home, and it cannot be carried into your own opencode data. It could be resumed only in that workspace, which has ended. Start a new opencode session.
```

A session whose shared control was turned on while its workspace shared one home keeps it on when
its worktree first runs per person, where it means something else: each turn on its sender's login,
and no one's personal memory or instructions. Turn it off and on again to see that confirmation.

Memory saved in a shared home before 0.36 goes to nobody, and is listed as not credited, when Mend
cannot say whose it is: two people had sessions there, a hand-over to another person was not saved,
or the worktree is older than Mend's record of who had sessions in it (a deleted session would not
be in that record) and its organization has more than one member. In an organization with a single
member who owns every session the worktree kept, that member is credited.

See [Workspaces started before 0.36](/operate/per-person-workspaces/#workspaces-started-before-036).
