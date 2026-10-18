# Bring my editor into Mend workspaces: extensions

- **Release:** 0.36
- **Status:** in review. PR 1 (extensions) is built and verified; PR 2 (machine settings) is
  designed, not built.
- **PRs:** mend#1078 (PR 1). Linear: SLNT-78.
- **Decision records:** none. Decisions D1 to D6 are below, approved 2026-10-17; Yiannis chose D5
  option A.
- **Written:** 2026-10-18, against mend main `e30572a21`. The feature touches only the VS Code
  extension and its acceptance harness. The measured facts come from the DinD spike: five Remote-SSH
  runs on VS Code 1.139.1, with evidence in `~/.cache/mend-evidence/vscode-settings-sync-spike/`.

## Why it exists

A Mend workspace window is a fresh Remote-SSH home every time. Nothing in `~/.vscode-server`
survives an executor, and one executor serves one worktree. The person's workspace-kind extensions
and remote machine settings must reach that home on every open. That has to happen without a prompt
and without slowing the window.

The facts that fix the shape:

- **Where Mend runs.** Mend runs in the LOCAL UI host, even in a remote window. Every remote read
  and write goes through `workspace.fs` on `vscode-remote://<authority>/…`, or through the install
  command.
- **What a remote window can see.** It cannot list the local workspace-kind extensions:
  `extensions.all` there shows only UI-host extensions (spike 2). The local list is therefore
  captured in local windows and handed over through `globalState`, the way `claimPendingTakeover`
  already hands over intents.
- **What a remote window can read.** It reads `/proc/self/status` and `/proc/self/environ` (uid,
  HOME, `VSCODE_AGENT_FOLDER`) and the remote `extensions.json`, at 76 to 216 ms per read (spike 1
  and 4).
- **How installs behave.** `workbench.extensions.installExtension <id>` installs a workspace-kind id
  on the remote in 1.2 to 2.3 s. It routes a UI-kind id locally as a silent no-op costing 0.2 to 0.7
  s. It does not retry a transient `Failed to fetch` (spike 3). Only the remote `extensions.json`
  says where an install landed.
- **Machine settings.** A Machine `settings.json` written through `workspace.fs` takes effect in
  about 300 ms. `onDidChangeConfiguration` fires 0.35 to 0.7 s after the file changes, and sometimes
  names unrelated keys (spike 4).
- **D5.** Act only in a Mend alias window whose remote server runs as a person uid (40001 to 49999)
  with HOME `/home/m*`. A shared or root home syncs nothing and shows
  `editor stays local · shared home`.

## Decisions

- **D1 Source of truth.** Extensions come from the person's local VS Code: every local window
  records the installed, enabled, workspace-kind extensions into `globalState`. Machine settings
  (PR 2) are one copy per person in `globalState` with `setKeysForSync`, captured from Mend
  workspace windows. No server change.
- **D2 Install.** By id, through `workbench.extensions.installExtension`, from the editor's own
  gallery, at the latest version. Ids that gallery lacks are skipped and named. No VSIX copy in
  0.36.
- **D3 Excluded.** Secret-looking keys and token-shaped values are dropped before a setting is
  stored (PR 2). The rule is one table with unit tests.
- **D4 When.** Every activation of a Mend workspace window. In sync costs a few remote reads; an
  executor's first open installs in the background behind a status item. The setting
  `mend.workspaces.bringMyEditor` takes `off | extensions | extensionsAndSettings` and is on by
  default.
- **D5 Isolation, option A.** Act only in a Mend alias window whose remote server runs as a person
  uid (40001 to 49999) with HOME `/home/m*`, and keeps its folder inside that HOME. Root and shared
  homes are refused, which turns the feature off for Kubernetes, nix, the first launch on an image
  and the root fallback. Yiannis chose this.
- **D6 Organization switch.** None in 0.36.

## What it does

`activate()` in `extension.ts` gains one line beside `claimPendingTakeover(context)`, and the API
object gains one field:

```ts
const editor = startWorkspaceEditor(context); // owns its disposables, item, channel, commands
claimPendingTakeover(context);
return { projects: …, workspaceEditor: () => editor.settled() };
```

`startWorkspaceEditor` decides everything else from the window it finds itself in:

- **A local window** captures the extension list now and on `extensions.onDidChange`.
- **A Mend workspace window** checks the remote, plans and installs in the background. In PR 2 it
  also restores and captures machine settings.
- **Any other window** does nothing and shows no item.

The acceptance suite, in the remote window, awaits `api.workspaceEditor()` before it writes
`remote.json`. The palette command `mend.bringMyEditor` re-runs the pass. Clicking the status item
opens the output channel **Mend: workspace editor**.

## How it works

### Data

There are three `globalState` records. Each has a `version: 1` field and is parsed on read, and a
malformed record reads as absent. Each record has one writer role.

| Key                                  | Content                                                                                                                                                     | Written by             | Synced                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------- |
| `mend.editor.localExtensions`        | `{id, version}` per local extension that could go remote                                                                                                    | local windows only     | no                    |
| `mend.editor.installMemory`          | `staysLocal["<editor>@<id>@<version>"]` (editor = `appName` + version + a digest of the person's `remote.extensionKind`), `missing["id"]` with a time stamp | Mend workspace windows | no                    |
| `mend.editor.machineSettings` (PR 2) | filtered settings map                                                                                                                                       | Mend workspace windows | yes, `setKeysForSync` |

- **Capture filter.** Capture drops built-ins (the extension path is under `env.appRoot`),
  `NEVER_INSTALL` (Remote-SSH's family and Mend itself), declarative extensions (no `main`) and
  extensions that declare `ui` first. It does not filter by the runtime `extensionKind`, because in
  a local window that is `ui` for every extension.
- **Product overrides.** VS Code's product.json overrides are not reimplemented. The install memory
  learns them instead: an id that installed "successfully" but never reached the remote
  `extensions.json` is recorded as `staysLocal` for that version and skipped afterwards.
- **Remote state is never cached.** It is read every pass, so there is no second copy to drift.
- **`RemoteProcess`** is `{uids, home, agentFolder}`, parsed from the two `/proc` files.
  `agentFolder` is `VSCODE_AGENT_FOLDER` as the server declares it, or absent. D5 decides whether it
  is usable (see Implementation reconciliation, fix round 1). The adapter discards every other
  environment variable and never logs `/proc` contents or setting values.
- **`EditorHome`** is the D5 result. Only the `person` variant carries the paths Mend may write, so
  code that holds a `shared` home has nothing to write to.
- **`MendWorkspace` and `PersonHome`** are classes with a private constructor _and_ an ES private
  field (`#brand`), which makes them nominal. TypeScript then rejects a structurally matching object
  literal. Only `MendWorkspace.parse` and `editorHomeOf` build them, so the alias rule can't be
  skipped, and no `as` cast is needed.
- **`EditorSyncState`** is a union with one variant per thing the person can see. `statusView` maps
  it to text, tooltip and command, so the redesign restyles one pure function.

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

### The pass, in a Mend workspace window

1. Parse the mode from `mend.workspaces.bringMyEditor` (application scope, so a repository can't
   turn it on). `off` stops here and shows no item.
2. Run `MendWorkspace.parse(windowRemoteAuthority())`. A non-Mend window stops here, with zero
   remote reads.
3. Read the two `/proc` files, then run `editorHomeOf`. A `shared` result shows
   `editor stays local · shared home` and stops.
4. Read `extensions.json`, then `planExtensions(local, remote, memory, now)`:
   - The plan installs local ids that are not on the remote, not `staysLocal` for that version, and
     not `missing` within 24 h.
   - A missing local record shows `no local list` ("open a local VS Code window once").
   - An in-sync open ends here, after three remote reads and no writes.
5. Install in the background, one at a time, with `runInstalls(plan, {install, sleep, signal})`:
   - The status item shows `installing extensions 3/12`.
   - Only transient failures are retried, after 1 s and then 4 s. A failure is classified by
     `classifyInstallFailure`, whose message matching sits in one function.
   - Other failures are named, and the remaining ids continue.
   - The run stops between ids when the setting turns off or the window closes.
6. After the run, read `extensions.json` again, polling for up to 3 s while ids that reported
   success are still absent. Then call `learn(memory, outcomes, remoteAfter, uiHost, now)`. That
   ends in `in sync` or in `not synced`, with each failure named in the channel. `learn` records
   `staysLocal` only with positive evidence:
   - the id is absent from the remote `extensions.json`; **and**
   - `vscode.extensions.getExtension(id)` is present in this window's UI host. The spike showed that
     the UI host of a remote window lists exactly the UI-routed extensions.

   An id that is absent but not in the UI host is `unresolved`. Nothing is cached for it, and it is
   retried on the next open.

`activate` never awaits the pass. The spike measured no change to window-ready or to the first
terminal.

### Machine settings (PR 2)

- **Restore only when the file is absent.** Every fresh executor has no Machine `settings.json`. The
  adapter writes the stored map to a sibling temporary file and renames it with `overwrite: false`,
  so the file is either whole or absent. An existing file is never replaced, and an unreadable one
  (invalid JSONC) is reported and left as it is.
- **PR 1 says what it lacks.** In PR 1, `extensionsAndSettings` behaves like `extensions`. The
  setting's description and the settled report state `machine settings: not in this build`.
- **Capture this window's deltas.** The baseline is the file as it stands after restore. On any
  `onDidChangeConfiguration` the adapter waits 1.5 s, re-reads the file, computes
  `deltaOf(baseline, now)`, folds it into the stored record with `applyDelta`, and moves the
  baseline. Event key names are ignored, because the spike saw unrelated keys.
- **Why deltas.** No window writes a snapshot, so two open workspaces never erase each other's keys.
  The restore's own write produces an empty delta.
- **The secret filter.** `SECRET_RULES` is one table, and every row carries the examples it must
  drop and the examples it must keep. The tests iterate the table. A secret-looking key, or a
  token-shaped nested string, turns the key into a removal, so an earlier clean value can't linger.
  Dropped key names, never values, go to the channel. The filter also runs when a synced record is
  read. Claude Opus reviews this table.
- **Parsing.** `jsonc-parser` parses the file, because VS Code writes comments and trailing commas.

### Interface depth

- **Public surface.** One function, `startWorkspaceEditor(context)`, which returns
  `{settled, dispose}`. Plus one setting, two commands (`mend.bringMyEditor` and
  `mend.showWorkspaceEditorLog`) and one API field.
- **Hidden behind it.** Authority parsing, `/proc` parsing, D5, the capture filter, the plan,
  retries, learning, JSONC, the secret filter, the status item and the channel.
- **Pure modules.** They take plain data and are unit-tested without a `vscode` mock.
- **Call chain.** `extension.ts` → `workspace-editor.ts` → one pure module.

### Module map

| File under `apps/vscode/src` | Kind                                                                                                                           | PR                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `editor-home.ts`             | pure: `MendWorkspace`, `parseRemoteProcess`, `editorHomeOf` (D5)                                                               | 1                      |
| `editor-extensions.ts`       | pure: records and parsers, capture filter, `NEVER_INSTALL`, `planExtensions`, `classifyInstallFailure`, `runInstalls`, `learn` | 1                      |
| `editor-status.ts`           | pure: `EditorSyncState`, `statusView`                                                                                          | 1 (PR 2 adds variants) |
| `workspace-editor.ts`        | the only file that imports `vscode`: capture, remote reads, the pass, item, channel, commands                                  | 1, extended in 2       |
| `editor-settings.ts`         | pure: `SECRET_RULES`, `parseMachineSettings`, `deltaOf`, `applyDelta`, `restoreText`                                           | 2                      |

Changes outside these files:

- `extension.ts`: the one line in `activate`, `workspaceEditor` on `MendExtensionApi`, and
  `windowRemoteAuthority` exported for reuse.
- `package.json`: the setting (enum `off | extensions | extensionsAndSettings`, default
  `extensionsAndSettings`, application scope) and the two commands. PR 2 adds `jsonc-parser`.

## Idempotence and races

- **The window closes mid-install.** Nothing records progress. The next pass reads the remote list
  and installs only what is still missing. `learn` runs only after a completed loop, so a cut-off
  run teaches nothing false.
- **Two Mend windows at once.** Different workspaces have different homes, so their plans are
  independent. The same workspace twice means two installs of one id, and VS Code treats the second
  as a no-op.
- **Concurrent `globalState` writers.** VS Code sends an extension's whole memento on each update,
  so two windows writing at the same instant can lose one update. The worst cases:
  - for `installMemory`, one extra no-op install later;
  - for `localExtensions`, nothing, because the next local activation recaptures it;
  - for `machineSettings`, one human-paced delta.

  This is accepted (see Tradeoffs). For machine settings, PR 2 adds one cheap repair: about 2 s
  after a capture write, the window checks that the stored record still holds its delta, and writes
  it again if not.

- **The local list changes.** The next pass replans. Plans only add, so Mend never uninstalls on the
  remote.
- **Capture races restore.** They can't interleave in one window, because capture is armed only
  after restore sets the baseline. Across windows, restore never overwrites and capture never
  snapshots.

## How to verify

**Unit tests** (vitest, pure modules):

- **`editor-home`:**
  - authorities: local, foreign host, Mend alias, a suffix after the alias;
  - `/proc` fixtures from the spike: uid 0 with `/root`, and 40001 with `/home/mm7l6bfej`;
  - environments with the agent folder absent and present, and one that escapes HOME;
  - uid edges at 40000, 40001, 49999 and 50000, unequal uid fields, and HOME `/home/other`.
- **`editor-extensions`:**
  - the capture filter table (built-in, declarative, declared `ui` first, `NEVER_INSTALL`);
  - the plan skips `staysLocal` for that version and a fresh `missing`, retries a `missing` older
    than 24 h, and gives the same plan for the same inputs;
  - `classifyInstallFailure` on the spike's `Failed to fetch` text;
  - `runInstalls` with a fake install and sleep: the retry sequence, giving up, abort between ids,
    and progress counts;
  - `learn` turns success-but-absent into `staysLocal` only with UI-host evidence, and otherwise
    into `unresolved`.
- **`editor-status`:** one `statusView` case per variant, including the two approved strings.
- **`editor-settings` (PR 2):**
  - every `SECRET_RULES` row's fixtures;
  - restore only when the file is absent;
  - `deltaOf` and `applyDelta`, including a removal, a secret turning into a removal, and two
    windows converging.

**Harness** (`scripts/vscode-remote-acceptance.mjs` and `apps/vscode/test/e2e/suite.ts`):

- **Person layout.** Apply the spike's patch: the fresh-worktree session runs before the editor
  suite, and step 3 ignores stopped sessions. The step 8 window then lands as `m<8>`.
- **Seeding.** Next to the Remote-SSH install, seed a workspace-kind id with a `main`
  (`editorconfig.editorconfig`) and a declarative UI id (a theme).
- **New step `remoteEditor`,** written before `remote.json`. It records `settled` state and
  `syncMs`. Then `sshIn cat <agentFolder>/extensions/extensions.json` must list the workspace id,
  and must not list the theme, `ms-vscode-remote.*` or `sealant-sh.mend`.
- **Warm pass.** A second `mend.bringMyEditor` must install nothing.
- **Timing.** `openStarted` before the open and `enteredAt` in the remote window give `firstOpenMs`.
  `terminal.ms` must stay under `FIRST_TERMINAL_BUDGET_MS`. Window-ready and first terminal are
  compared between main and the branch, with the same server version.
- **Evidence gate.** `remoteEditor` is added to `assertEditorEvidence` and its CI fixture.
- **PR 2.** The remote window writes a plain machine key and a `ghp_…`-valued key to its Machine
  file. A second person-layout window, on a fresh worktree, must hold the plain key and lack the
  secret key.

## Synthesis decision

There were four runners: Opus, Fable, Sonnet and Codex (GPT-6.1 Sol xhigh). The cross-judge was
Codex (see the appended verdict).

- **Base: Opus.** It had the clearest module map, the private-constructor `MendWorkspace`, an
  `EditorHome` whose shared variant carries no paths, `statusView`, install memory with a 24 h
  "missing" window, and the delta capture.
- **From Fable:**
  - `VSCODE_AGENT_FOLDER` instead of guessing the server path;
  - restore only when the file is absent, with a temporary file plus rename;
  - learning routing from a re-read instead of reimplementing VS Code's product.json kind table
    (Opus's `routeOf` precedence chain was dropped);
  - `settled()` as the suite's hook.
- **From Sonnet:**
  - `runInstalls` with the install function and sleep injected, so the retry policy is unit-tested;
  - `SECRET_RULES` rows that carry their own drop and keep examples;
  - the activation that returns before installs.
- **From Codex:**
  - all four uid fields must be equal;
  - an exact HOME pattern;
  - an agent folder confined to HOME;
  - never logging the environment or setting values;
  - application scope for the setting;
  - capture must not filter by runtime `extensionKind`;
  - the guard that keeps the feature off when Mend runs in the remote host;
  - the whole-memento race named as a risk.
- **Rejected from Codex:** the immutable capture-batch outbox with logical clocks, and moving
  takeover storage. They answer the narrow whole-memento race at the price of a new storage layer
  and a takeover rewrite, outside this feature.

### Cross-judge verdict and how it was used

The Codex judge scored the candidates Codex 22, Sonnet 20, Opus 19 and Fable 19 out of 30, and
recommended Codex as the base. I kept the Opus-based synthesis. The judge itself scored Codex 2/5 on
interface depth. Its immutable outbox, logical clocks, compaction and takeover migration roughly
double PR 1 to answer a millisecond-scale race whose worst case here is one extra no-op install, or
one lost machine-settings delta.

These judge findings were valid and are folded in above:

- learning `staysLocal` needs positive UI-host evidence and a propagation wait;
- private constructors need a private field to be nominal;
- the remote create must be `overwrite: false`;
- PR 1 must report `machine settings: not in this build`;
- the whole-memento race must be named, not denied.

The judge also found a factual error, in Sonnet's design: reopening a window against a live executor
keeps its files. This design re-reads remote state on every pass, so it is not affected.

## Known limits

- **Machine settings are not in this build.** PR 1 ships extensions only. With
  `extensionsAndSettings` (the default) it behaves like `extensions`, and the setting's description,
  the settled report and the channel say `machine settings: not in this build`. PR 2 adds them.
- **Files are not copied.** An extension installed from a VSIX or another file is not synced; the
  channel names it `installed from a file, not synced` (D2).
- **Installs are sequential.** 41 ids take roughly 50 to 95 s, in the background.

Tradeoffs accepted:

- We accept learning routing (one 0.2 to 0.7 s no-op per UI-routed id, per version, per machine) in
  exchange for not copying VS Code's private routing table.
- We accept additive-only plans, so an extension removed locally stays on the remote until the
  executor ends. In exchange, no race can ever uninstall anything.
- We accept that a concurrent `globalState` write can lose one update (an extra no-op, or one
  machine-settings delta) in exchange for no new storage layer.
- We accept "restore only when absent", so a Machine file that already exists wins for that
  executor, in exchange for never overwriting what the person sees.
- We accept a `no local list` state for someone who never opened a local window.
- We accept that D5 turns the feature off for shared, root, Kubernetes, nix and first-launch homes.
  Yiannis chose this.

## Alternatives considered

- **`remote.defaultExtensionsIfInstalledLocally` written by Mend.** VS Code would install on
  connect, but with no progress, no retry, no skip names, and the id list exposed as a setting the
  person edits. It also acts on every remote, not just Mend's. That interface is shallower and
  leakier.
- **Reading the local extensions folder from the remote window.** That folder can't show enablement,
  so disabled extensions would install. It would also add a second capture path.
- **Snapshot capture of settings.** Two open workspaces would erase each other's keys, and a stale
  window would bring back deleted keys.
- **Syncing in `openNamedWorkspace` before the window opens.** Opens from the recent list, a reload,
  or the harness bypass that path, and the remote is not connected yet.

## Open questions and risks

- Does `installExtension` resolve before the remote `extensions.json` is updated? If so, `learn`
  could mark a slow install `staysLocal`. Mitigation: re-read once after 1 s before learning.
- Installs are sequential: 41 ids take roughly 50 to 95 s, in the background. Running two at a time
  is a later tuning step, measured first.
- What text does the gallery send when an id is not found? Until the harness records it, an unknown
  failure is treated as `failed`, so it is retried on the next open.

## Implementation reconciliation (PR 1)

PR 1 follows this design. These points differ from it or settle what it left open:

- **Where the D5 rule sits.** The rule is in `PersonHome.of`, because only the class itself can call
  its private constructor. `editorHomeOf` is the exported entry, and it only delegates. The rule is
  still one function with one test table.
- **The nominal field.** The ES private field that makes `MendWorkspace` and `PersonHome` nominal
  holds real data (`#authority`, `#agentFolder`) behind a getter. An unused `#brand` is refused by
  the linter. A `@ts-expect-error` test fails the typecheck if an object literal ever passes for
  either class.
- **The alias.** `@mend/workspace-ssh` exports `isWorkspaceSshAlias`. It accepts only the shape that
  `parseWorkspaceSshTarget` writes, `mend-ws-<label>-<24 hex>`.
- **A stopped run is a type.** `runInstalls` returns `{kind: "completed" | "stopped", outcomes}`.
  `learn` takes only the completed variant, so a cut-off run cannot teach anything.
- **`windowRemoteAuthority`** moved from `extension.ts` into `workspace-editor.ts`, which exports
  it. `extension.ts` imports it from there, because exporting it from `extension.ts` would have made
  an import cycle.
- **The status item's click.** `statusView` sends `extensions not synced · Sync` to
  `mend.bringMyEditor`, so the click does what the text says. Every other state opens the log. The
  texts carry no codicon.
- **`mend.bringMyEditor` returns the pass's report.** The report holds `state`, `planned`,
  `results`, `syncMs` and `machineSettings`. The acceptance suite's warm pass reads it from the
  command. `startWorkspaceEditor` adds itself to `context.subscriptions`.
- **Not-found text.** `classifyInstallFailure` treats two strings from VS Code 1.139.1 as `missing`:
  `Extension '{0}' not found.` and
  `The extension '{0}' cannot be installed because it was not found.` Both come from the bundle's
  `nls.messages.json`. `Manifest is not found` stays `failed`.
- **Timeouts.** A remote read gives up after 20 s and an install after 120 s. A timed-out install is
  `failed`, not transient, so one hung id costs one wait, not three.
- **Harness.**
  - The suite reads the remote list at `~/.vscode-server/extensions/extensions.json`, because an SSH
    shell has no `VSCODE_AGENT_FOLDER`. The spike saw both paths equal.
  - The uid comes from `id -u` over SSH, not from the extension.
  - The seeded theme is `dracula-theme.theme-dracula`. The harness fails if either fixture changes
    shape: the theme gains a `main`, or `editorconfig.editorconfig` loses it.
  - The fresh-worktree session is the named step `runFreshWorktreeSession`. The suite's step 3
    excludes exactly that session (`MEND_E2E_PRIOR_SESSION`), not every stopped one.
  - `MEND_E2E_EDITOR=off` runs with the setting off. `MEND_E2E_EVIDENCE` copies the result files out
    before cleanup.

### Measured (PR 1)

Four person-layout runs on 0.36.0-next.792 and VS Code 1.139.1, with the load average near 2,
alternating the setting: on, off, on, off. Window-ready is `firstOpenMs`, from `vscode.openFolder`
to the remote window's suite entry.

| Run  | Setting | Window-ready | First terminal | Settled                                   |
| ---- | ------- | ------------ | -------------- | ----------------------------------------- |
| on1  | on      | 17 225 ms    | 694 ms         | installed 1 in 2 487 ms; warm pass 128 ms |
| off1 | off     | 17 488 ms    | 665 ms         | inactive                                  |
| on2  | on      | 17 249 ms    | 622 ms         | installed 1 in 2 458 ms; warm pass 118 ms |
| off2 | off     | 19 009 ms    | 604 ms         | inactive                                  |

The two sides overlap on both measures, so two runs per side show no measurable difference.
Window-ready cannot move with the feature: the pass starts at `onStartupFinished`, after the window
is up. The first terminal runs while editorconfig installs, which is the case that could cost.

### Fix round 1 (PR 1)

The review of PR 1 changed these points:

- **A server folder outside HOME.** When `VSCODE_AGENT_FOLDER` is set and is not inside HOME, the
  home is not a person home, and Mend installs nothing. Before, Mend read `<home>/.vscode-server`
  instead, while installs went to the folder the server really uses. The check is in
  `PersonHome.of`, so a `PersonHome` cannot exist without it. The window shows the shared-home
  state, because the server keeps its extensions outside the person's home.
- **A forged `PersonHome`.** An object made with `Object.create(PersonHome.prototype)` throws on
  `extensionsJson`, because it lacks the private field. A test holds this, and the same for
  `MendWorkspace.authority`.
- **What a window must be.** `MendWorkspace.ofWindow` needs `env.remoteName` to be `ssh-remote` and
  every `vscode-remote` folder to share one authority. A multi-root window across two hosts is not a
  Mend window. `windowRemoteAuthority`, which takeover uses, is unchanged.
- **The `Uid:` line.** It must have exactly four numeric fields. A non-numeric field refuses the
  line instead of being dropped.
- **An unknown setting value** reads as `off`. An unset setting still gets the manifest default.
- **Install errors are never logged or returned as text.** An error message can name a path under
  the person's home. The channel and the report name the extension id and a class: `transient`,
  `missing`, `refused by policy`, `timed out`, `failed` or `different publisher`. A timeout is the
  `TimedOut` error class, not a message. `refused by policy` matches VS Code 1.139.1's allowed-list,
  "not allowed", "reported to be problematic" and "contact your administrator" texts. A file read
  logs its `FileSystemError` code or `timed out`.
- **Abort before every attempt.** `runInstalls` checks the signal before each install call,
  including a retry after its wait. An abort during a retry's wait ends the run as `stopped` with no
  second call.
- **The settled state is a comparison.** After installs, or when the plan is empty, the pass
  compares the whole local list with the remote list (`notInWorkspace`). An id the plan skipped
  because the gallery had no such extension within a day stays `not synced`. Before, an empty plan
  settled `in sync`. The tooltip names up to five ids, and the channel names each with its reason.
  `planExtensions` returns `{install, recentlyMissing}` so the pass can say why an id was skipped.
- **Gallery provenance.** A local window reads `extensions.json` in the folder of each captured
  extension (the folder of its `extensionPath`, so a development copy of Mend does not matter).
  - An entry with `metadata.source` `gallery` and an `identifier.uuid` keeps that uuid and its
    folder in the record.
  - An entry with any other source (`vsix`, `resource`) is left out and listed in `fromFile`. The
    remote pass names it in the channel: `installed from a file, not synced`.
  - An entry without a source, an unreadable file, or no entry at all keeps the extension with no
    uuid, so a non-default profile, whose list lives elsewhere, still syncs.
  - After an install, an id whose remote entry records another uuid is `failed` with the class
    `different publisher`, and the comparison counts it as not in the workspace on later passes too.
    A remote entry's uuid is its `identifier.uuid`, or its `metadata.id` when the identifier has
    none. VS Code 1.139.1's server records a gallery install that way: the harness saw
    `source: gallery`, no `identifier.uuid`, and a `metadata.id` equal to the local uuid. The first
    run of this round read only `identifier.uuid` and failed with a false `different publisher`. An
    entry with neither counts as present. Mend still installs by id, at the latest version (D2).
- **A stale local list.** A remote window reads each recorded folder's local `extensions.json`
  again, and drops a uuid-carrying id that the folder no longer lists. An unreadable folder keeps
  the stored list. Fix round 2 also moves an id the folder now records as a file install.
- **Harness.** The run fails unless the seeded `editorconfig.editorconfig` is recorded locally as a
  gallery install with a uuid, and unless its remote entry carries the same uuid.
  `remoteEditor.seededRemoteEntry` records that entry's uuid, source and `metadata.id`.

### Fix round 2 (PR 1)

The second review's three items:

- **A gallery extension replaced by a file install.** `pruneUninstalled` reads each recorded
  folder's current `extensions.json`. An id that the folder now records with a non-gallery source
  leaves the desired list and joins `fromFile`, so the remote pass names it
  `installed from a file, not synced` instead of installing the gallery version. Before, the cached
  gallery entry stayed and the gallery version was installed.
- **A `Uid:` line with five fields** (four numeric and one not) is refused, and a test holds it.
- **The settled state is one pure function.** `settledState` in `editor-status.ts` turns the local
  list, the remote list, the install memory and the results into the state the pass reports. A test
  holds that a gallery miss remembered within the day plans nothing and settles `not synced`, naming
  the id.

Four person-layout runs at `16694787e`, on 0.36.0-next.792 and VS Code 1.139.1, sequential and
alternating. The load average is the 1-minute figure at each run's start; other work shared the
machine.

| Run  | Setting | Load | Window-ready | First terminal | Settled                                   |
| ---- | ------- | ---- | ------------ | -------------- | ----------------------------------------- |
| on1  | on      | 8.9  | 21 652 ms    | 614 ms         | installed 1 in 2 292 ms; warm pass 117 ms |
| off1 | off     | 19.7 | 18 765 ms    | 576 ms         | inactive                                  |
| on2  | on      | 6.4  | 16 270 ms    | 645 ms         | installed 1 in 2 465 ms; warm pass 165 ms |
| off2 | off     | 7.0  | 16 844 ms    | 675 ms         | inactive                                  |

Every run landed as uid 40001. In both runs with the setting on, the workspace listed
`editorconfig.editorconfig` with the local gallery uuid and not the theme, and the warm pass planned
nothing. The two sides overlap again, and every first terminal is far under the 10 s budget.

## Next implementation step

PR 2: `editor-settings.ts` and the machine-settings half of the pass, as specified above.
