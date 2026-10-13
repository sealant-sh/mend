import { describe, expect, it } from "vitest";

import { convertNativeSession } from "./native-convert.ts";

const claudeJsonl = [
  JSON.stringify({ type: "user", message: { role: "user", content: "add a health endpoint" } }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Adding it now." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "1 passed" }] },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Done — tests pass." }] },
  }),
].join("\n");

const codexFreeformToolJsonl = (input: string, name = "exec") =>
  [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "inspect the repository" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name,
        input,
        call_id: "call-freeform",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call-freeform",
        output: [{ type: "input_text", text: "On branch main" }],
      },
    }),
  ].join("\n");

describe("native session conversion", () => {
  it("claude → codex: a valid rollout with meta, messages, and a real shell item", () => {
    const converted = convertNativeSession("claude", "codex", claudeJsonl, {
      cwd: "/workspace/repo",
      now: "2026-07-26T00:00:00.000Z",
    });
    expect(converted).not.toBeNull();
    const file = converted?.files[0];
    expect(file?.path).toMatch(/^\.codex\/sessions\/2026\/07\/26\/rollout-.*\.jsonl$/);
    const lines = (file?.content ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0].type).toBe("session_meta");
    expect(lines[0].payload.id).toBe(converted?.providerSessionId);
    const kinds = lines.map((line) => `${line.type}/${line.payload?.type ?? ""}`);
    expect(kinds).toContain("response_item/message");
    expect(kinds).toContain("response_item/function_call");
    expect(kinds).toContain("response_item/function_call_output");
    const call = lines.find((line) => line.payload?.type === "function_call");
    expect(call.payload.name).toBe("exec_command");
    expect(JSON.parse(call.payload.arguments).cmd).toBe("pnpm test");
    expect(converted?.resumeArgv[1]).toBe("resume");
  });

  it("round-trips codex → claude with text and shell fidelity", () => {
    const toCodex = convertNativeSession("claude", "codex", claudeJsonl, {
      cwd: "/workspace/repo",
      now: "2026-07-26T00:00:00.000Z",
    });
    const back = convertNativeSession("codex", "claude", toCodex?.files[0]?.content ?? "", {
      cwd: "/workspace/repo",
      now: "2026-07-26T00:00:00.000Z",
    });
    expect(back).not.toBeNull();
    const content = back?.files[0]?.content ?? "";
    expect(content).toContain("add a health endpoint");
    expect(content).toContain("Done — tests pass.");
    expect(content).toContain('"name":"Bash"');
    expect(content).toContain("pnpm test");
    expect(back?.files[0]?.path).toMatch(/^\.claude\/projects\/-workspace-repo\/.*\.jsonl$/);
    expect(back?.resumeArgv[1]).toBe("--resume");
  });

  it("unsupported pairs return null (fallback to distilled prompt)", () => {
    expect(
      convertNativeSession("claude", "opencode", claudeJsonl, {
        cwd: "/workspace/repo",
        now: "2026-07-26T00:00:00.000Z",
      }),
    ).toBeNull();
  });
});

// ─── the round-trip invariant: ingest(emit(ingest(x))) ≡ ingest(x) ──────────

import * as fs from "node:fs";

import { emitNativeSession, ingestNativeSession } from "./native-convert.ts";

const roundTrip = (sourceHarness: string, native: string, via: string) => {
  const canonical = ingestNativeSession(sourceHarness, native, "/workspace/repo");
  expect(canonical).not.toBeNull();
  if (canonical === null) return;
  const emitted = emitNativeSession(canonical, via, "2026-07-26T00:00:00.000Z");
  expect(emitted).not.toBeNull();
  const reingested = ingestNativeSession(via, emitted?.files[0]?.content ?? "", "/workspace/repo");
  expect(reingested?.events).toEqual(canonical.events);
};

describe("round-trip invariant", () => {
  it("claude fixture survives claude → codex → canonical", () => {
    roundTrip("claude", claudeJsonl, "codex");
  });

  it("claude fixture survives claude → claude-emit → canonical", () => {
    roundTrip("claude", claudeJsonl, "claude");
  });

  it("preserves Codex free-form tool input through Claude", () => {
    roundTrip(
      "codex",
      codexFreeformToolJsonl(
        'const result = await tools.exec_command({ cmd: "git status" });\ntext(result.output);',
      ),
      "claude",
    );
  });

  it("preserves JSON-looking Codex free-form tool input through both harnesses", () => {
    const native = codexFreeformToolJsonl('{"looks":"structured"}');
    roundTrip("codex", native, "claude");
    roundTrip("codex", native, "codex");
  });

  it("does not reinterpret a free-form exec_command custom tool as a shell call", () => {
    const native = codexFreeformToolJsonl('{"cmd":"git status"}', "exec_command");
    roundTrip("codex", native, "claude");
    roundTrip("codex", native, "codex");
  });
});

// Real-session corpus: runs only where local session files exist (dev machine),
// asserting the invariant against sessions actual harnesses wrote.
const codexCorpus = (() => {
  try {
    const days = fs.globSync(`${process.env["HOME"]}/.codex/sessions/*/*/*/rollout-*.jsonl`);
    return days.toSorted().at(-1) ?? null;
  } catch {
    return null;
  }
})();

const isHarvestManifest = (
  value: unknown,
  harness: string,
): value is { readonly harness: string; readonly capturedAt: string } =>
  typeof value === "object" &&
  value !== null &&
  "harness" in value &&
  value.harness === harness &&
  "capturedAt" in value &&
  typeof value.capturedAt === "string";

const claudeCorpus = (() => {
  try {
    const manifests = fs.globSync(`${process.env["HOME"]}/.mend/store/*/sessions/*/manifest.json`);
    const transcripts = manifests.flatMap((manifestPath) => {
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!isHarvestManifest(manifest, "claude")) return [];
      const transcriptPath = manifestPath.replace(/manifest\.json$/, "transcript.native");
      return fs.existsSync(transcriptPath)
        ? [{ capturedAt: manifest.capturedAt, transcriptPath }]
        : [];
    });
    return (
      transcripts.toSorted((left, right) => left.capturedAt.localeCompare(right.capturedAt)).at(-1)
        ?.transcriptPath ?? null
    );
  } catch {
    return null;
  }
})();

describe.skipIf(codexCorpus === null)("corpus: real codex rollout", () => {
  it("survives codex → claude → canonical and codex → codex → canonical", () => {
    const native = fs.readFileSync(codexCorpus ?? "", "utf8");
    roundTrip("codex", native, "claude");
    roundTrip("codex", native, "codex");
  });
});

describe.skipIf(claudeCorpus === null)("corpus: real harvested claude session", () => {
  it("survives claude → codex → canonical and claude → claude → canonical", () => {
    const native = fs.readFileSync(claudeCorpus ?? "", "utf8");
    roundTrip("claude", native, "codex");
    roundTrip("claude", native, "claude");
  });
});

const codexMessage = (role: "user" | "assistant", text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });

describe("Codex source text fidelity", () => {
  it.each([
    "  preserve indentation\n",
    " \t\n",
    "\tif ready:\n    continue\n\n",
    "<svg>please fix this</svg>",
    "  <example>\n    exact code\n  </example>\n",
    "<!-- a real comment -->",
    "<environment_context>a</environment_context>\nactual request\n<environment_context>b</environment_context>",
    "<environment_context>nested <environment_context>example</environment_context></environment_context>",
    "<environment_context>unfinished example",
    "<environment_context>example</environment_context>\nPlease explain the block.",
  ])("preserves original user and assistant text %j before and after conversion", (text) => {
    for (const role of ["user", "assistant"] as const) {
      const native = codexMessage(role, text);
      const original = ingestNativeSession("codex", native, "/workspace/repo");
      expect(original?.events).toEqual([{ kind: role, text }]);
      roundTrip("codex", native, "claude");
      roundTrip("codex", native, "codex");
    }
  });

  it("omits a complete legacy environment wrapper only in a user-role context item", () => {
    const wrapper = "<environment_context>\n  <cwd>/workspace/repo</cwd>\n</environment_context>";
    const native = [
      codexMessage("user", wrapper),
      codexMessage("user", "work on this"),
      codexMessage("assistant", wrapper),
    ].join("\n");
    expect(ingestNativeSession("codex", native, "/workspace/repo")?.events).toEqual([
      { kind: "user", text: "work on this" },
      { kind: "assistant", text: wrapper },
    ]);
  });

  it.each(["before", "after"])(
    "keeps an environment-shaped user turn with its input event %s the response",
    (order) => {
      const text = "<environment_context>example to edit</environment_context>";
      const native = [
        codexMessage("user", text),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } }),
      ];
      if (order === "before") native.reverse();
      const rollout = native.join("\n");
      expect(ingestNativeSession("codex", rollout, "/workspace/repo")?.events).toEqual([
        { kind: "user", text },
      ]);
      roundTrip("codex", rollout, "codex");
      roundTrip("codex", rollout, "claude");
    },
  );
});
