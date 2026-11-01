# Recorded steering transcripts

Two recordings of a real harness taking a message into a running turn. The steering tests replay
their inbound frames through Mend's adapters and compare what the adapters write against the
recorded outbound frames.

| File                       | Harness                                            | Recorded through                 |
| -------------------------- | -------------------------------------------------- | -------------------------------- |
| `codex_transcript.ndjson`  | Codex app-server 0.156.1, model `gpt-6-luna`       | T3 Code 0.0.44 over JSON-RPC     |
| `claude_transcript.ndjson` | Claude Code CLI 2.1.111, model `claude-sonnet-4-6` | Claude Agent SDK 0.2.111 `query` |

Source: `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/` in T3 Code, read from
a clone of `https://github.com/ypanagidis/t3code` at `d12a357b57cb51f7117d9fbbdf357798c1575fdb`. The
last commit to touch that directory is `90ca6a775843d226937b396e0af18e9664448508`. The files are
byte-identical copies.

Licence: MIT, Copyright (c) 2026 T3 Tools Inc.

## Reading them

Each line is one step. `emit_inbound` is a frame the harness wrote. `expect_outbound` is a frame the
client wrote. The steps are in recorded order.

The Claude recording's outbound frames are SDK envelopes (`query.open`, `prompt.offer`), not stdin
frames. Mend writes stream-json to the CLI directly, so the tests compare the `message` inside each
`prompt.offer` with the frame Mend wrote and skip `query.open`, whose launch options Mend passes as
argv. The second offer carries `priority: "now"` and comes before any output.

The Codex recording's outbound frames carry T3 Code's handshake parameters and request ids. The
tests match the handshake by method only, map the recorded request ids onto Mend's, and compare
`turn/steer` exactly.

The harness versions are older than the workspace image pins (Codex 0.160.1, Claude 2.1.292). The
recordings show the wire shape at their versions; they do not prove the pinned versions.

The Claude adapter and gateway regressions for #1338 also replay a derived sequence with a
`session_state_changed` idle event inserted after the steering abort, and cover both
`aborted_streaming` and `aborted_tools`. Mend enables session-state events in its launch settings.
The added idle event and alternate abort reason are test variants, not part of the recording.
