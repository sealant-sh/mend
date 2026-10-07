import { Schema } from "effect";

const PilotRun = Schema.Struct({
  id: Schema.String,
  harness: Schema.Literals(["claude", "codex"]),
  mode: Schema.Literals(["actions", "code"]),
  model: Schema.String,
  goal: Schema.String,
  status: Schema.Literals([
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "timed-out",
  ]),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  result: Schema.String,
  actions: Schema.Number,
});

const DesktopState = Schema.Struct({
  active: Schema.NullOr(PilotRun),
  humanControl: Schema.Boolean,
  runs: Schema.Array(PilotRun),
  display: Schema.String,
});

/** Decode observations from the optional desktop Service; it is outside the Mend HTTP contract. */
export async function readDesktopState(baseUrl: string): Promise<typeof DesktopState.Type> {
  const response = await fetch(`${baseUrl}/state`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Desktop did not answer · HTTP ${response.status}`);
  return Schema.decodeUnknownSync(DesktopState)(await response.json());
}

/** Send one controller operation; the raw Service's network boundary protects this experiment. */
export async function desktopCommand(
  baseUrl: string,
  command: "pilot" | "cancel" | "takeover" | "release",
  payload: {
    readonly harness: "claude" | "codex";
    readonly mode: "actions" | "code";
    readonly model: string;
    readonly goal: string;
  } | null = null,
): Promise<void> {
  const response = await fetch(`${baseUrl}/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(
      await response.json(),
    );
    throw new Error(error.error);
  }
}
