# One model picker, the server owns the list

- **Release:** 0.36
- **Status:** on main. Every PR below is merged.
- **PRs:** mend#454 (current model lists, Claude by alias, efforts per model), mend#479 (the server
  owns the catalog; one picker; every client shows the running model), mend#505 (opencode's catalog
  rows, migration 0109, "opencode's own choice" in VS Code).
- **Decision records:** no ADR. `docs/models-audit.md` holds the audit and the ten decisions this
  spec follows.
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`.

## Why it exists

Before 0.36 each client kept its own model list (`HARNESS_MODELS` in the domain, a hand-kept copy on
the phone), the lists were stale (Fable 5, Opus 5, retired `gpt-5.4`), and clients disagreed on what
"no choice" meant: the web and desktop preselected the catalog default and sent it; the phone, the
CLI, VS Code and Slack sent nothing and the harness decided. The same harness started from two
clients could run on different models, and no session recorded which. The Claude seed also wrote
`claude-fable-5` as every session's default.

ROADMAP 0.36 Must 5: "The phone needs a working model choice now, and models in general need UX work
… Then one model picker, the same on every client." Who hits it: everyone who starts a session,
every day. Cost: a session on a model nobody chose, a phone that could not pick at all, an app
release for every new model.

## What it does

- The server keeps one model list per harness in the `harness_models` table and serves it at
  `GET /api/harnesses/models`. No client carries a model id of its own.
- Every picker preselects the server's default for the harness, lists the models by label with the
  id beside them (`default` beside the default), and offers only the efforts the selected model
  takes, `default` first.
- What the picker shows is what the launch sends. The server resolves the request's model, else the
  model the session was started with, else the harness's default, clamps the effort to what that
  model takes, composes the argv and records `model` and `effort` on the session.
- Every client shows the model a session runs on beside its harness: `claude · fable` in the web
  worktree tree, `fable · high · …` on the web session page, the phone's rows and header, the
  desktop terminal pane's tab bar, `mend sessions` (`… · base main · fable · high`).
- `mend models` prints the list:

  ```
  claude  effort low … max
    fable   Fable · latest  default
    opus    Opus · latest
    ...
  codex  effort low … ultra · --fast
    gpt-6.1-sol  GPT-6.1 Sol  default
    gpt-6-luna   GPT-6 Luna   effort low … max
    gpt-5.5      GPT-5.5      effort low … xhigh
  opencode  effort none
    openai/gpt-6.1-sol  GPT-6.1 Sol
    ...
  ```

  `mend models --json` prints `{ "version": 1, "harnesses": [...] }`.

- **opencode's own choice.** opencode's catalog lists eight `openai/…` models and has no default.
  With nothing chosen, Mend sends no `--model` and records `model: null`, so the project's or the
  person's opencode config decides, then the model opencode last used (seeded to
  `openai/gpt-6.1-sol` when it has none). On each client:
  - web and desktop: the model pill reads `model`, no row is selected, and nothing is sent until a
    row is picked;
  - VS Code: the model pick leads with `opencode's own choice` (`default · its own config decides`),
    which sends no model; a plain Enter takes it;
  - CLI: no `--model`, nothing sent;
  - phone, Slack, t3 gateway: cannot start opencode.
- pi has no catalog rows. Pickers show no model control for pi; they offer pi's efforts
  (`low … max`), sent as `--thinking`.

**Defaults.**

| Harness  | Default                  | Efforts the harness takes                       |
| -------- | ------------------------ | ----------------------------------------------- |
| claude   | `fable` (Fable · latest) | low, medium, high, xhigh, max                   |
| codex    | `gpt-6.1-sol`            | low … ultra; Luna rows to max, GPT-5.5 to xhigh |
| opencode | none (opencode decides)  | none                                            |
| pi       | no catalog               | low … max                                       |

An operator changes the list by editing `harness_models` rows (label, `is_default`, `efforts`,
`position`); there is no write route. A flagged row is the default; otherwise the first row, except
for a harness in `HARNESSES_CHOOSING_THEIR_OWN_MODEL` (opencode), which then has none.

**In scope.**

- The table, its seed (0102, 0109), the list route, server-side resolution and recording.
- The headless picker in the domain and every client that draws it: web composer, desktop launcher,
  phone start sheet, VS Code quick picks, CLI flags and `mend models`, the t3 gateway's provider
  list.
- Showing the running model on every client.
- Follow-ups, resumes and handoffs keeping or clearing the recorded model.
- Claude's seed default (`fable`) and the move from Mend's own earlier `claude-fable-5`.

**Out of scope.**

- A write route or settings page for the catalog.
- Discovering models from the harness binaries.
- Slack reading the live catalog (it reads the seed).
- Changing a running session's model. A session keeps the model it launched with; a model picked
  inside the harness (`/model`) is not recorded.
- A per-project default model.
- A default effort: `null` is the harness's own and Mend never second-guesses it.
- Backfilling `model` on sessions from before migration 0102.

## How it works

### The table and the route

1. Migration `0102_harness_models` (`packages/db/src/migrations.ts:2840`) creates
   `harness_models (harness, id, label, is_default, efforts jsonb, position, updated_at)`, primary
   key `(harness, id)`, and a partial unique index
   `harness_models_one_default_idx (harness) WHERE is_default`: at most one default per harness. It
   seeds claude (4 aliases, `fable` default) and codex (8 models, `gpt-6.1-sol` default, three with
   fewer efforts), and adds `agent_sessions.model text` and `agent_sessions.effort text`.
2. Migration `0109_opencode_models` (`migrations.ts:3002`) inserts eight opencode rows, none
   default, `ON CONFLICT (harness, id) DO NOTHING`, so an operator's own rows and default stay. It
   must run after 0108; Effect's Migrator skips ids at or below the latest applied.
3. `HARNESS_MODEL_SEED` (`packages/domain/src/workbench/harness-launch.ts:88`) mirrors both
   migrations; it is the seed's record and Slack's offline vocabulary, never a picker's list.
4. `HarnessModelsRepo` (`packages/db/src/repos/harness-models.ts`): `list()` returns every harness
   that has rows, alphabetically, models by `position` then `id`; `forHarness(h)` returns an empty
   catalog for a harness with no rows. Each catalog is built by `harnessModelCatalog`
   (`packages/domain/src/workbench/model-catalog.ts:66`): `defaultModel` is the flagged row, else
   the first, else null; for opencode only the flagged row. `efforts` is `HARNESS_EFFORTS[harness]`
   (`harness-launch.ts:22`); `fastCapable` is codex only.
5. `GET /api/harnesses/models` (`packages/api-contracts/src/harness-models.ts`,
   `apps/api/src/routes/harness-models.ts`) answers `HarnessModelCatalog[]` to any signed-in
   account. The list is a fact about the machine, the same for every person and project.

### The headless picker (`model-catalog.ts`)

6. `modelPicker(catalog, choice)` (line 182): the effective model is the sticky choice when the
   catalog still lists it, else `defaultModel`; the effort is clamped (`clampEffort`, line 101) to
   what that model takes, or the highest it takes, or null. It returns the rows (`isDefault` on the
   row equal to `defaultModel`, `selected` on the effective one), the efforts (`default` first),
   `modelLabel` (the label, the id when unlisted, the word `model` when there is no model),
   `hasModels` and `fastCapable`.
7. `pendingModelPicker` (line 219): before the catalog answers, or when the request failed, nothing
   is listed and the sticky choice passes through unchanged; the server resolves the rest.
8. `modelPickerFor(catalogs, harness, choice)` (line 244): `undefined` catalogs is pending; a list
   without the harness is an empty catalog.
9. `pickerLaunchFields` (line 258): a null model or effort stays off the wire.

### Resolution and recording on the server

10. PTY and protocol launches through `POST /sessions/:id/launch`: `SessionStart.launchAs`
    (`apps/api/src/session-start.ts:205`). For a structured start, `resolveLaunchOptions`
    (`model-catalog.ts:129`) takes `request.model ?? session.model`, else `catalog.defaultModel`; a
    model the catalog does not list passes through as named; the effort is
    `request.effort ?? session.effort`, clamped. A verbatim `argv` resolves nothing and records
    `{model: null, effort: null}`.
11. PTY: `sessions.setLaunchOptions` runs inside the account's launch slot, right before
    `engine.launch` (`session-start.ts:296-298`). The argv is `composeLaunchArgv`
    (`harness-launch.ts:178`): claude `--model`/`--effort`; codex `--model`,
    `-c model_reasoning_effort=…`, `-c service_tier=priority` for fast; opencode `--model`; pi
    `--model`/`--thinking`.
12. Protocol: `SessionEngine.launchProtocol` (`packages/sessions/src/engine.ts:12200`) records after
    its live-agent check and after `composeProtocolArgv` accepts the harness
    (`engine.ts:12258-12261`). A continuation that names neither model nor effort takes the
    session's. Model and effort ride each provider turn, not the process argv (Codex app-server).
13. Handoff to a conversation (`apps/api/src/routes/workbench.ts:3019`) resolves like a launch:
    `payload.model ?? session.model`, else the default. A handoff to a terminal resolves nothing and
    resumes natively on the conversation's own model.
14. Follow-up to a stopped PTY session: `promptArgv` (`engine.ts:488`) opens the harness on
    `session.model` and `session.effort` (an effort the harness does not take is left out).
15. Resume on the same harness passes no model flag and leaves the row alone. Resume on another
    harness clears the row (`sessions.setLaunchOptions(sessionId, {model: null, effort: null})`,
    `engine.ts:13242`).
16. The Claude seed (`packages/sessions/src/harness-seeds.ts:56`) sets `model: "fable"` in
    `~/.claude/settings.json` only when no model is set or it is Mend's own earlier
    `claude-fable-5`.

### Clients

17. **Web.** `useHarnessCatalogs` (`apps/web/src/lib/harness-models.ts`, tRPC `harnesses.models`, 60
    s stale, no retry). Composer: `apps/web/src/components/session-composer.tsx:76` builds the
    picker from the sticky prefs (`apps/web/src/lib/composer-prefs.ts`, localStorage key
    `mend-composer-prefs`, per project and harness); the model pill shows only when `hasModels`;
    `ModelMenu` and `EffortMenu` from `packages/ui/src/components/model-picker.tsx`; submit sends
    `pickerLaunchFields(picker)` (line 98). Quick-start from a project menu sends no model
    (`apps/web/src/lib/workbench-menus.ts:44`); the server applies the default. Display:
    `sessionModelLine(null, session)` on the session page (`routes/sessions.$sessionId.tsx:220`),
    `harness · model` in the worktree tree (`components/project-detail/worktree-tree.tsx:138`).
18. **Desktop.** `harnessModelsQuery` (`apps/desktop/src/renderer/src/lib/queries.ts:47`); the
    launcher (`components/launcher.tsx:133`) draws the same menus and sends
    `pickerLaunchFields(picker)` (line 219), speed only when fast-capable. The terminal pane shows
    `session.model` (`components/terminal-pane.tsx:302`).
19. **Phone.** `useHarnessModels` (`apps/mobile/src/data/live.ts:572`), query key
    `["harness-models", serverUrl]`, so a phone paired with another machine never shows the first
    machine's list. Sticky choice per harness on device (`apps/mobile/src/data/harness-options.ts`,
    AsyncStorage `mend-launch-options`). `start-session.tsx` draws chips for claude and codex only
    (`PROTOCOL_HARNESSES`), model chips when `hasModels`, thinking chips when more than `default`;
    the row summary is the model label (or `harness default`), then effort and `fast`. It sends the
    picker's effective model and effort, never a raw sticky value (`start-session.tsx:118`,
    `live.ts:829-834`). Rows show `dto.model` (`live.ts:495`).
20. **CLI.** `mend <harness> [--model <id>] [--effort <level>] [--fast] [--ask]` sends a structured
    start with only the flags given (`apps/cli/src/main.ts:899-905`); `--effort` is checked against
    the six levels locally (`apps/cli/src/shared.ts:190`). The dashboard sends `{}`
    (`apps/cli/src/dashboard.tsx:1039`, `1262`). `mend models` (`apps/cli/src/models.ts`,
    `main.ts:4353`). `mend sessions` prints `· model · effort` (`main.ts:4342-4345`).
21. **VS Code.** `apps/vscode/src/extension.ts:670` `newSessionAdvanced`: harness pick (claude,
    codex, opencode, pi), then the catalog (`client.harnessModels()`, a failure reads as empty),
    then the model pick only when `hasModels`, rows from `modelPickRows`
    (`apps/vscode/src/model-picks.ts:17`): the default first; for a catalog with no default, a first
    row `<harness>'s own choice` with `model: null`. Then the thinking pick when the chosen model
    takes any effort. Escape at any pick aborts the start.
22. **t3 gateway.** `providersFromMend` (`apps/t3-gateway/src/server-config.ts`) maps the claude and
    codex catalogs to t3code providers: each model's efforts become a `Reasoning` select, codex gets
    `Service Tier`, the default row is `isDefault`, and `requiresNewThreadForModelChange: true`.
    opencode and pi are left out.
23. **Slack.** `DEFAULT_MENTION_VOCABULARY` (`packages/slack/src/mention.ts:82`) recognises the
    seed's claude and codex ids (plus `opus`, `sonnet`, `haiku`) for `with <model>`; an unknown
    model passes through as text. Slack starts through `SessionStart.startAs`, so its launches
    resolve and record like any other.

### Ordering and restart

- The record is written once the launch is admitted (PTY: inside the launch slot; protocol: after
  the engine's own check). A launch the slot refuses records nothing.
- A server restart does not change a session's recorded model. The catalog is read per request;
  nothing is cached server-side.
- Clients cache the list for 60 s (web, desktop, phone).

## Happy path

1. Alice opens the web app on the box and types "fix the flaky retry test" in the Now composer. The
   harness pill reads `claude`, the model pill `Fable · latest`. She opens the model menu: four
   rows, `fable · default` beside the first, checked. She picks `Opus · latest`; the pill now reads
   `Opus · latest`. She opens settings, picks `high` under Thinking, presses Start.
2. The session page header reads `claude — …` with `opus · high` on the model line. The worktree
   tree row reads `claude · opus`. `mend sessions` on her laptop prints
   `claude  3fa1c2d9  running  api  mend/fix-flaky · base main · opus · high`.
3. Next time she opens the composer for that project the model pill still reads `Opus · latest`
   (sticky per project and harness).
4. Bob, on his phone, opens Start session in the same project, expands `codex`: the summary reads
   `GPT-6.1 Sol`, the `default` chip note beside it. He taps `GPT-6 Luna`; the thinking chips are
   `default low medium high xhigh max` (no `ultra`). He taps `max`, Start. His session row reads
   `Codex` with `gpt-6-luna`.
5. The operator adds a row `('codex','gpt-6.2-sol','GPT-6.2 Sol',false,NULL,8)` with SQL. Within a
   minute every client lists it. Nobody's default changes.
6. Alice starts opencode from VS Code: at "Model" the first row is `opencode's own choice`
   (`default · its own config decides`). She presses Enter. The launch carries no model; the session
   records `model: null`; `mend sessions` shows no model for it; her repository's `opencode.json`,
   which names `anthropic/claude-…`, decides.

## Invariants

1. No client sends a model id it did not read from the server's catalog, except a model the person
   typed (CLI `--model`, Slack `with <model>`) or a sticky id the catalog still lists.
2. A launch that names no model runs the catalog default, and the session records it, for every
   harness that has a default.
3. A launch of opencode that names no model sends no `--model` and records `model: null`, unless an
   operator flagged an opencode row.
4. The recorded `model`/`effort` is what the composed argv (PTY) or the protocol turns carry for
   that launch.
5. An effort sent to a harness or model that does not take it never fails a launch: it becomes the
   highest effort the model takes, or nothing (opencode).
6. At most one default per harness (`harness_models_one_default_idx`).
7. A sticky choice the catalog no longer lists reads as the default; it is never sent.
8. While the catalog is loading or unavailable, a client sends only what the person chose, never a
   default of its own.
9. A native resume on the same harness never rewrites the recorded model; a resume on another
   harness sets it to null.
10. A refused launch (launch slot, unsupported protocol harness) does not change the record.
11. The catalog is the same for every signed-in account; it reveals nothing about any person.
12. Migration 0109 never changes an operator's existing rows or default.

## Edge cases and failure behaviour

**Concurrent actions**

- Two PTY launches of one session both pass the account budget: the second fails `session_starting`,
  but the row may report the second's model while the first one runs. Known, in
  `docs/models-audit.md` "Not done".
- The operator changes the default while a client holds a 60 s cached list: the client preselects
  the old default and sends it explicitly; the session records that model.

**Restarts and partial failures**

- The list route fails (server older than 0.36, network): pickers fall back to `pendingModelPicker`;
  the web and desktop pills disappear; the phone's summary reads `harness default` for a harness
  with no sticky model; VS Code asks no model. The server resolves the default at launch.
- A protocol launch whose workspace later fails to build keeps the record it wrote; the session
  failed on that model.

**Odd input**

- `--model` the catalog does not list: sent as given, recorded as given, the session line shows the
  id. The harness may refuse it.
- `--effort ultra` to claude: recorded and sent as `max`. To opencode: dropped, recorded null.
- `--effort` outside the six levels: the CLI refuses before sending
  (`--effort must be one of low, medium, high, xhigh, max, ultra`); the API contract refuses it too.
- A prompt starting with `-`: web, desktop and VS Code refuse it before sending.
- An operator row whose `efforts` holds a value outside the effort scale: `toModel` constructs a
  `HarnessModel`, whose schema refuses it; `GET /harnesses/models` fails for everyone and every
  launch's `forHarness` for that harness dies.
- An operator flags a second default for one harness: the unique index refuses the write.

**Older data**

- Sessions from before 0102: `model: null`, shown with no model. Their process rows still hold
  `protocolOptions` or `argv`.
- A web or desktop sticky model saved before 0.36 that the catalog no longer lists
  (`claude-fable-5`, `gpt-5.4`): read as the default.
- A Claude session whose restored `settings.json` names `claude-fable-5`: the seed moves it to
  `fable`. Any other model is kept.

**Permissions**

- Any signed-in account reads the list. Starting a session needs project access. A handoff and a
  terminal resume are owner-only (ADR 0013); a steerer's conversation turn runs on the recorded
  model.
- Operator: edits the table with SQL; no route.

**Every client**

- Web: composer and quick-start; pill hidden when the harness has no models; effort menu always.
- Desktop: same menus; speed sent only when fast-capable.
- Phone: claude and codex only; chips; per-server list.
- CLI: free text, validated effort; `mend models`.
- VS Code: quick picks; opencode's own choice row; Escape aborts.
- Slack: seed vocabulary, live resolution on the server.
- t3 gateway: claude and codex providers; a new thread for a model change.

## Known limits

From `docs/models-audit.md` "Not done":

- No write route or settings page; the operator edits the table.
- Slack's vocabulary reads the seed.
- No discovery from the harness binaries.
- The PTY record can disagree with the running process under two concurrent launches of one session.
- A protocol launch whose later steps fail keeps the record it wrote.

Also:

- A model changed inside the harness (`/model` in Claude Code, a pick inside opencode) is not
  recorded; the row keeps the launch's.
- opencode's labels are the Codex labels; the ids differ (`openai/…`).
- pi has no catalog; `mend pi --model <id>` passes through.

## How to verify

**Tests.**

- `packages/domain/src/workbench/model-catalog.test.ts`: defaults, efforts per model, resolution,
  clamps, the picker (preselect, sticky, unlisted sticky, hidden control, loading pass-through),
  opencode's missing default, `sessionModelLine`.
- `apps/api/src/routes/harness-models.test.ts`: the list route.
- `apps/api/src/session-start.test.ts:274-380`: a named model with a clamped effort; relaunch on the
  session's model; the default composed and recorded once admitted; opencode gets no model; verbatim
  argv records null.
- `packages/sessions/test/engine.test.ts`: `launchProtocol` records the model.
- `packages/db/test/migrations.test.ts`: 0109 lists opencode's models with no default and keeps an
  operator's rows.
- `apps/cli/src/models.test.ts`, `apps/vscode/src/model-picks.test.ts`, mobile route and wire-shape
  pins, `packages/sessions/src/harness-seeds.test.ts:76` (Claude default move).
- Not covered: the web and desktop composers' rendered menus (no component tests found); the phone's
  chips; the t3 gateway provider mapping against a live catalog.

**By hand on the box.**

```sh
mend models
mend models --json | jq '.harnesses[] | {harness, defaultModel}'
mend claude "say hi" -d && mend sessions          # · fable
mend codex "say hi" --model gpt-6-luna --effort ultra -d && mend sessions   # · gpt-6-luna · max
mend opencode "say hi" -d && mend sessions        # no model
psql "$DATABASE_URL" -c "select harness,id,is_default,position from harness_models order by 1,5"
```

**Signals.** The session line (`model · effort`), `agent_sessions.model` and `.effort`, the process
row's `argv` or `protocol_options`.

## Divergences found while writing

- `packages/ui/src/components/model-picker.tsx:78` (`ModelMenu`) with
  `apps/web/src/components/session-composer.tsx:269-277` and
  `apps/desktop/src/renderer/src/components/launcher.tsx:364`: no row for "opencode's own choice".
  Once a person picks an opencode model on the web or desktop, the sticky pref keeps sending
  `--model` and there is no way back short of clearing local storage. VS Code has the row
  (`model-picks.ts:28-36`).
- `packages/domain/src/workbench/model-catalog.ts:192`: with no model, the pill reads the word
  `model`, not that opencode decides. The phone's summary has `harness default` for the same case
  (`apps/mobile/src/components/start-session.tsx:82`); the two clients word it differently.
- `apps/cli/src/models.ts:44-71`: `mend models` marks no row `default` for opencode and says nothing
  about a launch without `--model` leaving the choice to opencode. pi is never printed, since
  `HarnessModelsRepo.list` returns only harnesses with rows, so
  `no models listed · the harness picks` (line 69) cannot appear.
- `packages/api-contracts/src/project-environment.ts:445-448`: `LaunchRequest.model` says "Absent
  runs the harness's default from the server's catalog"; opencode has none.
- `packages/db/src/repos/harness-models.ts:16`: says migration 0101 seeds the table; it is 0102
  (0101 is `secret_files`). mend#479's description says 0101 as well.
- `docs/models-audit.md` decision 3: "The composed argv always names the model for a harness that
  has a catalog". opencode has a catalog and is the exception, stated later in the same paragraph.
- `apps/web/src/components/session-composer.tsx:100`: sends `speed` for any harness when the sticky
  pref holds one; the desktop sends it only when `fastCapable` (`launcher.tsx:221`). Harmless:
  `composeLaunchArgv` reads speed for codex only. The two composers differ.
- `apps/web/src/routes/sessions.$sessionId.tsx:220`: `sessionModelLine(null, session)` shows the id,
  not the label, though the catalog is at hand in the app. The worktree tree also shows the id.
  Decision 8 asks only that the model be shown; unclear whether the label was intended.
- `apps/mobile/src/data/harness-options.ts`: the sticky choice is per harness on the device, not per
  server, while the list is per server (`live.ts:572-580`). A sticky id the second server does not
  list reads as its default, so nothing wrong is sent; only the choice does not carry.
