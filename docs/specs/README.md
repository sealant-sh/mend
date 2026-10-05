# Feature specs

One spec per release feature. A spec states what the feature is meant to do, precisely enough that
adversarial review agents can try to break the implementation: review the code against it, and test
the edge cases it names.

A spec states intended behaviour. Where the code disagrees, or the intent is unclear, the writer
lists it under "Divergences found while writing" with a file:line. The spec does not fix it.

New specs start from [TEMPLATE.md](TEMPLATE.md).

## Sections

- **Header:** release, status (on main, in review, designed, planned), PRs, decision records, and
  the commits it was written against.
- **Why it exists:** the problem a person had before the feature, and what it cost them.
- **What it does:** the visible behaviour, defaults and settings, with what is in and out of scope.
- **How it works:** the mechanism end to end, with components, data written and `path:line`
  pointers.
- **Happy path:** one concrete story, with named people and what each sees at each step.
- **Invariants:** numbered, testable statements that must always hold.
- **Edge cases and failure behaviour:** concurrency, restarts, partial failures, odd input, older
  data, permissions, and every client.
- **Known limits:** accepted limitations, not to be reported as new findings.
- **How to verify:** existing tests and their gaps, commands to run on the box, signals to watch.
- **Divergences found while writing:** where the code does not match the spec, each with a
  file:line.

## 0.36

| File                                                                              | Feature                                                       | Status                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| [ad-hoc-repositories.md](0.36/ad-hoc-repositories.md)                             | Any project of the store, ad hoc, from inside a session       | On main (nested clone); the repository-root capture is designed      |
| [agent-memory.md](0.36/agent-memory.md)                                           | Agent memory per person per project                           | On main; the hand-over is superseded by ADR 0016, designed           |
| [automatic-install.md](0.36/automatic-install.md)                                 | Automatic install                                             | On main                                                              |
| [box-and-deploys.md](0.36/box-and-deploys.md)                                     | The box and its deploys                                       | On main; box-side pieces are set up by hand                          |
| [credential-safety.md](0.36/credential-safety.md)                                 | Harness credential files are never saved or restored          | sealantd side on main; mend#526 in review; per-person homes designed |
| [model-picker.md](0.36/model-picker.md)                                           | One model picker, the server owns the list                    | On main                                                              |
| [next-channel.md](0.36/next-channel.md)                                           | The `next` prerelease channel across sealantd, Core and Mend  | On main; docs and the argument-length fix in review                  |
| [pi-and-opencode.md](0.36/pi-and-opencode.md)                                     | pi and opencode as harnesses                                  | On main                                                              |
| [planned-stop-wording.md](0.36/planned-stop-wording.md)                           | Mend's words for Core's planned stop before a runtime's limit | Designed                                                             |
| [pull-requests-in-the-conversation.md](0.36/pull-requests-in-the-conversation.md) | The agent's pull request, recorded when its turn ends         | On main                                                              |
| [saves-without-the-wait.md](0.36/saves-without-the-wait.md)                       | Saves without the wait                                        | On main                                                              |
| [secret-files.md](0.36/secret-files.md)                                           | Secret files                                                  | On main; per-person delivery designed (ADR 0016)                     |
| [start-time.md](0.36/start-time.md)                                               | Start time                                                    | On main; not yet measured end to end on the box                      |
| [steering.md](0.36/steering.md)                                                   | Per-user steering: whoever sends a turn pays                  | Partly on main; the per-turn login switch designed                   |
| [t3code-gateway.md](0.36/t3code-gateway.md)                                       | The T3 Code gateway, phases 0 and 1                           | On main; phases 2-4 planned                                          |

Status is as of 2026-10-05. Each spec's header carries the detail. The per-person homes spec follows
with ADR 0016 (mend#534).
