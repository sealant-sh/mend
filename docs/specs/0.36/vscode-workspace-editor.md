# Bring my editor into Mend workspaces: the extensions you install

- **Release:** 0.36.x, a patch of the VS Code extension.
- **Status:** PR 1 (mend#1156, no Settings Sync question) is merged. PR 2 (picked extensions per
  project) is in review.
- **PRs:** mend#1078 (the first design, superseded here), mend#1156, and PR 2. Linear: SLNT-78,
  SLNT-328; the server-side list is SLNT-329 (0.37).
- **Decisions:** Yiannis, 2026-10-26, on SLNT-328 (below). D5 from 2026-10-17 still holds.
- **Written:** 2026-10-26, against mend main `c03fb393e`. This rewrite replaces the 2026-10-18
  design, which installed every local extension and planned to copy machine settings. That design is
  in git history at mend#1078.

## Why it exists

A Mend workspace window gets a fresh Remote-SSH home in every session. Nothing in `~/.vscode-server`
reaches a new worktree. An extension a person installs inside one session of a project is gone in
the next one.

The first design answered this by installing every local workspace-kind extension on every open.
With Settings Sync on, each install asked "Would you like to install and synchronize '<X>' extension
across your devices?". Nick, a 0.36 user, got about 30 of these dialogs on 2026-10-25, and said:
"don't automate installing extensions please, just sync what I choose to install." He agreed with
Yiannis's summary of the ask:

1. It asked about every single extension, where all he wanted was for it to do nothing and let him
   install them himself from the panel.
2. It should remember which extensions he installed in any given session, and carry those to all
   future sessions.

## Decisions

Yiannis decided these on 2026-10-26. Build exactly this, nothing more.

- **Pick.** What a person installs from the Extensions panel in a Mend workspace window joins that
  project's set, including VS Code's own **Install in SSH: …** on a local extension. Uninstalling it
  there removes it. There is no checklist and no Mend picker.
- **Where.** The set lives in the Mend extension's `globalState` on the person's machine, keyed by
  project id, and listed in `setKeysForSync`, so Settings Sync carries it to their other machines.
  On each open of a workspace window of the project, Mend reinstalls the set silently in the
  background with `donotSync`. A server-side list that follows the person without Settings Sync is
  SLNT-329, for 0.37. A per-project `~/.vscode-server` would need the SDK, which has no per-project
  storage for capture workspaces; `PLATFORM-FEEDBACK.md` records it.
- **Settings.** Mend copies no settings. VS Code applies the person's local User settings in a
  remote window already, except settings of scope `machine` and `machine-overridable`
  (`src/vs/workbench/services/configuration/common/configuration.ts`, lines 30 to 32, VS Code
  `30ca50fe7`). Those are mostly local paths, such as a Mac interpreter path, that would point at
  nothing in a Linux workspace. The machine settings half of the first design is dropped.
- **Setting.** `mend.workspaces.bringMyEditor` takes `off | picked`, default `picked`. `off` is off.
  Every other value reads as `picked`: unset, and the old `extensions` and `extensionsAndSettings`.
  Nothing installs every local extension any more.
- **D5, kept.** Mend acts only in a Mend alias window whose remote server runs as a person uid
  (40001 to 49999) with HOME `/home/m*`, and keeps its folder inside that HOME. A shared or root
  home does nothing and shows `editor stays local · shared home`.

## What the person sees

- **Session 1.** The status item reads `extensions in sync`. The person installs GitLens from the
  Extensions panel. With Settings Sync on, VS Code asks its own question once, because this is the
  person's own install. The log then says
  `eamodio.gitlens: carried to later sessions of this project`.
- **Session 2, same project.** The item reads `installing extensions 1/1`, then
  `extensions in sync`. Mend asks nothing. The window is usable throughout.
- **Uninstall.** Uninstalling GitLens in any session logs `eamodio.gitlens: no longer carried`.
  Later sessions do not get it.
- **A file install.** An extension installed from a VSIX logs
  `<id>: installed from a file, not carried`.
- **No project.** While Mend cannot tell the window's project (signed out, or no session this person
  can see), the item reads `extensions not carried · not signed in`. Picks seen meanwhile wait in
  memory and are written once the window finds its project.

## How it works

Mend runs in the local UI host, even in a remote window. It reads the workspace through
`vscode.workspace.fs` on `vscode-remote://<authority>/…`. The only file it reads for this feature is
the remote server's `<agentFolder>/extensions/extensions.json`, which lists every extension
installed in the workspace with its source (`gallery`, `vsix` or `resource`).

### Data

| Store                                      | Content                                                                       | Scope                       | Synced                |
| ------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------- | --------------------- |
| `globalState["mend.editor.picks"]`         | per project id, per extension id: `picked {at, preRelease}` or `removed {at}` | every window, every machine | yes, `setKeysForSync` |
| `globalState["mend.editor.installMemory"]` | `missing[id]`: when the gallery last had no such extension                    | this machine                | no                    |
| the window's memory                        | the observer: the `previous` read, each restore's state, the window's journal | this window only            | no                    |

- **The book.** `mend.editor.picks` is one key, because Settings Sync applies only the keys a
  machine lists, and a machine that never opened a project must still receive it. Per (project, id)
  the entry with the later `at` wins, and `picked` wins a tie. A removal stays as a tombstone, so a
  stale replay cannot bring it back. Merging is commutative and idempotent.
- **Old keys.** `mend.editor.localExtensions` is no longer read. Mend clears it once. An install
  memory from the first design keeps only its `missing` entries.
- **Branded ids.** `ExtensionId` and `ProjectId` are parsed once, at `extensions.json` and at the
  window's located session. A book that does not parse (a newer version from another machine) is
  `unreadable`, and Mend never writes over it.

### The one rule that makes a pick

`observe(observer, event)` in `editor-observer.ts` is a pure reducer, and the only place that makes
a pick or a removal. Its state is the window's last successful read (`previous`), the state of each
restore Mend asked for, and the window's journal. Its events are a read (a list, a missing file, or
a read that did not parse), a restore that started, a restore that settled, and the setting turned
off. Each step returns the new state and the book entries the event observed. Its table tests are in
`editor-observer.test.ts`.

A read compares the new list with `previous`:

- An id that appears, from the gallery, is **picked**.
- An id listed both times, from the gallery, whose pre-release choice changed, is **picked** with
  the new choice. A version change alone is no change.
- An id in the previous read and absent now is **removed**, whoever installed it.
- An id that appears from a file is `fromFile`: logged, never carried.
- Remote-SSH's own extensions and Mend itself are never picks. An id in VS Code's
  `remote.defaultExtensionsIfInstalledLocally` (by default Copilot, Copilot Chat and GitHub Pull
  Requests) can be a pick. VS Code installs those in a remote only when they are installed locally,
  which a remote window cannot see, and a person who installs GitHub Pull Requests in a workspace
  wants it carried. When VS Code installs one by itself after Mend's first read, it becomes a pick
  too, which costs nothing: VS Code installs it in every later session anyway.

The first read of an enabled period is a baseline and yields nothing. So the extensions an older
Mend installed in bulk are never adopted, and a person who upgrades starts with an empty set. Only
what they install from now on is carried.

A read that does not parse is no observation at all, so it can never read as "everything was
uninstalled". A missing `extensions.json` at the baseline means an empty list, because a fresh home
has none until its first install. A missing file after that is no observation.

Each restore has a state, `inFlight` and then `settled`:

- Mend marks an id `inFlight` as it sends VS Code's install command, and keeps it there until that
  command settles. The 120 s report deadline ends only Mend's wait. VS Code's install runs on, so a
  restore that arrives after the deadline is still Mend's.
- While an id is marked, its appearance is not a pick and its disappearance is not a removal. VS
  Code lists an extension while its dependencies still install, and takes it out again when one
  fails. So a restore that appears and is rolled back leaves the book as it was.
- When the command reports success and the read lists the id, the id is absorbed into `previous` and
  the mark ends. A failed command, or a success the list does not show, keeps its mark for 3 s, the
  propagation wait, and the first read after that drops it.
- While any restore is marked, an id that appears and whose entry in the book or the journal is
  `removed` is not a pick. Pack members and dependencies arrive with a restore, and they must not
  undo a removal. Every other appearance stays a pick, so a person's own install is never lost.

After the mark ends, the id is the person's like any other. If they uninstall it and install it
again by hand in the same window, that install is a pick again.

### Observing the panel

Every trigger runs one observation: read, parse, step the observer, then `flush`. At most one read
is in flight and at most one waits.

- `vscode.extensions.onDidChange` fires in the UI host when an extension is installed or uninstalled
  in the remote. The workbench sends each extension delta to every host, and the local host's
  registry fires on every delta
  (`src/vs/workbench/services/extensions/common/abstractExtensionService.ts`, lines 182 to 208 and
  345 to 362; `src/vs/workbench/api/common/extHostExtensionService.ts`, lines 1050 to 1060;
  `src/vs/workbench/services/extensions/common/extensionDescriptionRegistry.ts`, lines 93 to 97).
- The uninstall of an extension that has already activated sends no delta
  (`abstractExtensionService.ts`, lines 289 to 292). A `FileSystemWatcher` on
  `RelativePattern(<agentFolder>/extensions, "extensions.json")` covers it. VS Code supports a
  non-recursive watch outside the workspace on a remote URI
  (`src/vs/workbench/api/common/extHostFileSystemEventService.ts`, lines 134 to 231). Delivery over
  Remote-SSH is checked by the live run.
- Window focus regained, and a read every 10 s while the window is focused, back both up.
- Every pass observes before it plans and after it installs.

`flush` writes `withEntries(book, project, journal)` unless `holds(book, project, journal)` says the
book already reflects the journal. It runs after every observation, whether or not the list changed,
so a book that Settings Sync or another window replaces later is written again while the window is
open. A write that fails is tried again on the next observation. Two seconds after a write it checks
again, and writes again if another window's whole-memento write lost it.

Turning the setting `off` drops the observer's baseline and its restores, and keeps its journal.
Turning it back on starts a fresh baseline, so nothing installed or uninstalled while it was off is
recorded.

### The pass

1. Read the mode. `off` stops here and shows no item. Turning the setting off during a pass stops
   the pass at its next await, and it shows nothing.
2. Run `MendWorkspace.ofWindow`. A non-Mend window stops here, with no remote read.
3. Read `/proc/self/status` and `/proc/self/environ`, then apply D5. A shared home stops here.
4. Observe, which sets the baseline on the first pass.
5. Take the project id from the window's located session (`WorkspaceWindow.session()`, or wait up to
   30 s for `onDidLocate`). No project means no plan and no write. A window that found no session
   looks again when the person signs in or the connection changes (`WorkspaceWindow.locateAgain()`),
   which fires `onDidLocate` and starts a pass.
6. Observe again, because the person may have installed something while Mend located the session.
7. Plan against that read: the project's wanted ids that are not present, skipping an id the gallery
   did not have within 24 h and an id whose earlier restore is still in flight. An id counts as
   present when the workspace lists it, or when `vscode.extensions.getExtension(id)` finds it in
   this window's UI host. VS Code's install command would only update that local copy, so Mend never
   asks for it.
8. Install in the background, one at a time, with `runInstalls`: `donotSync`, retries on transient
   failures after 1 s and 4 s, and a pre-release pick installed with `installPreReleaseVersion`.
9. Observe again, polling up to 3 s for ids that reported success. Then settle `in sync`, or
   `not synced` with each missing id named in the log. An id that reported success but is not listed
   is retried on the next open. Nothing is learned from it.

`activate` never awaits the pass.

### The D5 predicate

`editorHomeOf(workspace, process)` in `editor-home.ts` is the only isolation rule. A home counts as
a person home when all four `Uid:` fields are equal and within `PERSON_UIDS`, HOME matches
`^/home/m[a-z0-9]+$`, and the server's folder (`VSCODE_AGENT_FOLDER`, or `<home>/.vscode-server`
when it is unset) is inside HOME. Everything else is `shared`. To flip the rule, edit that function
and its test table.

D5 proves only that the home is a person's. That it is _this_ person's comes from Core's gateway,
which admits only the person who launched the workspace and runs the server as that person's user.

There is one more guard, outside the predicate. If Mend itself is running in the remote host
(`context.extension.extensionKind === Workspace`, because someone forced it there), the feature
stays off. In that case its local reads would be the remote's.

## Idempotence and races

- **A window closes mid-install.** Installs change no book entry, because the ids are picks already.
  The next open plans again from the book.
- **A window closes within a second of a panel install.** The observation never runs, so that pick
  is lost. The extension stays installed in that session, and the person installs it again from the
  panel in a later one. This is accepted, in exchange for no shutdown I/O.
- **Two windows of one project.** They are two workspaces with their own reads and journals, and
  each merges into the book. If window A uninstalls X while window B restores X, B's copy is not a
  pick, because B is restoring it. That holds when B's install outlasts the 120 s report deadline,
  because B keeps X marked until VS Code's command settles. A removal never uninstalls anything in
  another window.
- **A restore that brings company.** A pack or a dependency that VS Code installs with a restore is
  not a pick when the book says it was removed. One the book has never seen is a pick.
- **The setting turned off and on.** Each enabled period has its own generation. A read or a restore
  that began before the setting went off is dropped when it lands. An observation queued before it
  went off does nothing when its turn comes.
- **Concurrent `globalState` writes.** VS Code sends an extension's whole memento on each update
  (`src/vs/workbench/api/common/extHostMemento.ts`, lines 35 to 47), so two windows writing in the
  same instant can lose one write. The window that lost it writes again on its 2 s check. A window
  that closes inside those 2 s, right after such a race, loses that write. This is accepted. Its
  cost is one reinstall from the panel.
- **Two machines.** Settings Sync carries the book. A pick made on two machines within one sync
  interval can lose one side, unless a window that saw it is still open to write it again. Entry
  order uses each machine's clock, so a large clock skew can order two changes wrongly.

## How to verify

**Unit tests** (vitest, pure modules):

- `editor-picks`: parse and round-trip; the later entry wins per id, and `picked` wins a tie;
  merging is commutative, associative and idempotent; an old pick loses to a newer tombstone; two
  windows' journals merged in either order give the same book; `holds` is true exactly when a merge
  changes nothing; `wantedBy` lists only that project's picks.
- `editor-observer`: a table of reads (a gallery pick, a file install, a removal, Remote-SSH and
  Mend, VS Code's default remote extensions, a missing or unparsable file, a version change, a
  switch to and from pre-release); a table of restores (absorbed then uninstalled and installed
  again, appeared and rolled back, failed while still listed, timed out and arriving after a removal
  elsewhere, reported but never listed, already listed, a pack member whose entry is `removed`, an
  id this window removed, a removed id installed by hand with no restore running); and the setting
  turned off (fresh baseline, journal kept, stale reads and restores dropped).
- `editor-extensions`: `parseEditorMode`; `parseWorkspaceList` on torn JSON, `[]`, and each source;
  `planReinstall`, with an id in the UI host and an id in flight; `parseInstallMemory` on a
  first-design record; `runInstalls` and `classifyInstallFailure` as before.
- `editor-status`: `settledState`, an id in the UI host included, and each `statusView` variant,
  `noProject` included.
- `workspace-window`: a window that activated signed out finds its session after a sign-in, and does
  not look again once found.

**Live** (`.claude/skills/verify/` drive-vscode, and `scripts/vscode-remote-acceptance.mjs`):

- Session 1 of a project: install an extension from the Extensions panel by its button, and set one
  of its settings in the local User settings.
- Session 2 of the same project, in a new worktree: the extension is installed with no dialog
  (`recipes/vscode-editor-dialogs.mjs` counts 0), and the setting reads the local value there.
- Uninstall it in session 2: session 3 does not get it.
- A local extension never installed in a workspace never reaches one.

## Synthesis decision

Three runners designed PR 2: Claude Opus, Codex GPT-6.1 Sol and Codex GPT-6-Astra. The cross-judge
was Codex GPT-6.1 Sol, which scored Sol's candidate highest and recommended it as the base.

- **Base: Opus.** It has the smallest surface: one synced last-writer-wins book, a pure
  `changesBetween` that alone decides picks and removals, a first read that only sets the baseline,
  and the project id taken from the session the window already locates. It deletes the whole local
  capture.
- **Rejected from Sol and Astra:** per-window recovery journals on disk, under `globalStorageUri`,
  written with fsync and rename and never deleted, with observed-remove sets of unique tokens. They
  answer a race of milliseconds, a whole-memento write lost by a window that then closes within 2 s.
  Its worst case is one reinstall from the panel. The first design rejected the same outbox for the
  same reason.
- **Rejected from Sol:** adopting gallery extensions already listed at the first read. A live
  executor reopened after the upgrade would adopt every bulk install of the first design.
- **Grafted from Sol and Astra:** the restoring mark clears once the id appears, so a later
  uninstall and manual reinstall in the same window still counts. The judge found this gap in Opus.
- **Grafted from Astra:** a missing `extensions.json` at the first read is an empty list, and later
  it is no observation. A 10 s read while the window is focused backs up the watcher.
- **Settled by the judge, from source:** the UI host's `extensions.onDidChange` does fire for remote
  installs, as Opus and Astra said and Sol denied.

## Known limits

- An upgraded person starts with an empty set.
- A pick made less than about a second before the window closes is lost.
- Extension-pack members and dependencies that VS Code installs with a pick become picks too.
- The set follows the person to their other machines only through Settings Sync (SLNT-329 moves it
  to the server).
- Install by id at the latest version or the latest pre-release, from the editor's own gallery. A
  pinned version is not kept.
- A named VS Code profile keeps its remote extensions in another `extensions.json`, under the
  profile's folder. Mend reads only the default profile's file, so for a person on a named profile
  nothing is carried in this build. VS Code has no API that names the current profile.
- On a machine that never trusted an extension's publisher, VS Code asks its publisher trust
  question once when Mend restores that extension. Trusted publishers are stored per machine and
  Settings Sync does not carry them, while the book is synced. The install command cannot skip the
  question.

## Alternatives considered

- **Mark local extensions in a Mend picker.** No new UI was wanted; VS Code's **Install in SSH: …**
  already covers a local extension.
- **Keep the set on the Mend server (2B).** It follows the person without Settings Sync, but needs a
  server release and a migration. SLNT-329, 0.37.
- **A persistent per-project `~/.vscode-server`.** The SDK has no per-project storage for capture
  workspaces, and two live sessions of a project would share one directory.
- **Copy machine-scoped settings.** They are mostly local paths. VS Code carries every other scope.
- **`isMachineScoped` to tell Mend's installs from the person's.** With Settings Sync off, a
  person's install is not machine-scoped either, so the flag cannot tell them apart.

## History

### Fix round 1

An adversarial review of PR 2 (Claude Opus, Codex GPT-6.1 Sol, Codex GPT-6-Astra) found these holes.
Each is fixed in PR 2.

1. A restore whose report timed out lost its mark while VS Code's install still ran, so its late
   arrival became a pick that beat a newer removal. Now the mark holds until VS Code's install
   command settles.
2. A restore that appeared and was rolled back, because a dependency failed, read as an uninstall
   and wrote a tombstone. Now a marked id's appearance and disappearance are neither a pick nor a
   removal, and only the command's settlement ends the mark.
3. Packs and dependencies that arrived with a restore became picks and undid a removal. Now, while a
   restore is marked, an appearing id whose entry is `removed` is not a pick.
4. The book was checked only after a list change, so a book replaced later stayed wrong while the
   window was open. Now every observation checks it.
5. Signing in never located the window's session again, so a window opened signed out stayed at
   `not signed in`. Now a window with no session looks again when the sign-in or the connection
   changes.
6. The plan used the read taken before the locate wait of up to 30 s. Now the pass reads again after
   locating and plans against that read.
7. A pick the window also runs in its UI host never reached the workspace, and Mend reported
   `not synced` on every open. Now such an id counts as present. Every restore passes `donotSync`.
8. VS Code's own default remote extensions became picks, depending on timing. The first fix never
   picked an id listed in `remote.defaultExtensionsIfInstalledLocally` or
   `remote.SSH.defaultExtensions`. The acceptance run then showed that this never carries GitHub
   Pull Requests, which that setting lists by default and which Nick installed in a workspace and
   lost. The exclusion is gone: such an id is a pick like any other.
9. A switch between release and pre-release was never recorded. Now it is a pick with the new
   choice.
10. Changes made while the setting was off were recorded when it was turned back on, and a pass
    running when it was turned off could still show an item. Now `off` drops the baseline and the
    restores, the pass stops, and nothing shows.
11. These rules lived in closure state with no tests. Now they are one pure reducer,
    `editor-observer.ts`, with table tests, and `workspace-editor.ts` only does the reads, the
    installs and the writes.

### Settings Sync (mend#1156)

With Settings Sync on, a Mend workspace window asked "Would you like to install and synchronize
'<X>' extension across your devices?" once for each extension Mend installed. One person met about
30 of these dialogs. A verify run with four local extensions showed four
(`.claude/skills/verify/recipes/vscode-editor-dialogs.mjs`).

The cause is in VS Code's workbench, read at commit `30ca50fe7` of its source:

- `workbench.extensions.installExtension` sets `isMachineScoped: true` only when its options carry
  `donotSync: true`. Otherwise `isMachineScoped` stays undefined
  (`src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts`, lines 465 to 519).
- When `isMachineScoped` is undefined, `installFromGallery` calls
  `hasToFlagExtensionsMachineScoped`. If extension sync is on, that function shows the dialog. When
  the answer leaves the install unscoped, `installFromGallery` also adds the local extension server
  to the install targets
  (`src/vs/workbench/services/extensionManagement/common/extensionManagementService.ts`, lines 532
  to 537 and 745).

The fix passes `{ donotSync: true }` to the command. For a workspace-kind id, VS Code then installs
a machine-scoped copy in the workspace only. It asks nothing and leaves the local copy and Settings
Sync as they were.

mend#1156 sent no options for an id the window already ran in its UI host. For such an id the
command reaches `updateFromGallery`, which installs on the local server, and `donotSync` would mark
the local copy machine-scoped
(`src/vs/platform/extensionManagement/node/extensionManagementService.ts`, lines 1086 and 1135 to
1136), which takes it out of Settings Sync
(`src/vs/platform/userDataSync/common/ignoredExtensions.ts`, line 69). Fix round 1 removed that
branch. Such an id now counts as present and is never restored, because the command never installs
it in the workspace. Every restore passes `donotSync`.

The DinD spikes and the PR 1 runs never ran with Settings Sync on. The harness started VS Code
without `--sync` on a fresh user-data directory, where sync is off. Now
`scripts/vscode-remote-acceptance.mjs` passes `--sync on`. VS Code reads that flag before the stored
setting, so sync is on with no account signed in. In an extension test host, VS Code's
`DialogService.prompt` throws instead of showing a dialog
(`src/vs/workbench/services/dialogs/common/dialogService.ts`). If the argument is lost, the install
of `editorconfig.editorconfig` fails, the pass settles `not synced`, and the `remoteEditor` step
fails.

### Merge gate round 1

The independent merge-gate verifier of PR 2 found one more hole.

1. An observation queued behind a read in flight checked only that the window had a workspace, and
   took the observer's generation when it started. If the setting went off while it waited, it ran
   afterwards under the new generation and recorded a baseline while the setting was off. An
   extension installed after that, still while off, became a pick when the setting was turned back
   on. Now an observation reads the mode in the same step that takes the generation, so one that
   starts while the setting is off does nothing. `workspace-editor.test.ts` drives this sequence
   through `startWorkspaceEditor`.
