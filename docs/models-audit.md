# Models audit

Roadmap item 5 of `ROADMAP.md` (0.36): what each client offered for a session's model before this
change, where the list came from, and the decisions the one picker is built on. Facts first, dated
2026-10-03, at main `63e5d8b80`.

## Before

### Where the list lived

- `packages/domain/src/workbench/harness-launch.ts` held `HARNESS_MODELS`, a hardcoded per-harness
  catalog (claude: `fable`, `opus`, `sonnet`, `haiku`, default `fable`; codex: eight entries from
  `codex debug models`, default `gpt-6.1-sol`, three with fewer efforts), plus `HARNESS_EFFORTS`
  (what each harness CLI accepts: claude up to `max`, codex up to `ultra`, pi up to `max`, opencode
  none) and `effortsFor(harness, model)`. The contract kept `model` free-form
  (`packages/api-contracts/src/project-environment.ts`, `LaunchRequest.model`), so the catalog was
  advisory: a picker list only.
- The phone kept a second copy. `apps/mobile/src/data/harness-options.ts` transcribed
  `HARNESS_MODELS`, `HARNESS_EFFORTS` and `effortsFor` by hand, with a comment that pulling the
  domain package would drag Effect into the bundle. The same app already imported
  `@mend/domain/workbench` in `apps/mobile/src/data/live.ts` and `apps/mobile/src/app/adopt.tsx`, so
  the reason had lapsed; the copy had not.
- Slack read the same constant: `packages/slack/src/mention.ts` built
  `DEFAULT_MENTION_VOCABULARY.models` from `HARNESS_MODELS`, and `apps/api/src/slack-runner.ts` used
  it for `model=` parsing and the thread reader.
- The server never stored a model list, and no API endpoint listed models.

### What each client offered

| Client  | Picker                                                                                                                                                                                                                                              | Default preselected                                                                             | Effort                                                                                              | Sticky                                        | Shows the running model                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| Phone   | `apps/mobile/src/components/start-session.tsx`: chips under each harness row, `default` chip plus the local copy of the catalog                                                                                                                     | No. `default` chip meant "send nothing", and the summary said `default model`                   | Chips from the local `effortsFor`, `default` first                                                  | Per harness on device (`mend-launch-options`) | No. Header and rows showed harness and status           |
| Web     | `apps/web/src/components/session-composer.tsx`: a model pill with a radio menu from `HARNESS_MODELS[harness]`                                                                                                                                       | Yes, `apps/web/src/lib/composer-prefs.ts` `defaultModel` picked the catalog's `isDefault` entry | Thinking radio in the settings menu from `effortsFor`, `default` first                              | Per project and harness in localStorage       | No. `routes/sessions.$sessionId.tsx` showed the harness |
| Desktop | `apps/desktop/src/renderer/src/components/launcher.tsx`: same pill and menu as the web, its own copy of `MenuRadioGroup`                                                                                                                            | Yes, same `defaultModel` logic in `lib/composer-prefs.ts`                                       | Same as the web                                                                                     | Per project and harness in localStorage       | No                                                      |
| CLI     | `mend claude\|codex\|opencode\|pi --model <id> --effort <level>` (`apps/cli/src/shared.ts`, `apps/cli/src/help.ts`). Free text, no list. The help said effort was `low, medium, high, xhigh, or max`, missing `ultra`; `shared.ts` accepted `ultra` | None sent, the harness chose                                                                    | Validated against a local copy of the six levels; the server clamps a level the model does not take | None                                          | No. `mend sessions` printed harness and status          |
| VS Code | `apps/vscode/src/extension.ts`: quick picks from `HARNESS_MODELS` and `effortsFor`                                                                                                                                                                  | "Default model" entry meant "send nothing"                                                      | Quick pick from `effortsFor`                                                                        | None                                          | No                                                      |
| Slack   | `model=` and `with <model>` parsed against the constant                                                                                                                                                                                             | None sent                                                                                       | `effort=`                                                                                           | n/a                                           | No                                                      |

So the web and desktop preselected the catalog default and sent it; the phone, the CLI, VS Code and
Slack sent nothing and let the harness decide. The same harness, started from two clients, could run
on different models with nothing recorded about it.

### What a session recorded

- `agent_sessions` had no model or effort column (`packages/db/src/schema/workbench.ts`).
- A protocol process row kept `protocolOptions` (`model`, `effort`, `permissionMode`) so a restart
  reopens the pipe with the same options (`session_processes.protocol_options`, migration 0044).
- A PTY process carried the model only inside its `argv` (`claude --model fable …`).
- A native resume runs `claude --resume <id>` or `codex resume <id>` with no model flag
  (`packages/sessions/src/native-convert.ts`): the harness keeps the conversation's own model.
- The `Session` the API returned (`packages/domain/src/workbench/session.ts`) said `harness` and
  nothing about the model, so no client could show it.

### t3code, for comparison

`~/Developer/refs/t3code`: the server owns the list. `ServerConfig.providers[].models[]` carries
`slug`, `name`, `isDefault`, `isLegacy`, `capabilities.optionDescriptors` (effort and fast mode as
typed option descriptors) per provider instance; drivers discover models (`refreshModels`) and the
contracts pin preferred defaults (`PREFERRED_DEFAULT_CODEX_MODELS`, `DEFAULT_MODEL_BY_PROVIDER`).
The phone builds its picker from that config (`apps/mobile/src/lib/modelOptions.ts`,
`buildModelOptions`, `resolveNewTaskModelSelection`: draft, then project default, then sticky, then
the server's default) and refreshes it with a pull (`provider-catalog-refresh.ts`). Nothing in the
phone names a model.

## After: decisions

1. **The server owns the catalog.** A `harness_models` table (migration `0102_harness_models`,
   `packages/db/src/migrations.ts`), one row per harness and model id: label, whether it is the
   harness's default, the efforts it takes when fewer than the harness's, and its position. Seeded
   from what the harness adapters supported on 2026-10-03, the former `HARNESS_MODELS`; opencode's
   rows (the Codex models as `openai/<id>`, through the ChatGPT login) came in 0109, with no default
   (see 3). One default per harness is a partial unique index. Editable by SQL today; no write
   endpoint yet.
2. **One endpoint.** `GET /api/harnesses/models` returns every harness's catalog: its models, the
   default model id, the efforts the harness accepts, and whether it offers priority processing
   (`packages/api-contracts/src/harness-models.ts`). Clients read this and nothing else. The domain
   keeps only `HARNESS_MODEL_SEED` for the migration and Slack's offline vocabulary; the
   `HARNESS_MODELS` and `effortsFor` exports are gone, so a client that still hardcoded a list fails
   to compile.
3. **A launch resolves the model on the server and records it.** `apps/api/src/session-start.ts`
   reads the harness's catalog and resolves the request's model, else the one the session was
   started with (a Slack follow-up that relaunches a settled session names none), else the default,
   with the effort clamped to what that model takes; then it composes the argv. The record
   (`agent_sessions.model`, `agent_sessions.effort`) is written once the launch is admitted, never
   for one the account's launch slot refuses: a PTY launch writes it in `session-start.ts` right
   before the engine starts, a protocol launch inside `SessionEngine.launchProtocol` after its own
   live-agent check, so every protocol path (a handoff to a conversation, a crash relaunch, Slack)
   records the same way. The composed argv always names the model for a harness that has a catalog,
   and `Session.model` says which. A harness without a catalog (a custom command, a shell) records
   `null`: the harness's own choice. So does opencode when nobody chose a model: its catalog lists
   models but has no default unless an operator flags one (`HARNESSES_CHOOSING_THEIR_OWN_MODEL`),
   because `--model` would beat the project's or the user's own opencode config. A verbatim `argv`
   (`mend run -- …`) names its own command and records nothing; the CLI and the dashboard send a
   structured start for every harness, bare or not.
4. **Effort stays optional.** `null` means the harness's own default and is reported as such. The
   catalog carries which efforts a model takes, not a default effort: the harnesses pick their own
   default and Mend does not second-guess it.
5. **A resume keeps the recorded model.** A native resume passes no model flag by design, so the
   harness continues the conversation on its own model, which is the one recorded at start. The
   session's `model` is not rewritten on resume, and a handoff to a terminal (a native resume) takes
   no model override. A resume on another harness clears the record: the converted launch names no
   model, so the row says `null` rather than the old harness's id. A follow-up delivered to a
   stopped PTY session opens the harness with the recorded model and effort (`promptArgv`), so the
   next process runs what the row reports.
6. **No backfill.** Sessions from before the migration report `model: null`. Their process rows
   still hold the fact (`protocolOptions`, `argv`) for anyone who needs it.
7. **One picker, built once.** The headless picker is in the domain
   (`packages/domain/src/workbench/model-catalog.ts`): given a catalog and the person's sticky
   choice, it says which models to list, which is selected, which efforts the selected model takes,
   and what to put on the wire. The phone renders it as chips, the web and desktop as the shared
   radio menu in `@mend/ui/model-picker`, the CLI as `mend models` and `--model`. Every client
   preselects the server's default and shows the model by its label with the id beside it. Until the
   server's list has arrived (or from a server without the route) the picker lists nothing and
   passes the sticky choice through as it is; the server resolves the default and the clamp, and a
   saved permission or speed is never dropped by a request in flight. The phone keys its copy of the
   list by server, so pairing with another machine never sends the first machine's default.
8. **Every client shows the running model** beside the harness: the web session page and lists, the
   phone's session header and rows, the desktop sidebar, `mend sessions`.
9. **The CLI gains `mend models`** so a terminal can see the list the server offers without
   hardcoding one. `--model` and `--effort` keep their names; they match the API fields.
10. **Slack** keeps reading the seed for the words it recognises offline; a model the seed does not
    know is still passed through as text, as before. Reading the live catalog there is a follow-up.

## Not done

- No write endpoint or settings page for the catalog; an operator edits the table.
- Slack's vocabulary reads the seed, not the table.
- The catalog is not discovered from the harness binaries (t3code's `refreshModels`); it is a table
  an operator edits.
- A PTY launch records its options inside the account's launch slot but before the engine's
  per-session gate: two PTY launches of one session that both pass the account budget can leave the
  row reporting the second's model while the first one ran (the second fails `session_starting`).
  Recording inside the engine's `oneLaunch`, as the protocol path does inside `launchProtocol`,
  closes it; it needs `engine.launch` to take the resolved options beside the argv.
- A protocol launch records after `composeProtocolArgv` accepts the harness, so an unsupported
  harness rewrites nothing; the engine's later refusals (a workspace that fails to build) leave the
  record standing beside the failed session, which is what it ran with.
