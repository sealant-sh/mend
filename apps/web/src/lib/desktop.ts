import { DesktopState } from "@mend/domain";
import { Schema } from "effect";

/** Decode observations from the optional desktop Service; it is outside the Mend HTTP contract. */
export async function readDesktopState(baseUrl: string): Promise<typeof DesktopState.Type> {
  const response = await fetch(`${baseUrl}/state`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Desktop did not answer · HTTP ${response.status}`);
  return Schema.decodeUnknownSync(DesktopState)(await response.json());
}

/** Send one controller operation through Mend's authenticated session boundary. */
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
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error(
        (await response.text()) || `Desktop operation failed · HTTP ${response.status}`,
      );
    const error = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(
      await response.json(),
    );
    throw new Error(error.error);
  }
}
