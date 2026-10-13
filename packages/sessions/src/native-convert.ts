/**
 * The harness-agnostic session record (the hub) and its per-harness adapters
 * (the spokes). Every harness's real on-disk session ingests into ONE
 * canonical shape; every supported harness can be emitted FROM that shape as
 * a fully native session its own resume machinery opens. Cross-harness resume
 * is ingest(A) → emit(B); the testable invariant is the round-trip:
 * ingest(emit(ingest(x))) ≡ ingest(x) at the canonical level.
 *
 * Fidelity is tiered and stated per event kind:
 *  - user/assistant text: byte-exact
 *  - reasoning: the readable summary/thinking TEXT crosses; provider-encrypted
 *    blobs cannot be fabricated for another provider and are dropped
 *  - shell: mapped to each harness's real shell item (Bash ↔ exec_command)
 *  - other tools: structured passthrough — name, arguments, output verbatim
 *
 * Formats come from the implementations, not guesses: openai/codex reference
 * clone (protocol models + rollout recorder — lenient parser, one
 * session_meta required, resume falls back to a file scan) and real harvested
 * claude session files from this store.
 */

export interface CanonicalSession {
  readonly version: 1;
  /** Harness that actually produced the events. */
  readonly sourceHarness: string;
  readonly cwd: string;
  readonly events: ReadonlyArray<CanonicalEvent>;
}

type ToolArgsFormat = "json" | "text";

export type CanonicalEvent =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool";
      /** Source harness's tool name; "shell" for plain command execution. */
      readonly name: string;
      readonly args: string;
      readonly argsFormat: ToolArgsFormat;
      readonly output: string;
      /** Set when the tool is plain shell execution — every harness has a native form. */
      readonly command: string | null;
    };

export interface ConvertedNativeSession {
  readonly providerSessionId: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly resumeArgv: ReadonlyArray<string>;
}

const asText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { readonly type?: string; readonly text?: string };
        return typeof p.text === "string" &&
          (p.type === "text" ||
            p.type === "input_text" ||
            p.type === "output_text" ||
            p.type === "summary_text")
          ? p.text
          : "";
      })
      .filter((text) => text !== "")
      .join("\n");
  }
  return "";
};

const IMPORT_PREFIX = "imported_";
const TOOL_INPUT_ENVELOPE = "$mend.toolInput";

const canonicalToolArgs = (
  input: unknown,
): { readonly args: string; readonly argsFormat: ToolArgsFormat } => {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    TOOL_INPUT_ENVELOPE in input
  ) {
    const envelope = input[TOOL_INPUT_ENVELOPE];
    if (
      typeof envelope === "object" &&
      envelope !== null &&
      "value" in envelope &&
      typeof envelope.value === "string" &&
      "format" in envelope &&
      (envelope.format === "json" || envelope.format === "text")
    ) {
      return { args: envelope.value, argsFormat: envelope.format };
    }
  }
  return { args: JSON.stringify(input ?? {}), argsFormat: "json" };
};

// ─── ingest: native → canonical ─────────────────────────────────────────────

interface PendingTool {
  readonly name: string;
  readonly args: string;
  readonly argsFormat: ToolArgsFormat;
  readonly command: string | null;
}

const ingestClaude = (jsonl: string): CanonicalEvent[] => {
  const events: CanonicalEvent[] = [];
  const pending = new Map<string, PendingTool>();
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let entry: {
      readonly type?: string;
      readonly isMeta?: boolean;
      readonly message?: { readonly content?: unknown };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.isMeta === true) continue;
    const content = entry.message?.content;
    if (entry.type === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        const p = part as {
          readonly type?: string;
          readonly text?: string;
          readonly thinking?: string;
          readonly id?: string;
          readonly name?: string;
          readonly input?: unknown;
        };
        if (p.type === "text" && typeof p.text === "string" && p.text !== "") {
          events.push({ kind: "assistant", text: p.text });
        }
        if (p.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim() !== "") {
          events.push({ kind: "reasoning", text: p.thinking });
        }
        if (p.type === "tool_use" && typeof p.id === "string") {
          const input = p.input as { readonly command?: string } | undefined;
          const shell = p.name === "Bash" && typeof input?.command === "string";
          pending.set(p.id, {
            name: shell ? "shell" : (p.name ?? "tool"),
            // Shell canonicalizes to `command`; args carry nothing extra.
            ...(shell ? { args: "", argsFormat: "json" } : canonicalToolArgs(p.input)),
            command: shell ? (input?.command ?? null) : null,
          });
        }
      }
    }
    if (entry.type === "user") {
      if (typeof content === "string") {
        if (content !== "") events.push({ kind: "user", text: content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const p = part as {
          readonly type?: string;
          readonly text?: string;
          readonly tool_use_id?: string;
          readonly content?: unknown;
        };
        if (p.type === "text" && typeof p.text === "string" && p.text !== "") {
          events.push({ kind: "user", text: p.text });
        }
        if (p.type === "tool_result" && typeof p.tool_use_id === "string") {
          const call = pending.get(p.tool_use_id);
          if (call !== undefined) {
            pending.delete(p.tool_use_id);
            events.push({ kind: "tool", ...call, output: asText(p.content) });
          }
        }
      }
    }
  }
  return events;
};

const isCodexEnvironmentContext = (text: string): boolean => {
  const trimmed = text.trim();
  const open = "<environment_context>";
  const close = "</environment_context>";
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return false;
  const body = trimmed.slice(open.length, -close.length);
  return !body.includes(open) && !body.includes(close);
};

const ingestCodex = (jsonl: string): CanonicalEvent[] => {
  const events: CanonicalEvent[] = [];
  const pending = new Map<string, PendingTool>();
  const entries = jsonl.split("\n").flatMap((line) => {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return [];
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      typeof entry.type !== "string" ||
      !("payload" in entry) ||
      typeof entry.payload !== "object" ||
      entry.payload === null ||
      Array.isArray(entry.payload)
    )
      return [];
    return [{ type: entry.type, payload: entry.payload }];
  });
  // A user_message records actual input, even when it quotes a context-shaped block.
  // Codex and our emitter may put this event before or after its response_item.
  const userInputs = new Set(
    entries.flatMap(({ type, payload }) =>
      type === "event_msg" &&
      "type" in payload &&
      payload.type === "user_message" &&
      "message" in payload &&
      typeof payload.message === "string"
        ? [payload.message]
        : [],
    ),
  );
  for (const entry of entries) {
    if (entry.type !== "response_item") continue;
    const p = entry.payload as {
      readonly type?: string;
      readonly role?: string;
      readonly content?: unknown;
      readonly summary?: unknown;
      readonly name?: string;
      readonly arguments?: string;
      readonly input?: string;
      readonly call_id?: string;
      readonly output?: unknown;
    };
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const text = asText(p.content);
      // Legacy rollouts lack content classifications. Recognize only the complete known
      // environment wrapper in user context; arbitrary XML and assistant output are text.
      const environment =
        p.role === "user" && !userInputs.has(text) && isCodexEnvironmentContext(text);
      if (text !== "" && !environment) events.push({ kind: p.role, text });
    }
    if (p.type === "reasoning") {
      const text = asText(p.summary).trim();
      if (text !== "") events.push({ kind: "reasoning", text });
    }
    if (
      (p.type === "function_call" || p.type === "custom_tool_call") &&
      typeof p.call_id === "string"
    ) {
      const rawArgs = p.arguments ?? p.input ?? "{}";
      let command: string | null = null;
      if (p.type === "function_call" && (p.name === "exec_command" || p.name === "shell")) {
        try {
          const parsed = JSON.parse(rawArgs) as {
            readonly cmd?: string;
            readonly command?: ReadonlyArray<string> | string;
          };
          command =
            typeof parsed.cmd === "string"
              ? parsed.cmd
              : Array.isArray(parsed.command)
                ? parsed.command.join(" ")
                : typeof parsed.command === "string"
                  ? parsed.command
                  : null;
        } catch {
          command = null;
        }
      }
      const name =
        command !== null
          ? "shell"
          : (p.name ?? "tool").startsWith(IMPORT_PREFIX)
            ? (p.name ?? "tool").slice(IMPORT_PREFIX.length)
            : (p.name ?? "tool");
      pending.set(p.call_id, {
        name,
        args: command !== null ? "" : rawArgs,
        argsFormat: p.type === "custom_tool_call" ? "text" : "json",
        command,
      });
    }
    if (
      (p.type === "function_call_output" || p.type === "custom_tool_call_output") &&
      typeof p.call_id === "string"
    ) {
      const call = pending.get(p.call_id);
      if (call !== undefined) {
        pending.delete(p.call_id);
        const output =
          typeof p.output === "string"
            ? p.output
            : ((p.output as { readonly content?: string } | undefined)?.content ??
              JSON.stringify(p.output ?? ""));
        events.push({ kind: "tool", ...call, output });
      }
    }
  }
  return events;
};

/** Parse a harness's native session file into the canonical record. */
export const ingestNativeSession = (
  harness: string,
  nativeJsonl: string,
  cwd: string,
): CanonicalSession | null => {
  const events =
    harness === "claude"
      ? ingestClaude(nativeJsonl)
      : harness === "codex"
        ? ingestCodex(nativeJsonl)
        : null;
  if (events === null || events.length === 0) return null;
  return { version: 1, sourceHarness: harness, cwd, events };
};

// ─── emit: canonical → native ───────────────────────────────────────────────

const uuid = () => crypto.randomUUID();
const CODEX_CLI_VERSION = "0.145.0";
const CLAUDE_VERSION = "2.1.220";

const emitCodex = (session: CanonicalSession, now: string): ConvertedNativeSession => {
  const sessionId = uuid();
  const stamp = now.replace(/\.\d+Z$/, "Z");
  const lines: string[] = [];
  const push = (type: string, payload: unknown) =>
    lines.push(JSON.stringify({ timestamp: stamp, type, payload }));

  push("session_meta", {
    session_id: sessionId,
    id: sessionId,
    timestamp: stamp,
    cwd: session.cwd,
    originator: "codex-tui",
    cli_version: CODEX_CLI_VERSION,
    source: "cli",
  });
  let call = 0;
  for (const event of session.events) {
    if (event.kind === "user") {
      push("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: event.text }],
      });
      push("event_msg", { type: "user_message", message: event.text });
    } else if (event.kind === "assistant") {
      push("response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: event.text }],
      });
      push("event_msg", { type: "agent_message", message: event.text });
    } else if (event.kind === "reasoning") {
      push("response_item", {
        type: "reasoning",
        summary: [{ type: "summary_text", text: event.text }],
        encrypted_content: null,
      });
    } else {
      call += 1;
      const callId = `call_mend${String(call).padStart(6, "0")}`;
      const shell = event.command !== null;
      const functionCall = shell || event.argsFormat === "json";
      push(
        "response_item",
        functionCall
          ? {
              type: "function_call",
              name: shell ? "exec_command" : `${IMPORT_PREFIX}${event.name}`,
              arguments: shell
                ? JSON.stringify({ cmd: event.command, workdir: session.cwd })
                : event.args,
              call_id: callId,
            }
          : {
              type: "custom_tool_call",
              name: `${IMPORT_PREFIX}${event.name}`,
              input: event.args,
              call_id: callId,
            },
      );
      push("response_item", {
        type: functionCall ? "function_call_output" : "custom_tool_call_output",
        call_id: callId,
        output: event.output,
      });
    }
  }

  const day = stamp.slice(0, 10);
  const [year = "1970", month = "01", dayOfMonth = "01"] = day.split("-");
  const fileStamp = stamp.replace(/:/g, "-").replace("Z", "");
  return {
    providerSessionId: sessionId,
    files: [
      {
        path: `.codex/sessions/${year}/${month}/${dayOfMonth}/rollout-${fileStamp}-${sessionId}.jsonl`,
        content: `${lines.join("\n")}\n`,
      },
    ],
    resumeArgv: ["codex", "resume", sessionId],
  };
};

const claudeToolInput = (raw: string, format: ToolArgsFormat): unknown => {
  if (format === "text") {
    return { [TOOL_INPUT_ENVELOPE]: { format, value: raw } };
  }
  try {
    const input: unknown = JSON.parse(raw);
    const restored = canonicalToolArgs(input);
    // JSON parsing can round numbers, discard duplicate keys, or consume our reserved envelope.
    // Use an ordinary native input only when re-ingestion retains the exact canonical arguments.
    if (restored.args === raw && restored.argsFormat === format) return input;
  } catch {
    // Malformed structured arguments also need the explicit preservation envelope.
  }
  return { [TOOL_INPUT_ENVELOPE]: { format, value: raw } };
};

const emitClaude = (session: CanonicalSession, now: string): ConvertedNativeSession => {
  const sessionId = uuid();
  const lines: string[] = [];
  let parentUuid: string | null = null;
  const push = (entry: Record<string, unknown>) => {
    const id = uuid();
    lines.push(
      JSON.stringify({
        parentUuid,
        isSidechain: false,
        userType: "external",
        entrypoint: "cli",
        cwd: session.cwd,
        sessionId,
        version: CLAUDE_VERSION,
        gitBranch: "",
        timestamp: now,
        ...entry,
        uuid: id,
      }),
    );
    parentUuid = id;
  };
  const assistant = (content: ReadonlyArray<unknown>, stopReason: string, n: number) =>
    push({
      type: "assistant",
      message: {
        id: `msg_mend_${n}`,
        type: "message",
        role: "assistant",
        model: "imported",
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

  let n = 0;
  for (const event of session.events) {
    n += 1;
    if (event.kind === "user") {
      push({ type: "user", message: { role: "user", content: event.text } });
    } else if (event.kind === "assistant") {
      assistant([{ type: "text", text: event.text }], "end_turn", n);
    } else if (event.kind === "reasoning") {
      assistant([{ type: "thinking", thinking: event.text, signature: "" }], "end_turn", n);
    } else {
      const toolUseId = `toolu_mend_${n}`;
      const shell = event.command !== null;
      assistant(
        [
          {
            type: "tool_use",
            id: toolUseId,
            name: shell ? "Bash" : event.name,
            input: shell
              ? { command: event.command }
              : claudeToolInput(event.args, event.argsFormat),
          },
        ],
        "tool_use",
        n,
      );
      push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: [{ type: "text", text: event.output }],
            },
          ],
        },
      });
    }
  }

  const projectDir = session.cwd.replace(/[/.]/g, "-");
  return {
    providerSessionId: sessionId,
    files: [
      {
        path: `.claude/projects/${projectDir}/${sessionId}.jsonl`,
        content: `${lines.join("\n")}\n`,
      },
    ],
    resumeArgv: ["claude", "--resume", sessionId],
  };
};

/** Emit the canonical record as a TARGET harness's own native session. */
export const emitNativeSession = (
  session: CanonicalSession,
  targetHarness: string,
  now: string,
): ConvertedNativeSession | null => {
  if (targetHarness === "codex") return emitCodex(session, now);
  if (targetHarness === "claude") return emitClaude(session, now);
  return null;
};

/** ingest(A) → emit(B): the cross-harness open. Null when either side is unsupported. */
export const convertNativeSession = (
  sourceHarness: string,
  targetHarness: string,
  nativeJsonl: string,
  options: { readonly cwd: string; readonly now: string },
): ConvertedNativeSession | null => {
  const canonical = ingestNativeSession(sourceHarness, nativeJsonl, options.cwd);
  if (canonical === null) return null;
  return emitNativeSession(canonical, targetHarness, options.now);
};
