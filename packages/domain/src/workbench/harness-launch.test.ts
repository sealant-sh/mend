import { describe, expect, it } from "vitest";

import {
  HARNESS_MODEL_SEED,
  OPENCODE_DEFAULT_MODEL,
  ProtocolHarnessUnsupportedError,
  composeLaunchArgv,
  composeProtocolArgv,
  resumesOwnHarness,
  takesReviewFollowUp,
} from "./harness-launch.ts";

describe("composeLaunchArgv", () => {
  it("composes the bare harness when every field is absent", () => {
    expect(composeLaunchArgv("claude", {})).toEqual(["claude"]);
    expect(composeLaunchArgv("codex", {})).toEqual(["codex"]);
    expect(composeLaunchArgv("opencode", {})).toEqual(["opencode"]);
    expect(composeLaunchArgv("shell", {})).toEqual(["bash"]);
  });

  it("puts the prompt last, after every flag", () => {
    expect(
      composeLaunchArgv("claude", {
        prompt: "fix the auth test",
        model: "sonnet",
        effort: "high",
        permissionMode: "ask",
      }),
    ).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--permission-mode",
      "auto",
      "fix the auth test",
    ]);
  });

  it("maps codex effort through -c verbatim (xhigh included — codex accepts it)", () => {
    expect(composeLaunchArgv("codex", { effort: "xhigh", prompt: "p" })).toEqual([
      "codex",
      "-c",
      "model_reasoning_effort=xhigh",
      "p",
    ]);
    expect(composeLaunchArgv("codex", { effort: "low" })).toEqual([
      "codex",
      "-c",
      "model_reasoning_effort=low",
    ]);
  });

  it("emits no permission flag for bypass so the engine injects its default", () => {
    // withPermissionDefaults (engine) keys on --permission-mode / --sandbox.
    expect(composeLaunchArgv("claude", { permissionMode: "bypass" })).toEqual(["claude"]);
    expect(composeLaunchArgv("codex", { permissionMode: "bypass" })).toEqual(["codex"]);
  });

  it("names the permission flag for ask, suppressing the engine bypass injection", () => {
    expect(composeLaunchArgv("claude", { permissionMode: "ask" })).toContain("--permission-mode");
    expect(composeLaunchArgv("codex", { permissionMode: "ask" })).toEqual([
      "codex",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "on-request",
    ]);
  });

  it("opens opencode's TUI on the prompt (`run` is one-shot), with its model", () => {
    expect(
      composeLaunchArgv("opencode", { prompt: "add tests", model: "openai/gpt-6.1-sol" }),
    ).toEqual(["opencode", "--model", "openai/gpt-6.1-sol", "--prompt", "add tests"]);
    // `ask` names opencode's permission itself, which keeps the engine's `allow` default off.
    expect(composeLaunchArgv("opencode", { permissionMode: "ask" })).toEqual([
      "env",
      'OPENCODE_PERMISSION={"*":"ask"}',
      "opencode",
    ]);
  });

  it("composes pi with its model, its thinking level, and the prompt last", () => {
    expect(
      composeLaunchArgv("pi", {
        prompt: "fix the flaky test",
        model: "openai-codex/gpt-6.1-sol",
        effort: "high",
      }),
    ).toEqual([
      "pi",
      "--model",
      "openai-codex/gpt-6.1-sol",
      "--thinking",
      "high",
      "fix the flaky test",
    ]);
    // pi stops at `max`; it asks nothing per tool call, so `ask` changes nothing.
    expect(composeLaunchArgv("pi", { effort: "ultra", permissionMode: "ask" })).toEqual([
      "pi",
      "--thinking",
      "max",
    ]);
  });

  it("maps fast speed to codex's priority service tier and ignores it on claude", () => {
    expect(composeLaunchArgv("codex", { speed: "fast", prompt: "p" })).toEqual([
      "codex",
      "-c",
      "service_tier=priority",
      "p",
    ]);
    expect(composeLaunchArgv("codex", { speed: "standard" })).toEqual(["codex"]);
    // claude has no launch-time fast flag; the field is ignored, not an error.
    expect(composeLaunchArgv("claude", { speed: "fast" })).toEqual(["claude"]);
  });

  it("passes max effort through on both harnesses", () => {
    expect(composeLaunchArgv("claude", { effort: "max" })).toEqual(["claude", "--effort", "max"]);
    expect(composeLaunchArgv("codex", { effort: "max" })).toEqual([
      "codex",
      "-c",
      "model_reasoning_effort=max",
    ]);
  });

  it("ignores prompt and knobs for shell", () => {
    expect(composeLaunchArgv("shell", { prompt: "ignored", effort: "high" })).toEqual(["bash"]);
  });

  it("treats whitespace-only prompt and model as absent", () => {
    expect(composeLaunchArgv("claude", { prompt: "  ", model: " " })).toEqual(["claude"]);
  });
});

describe("composeProtocolArgv", () => {
  it("keeps Codex model and effort off the app-server process argv", () => {
    expect(
      composeProtocolArgv("codex", {
        mode: "protocol",
        model: "gpt-test",
        effort: "high",
        permissionMode: "ask",
      }),
    ).toEqual(["codex", "app-server"]);
  });

  it("composes Claude stream-json resume flags and ask permissions", () => {
    expect(
      composeProtocolArgv(
        "claude",
        { mode: "protocol", model: "sonnet", effort: "high", permissionMode: "ask" },
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toEqual([
      "claude",
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--resume",
      "11111111-1111-4111-8111-111111111111",
      "--model",
      "sonnet",
      "--effort",
      "high",
    ]);
  });

  it("rejects harnesses without a protocol shape", () => {
    expect(composeProtocolArgv("opencode", {})).toBeInstanceOf(ProtocolHarnessUnsupportedError);
  });
});

describe("the seed and the composer's own clamp", () => {
  it("seeds claude by family alias, so a new model needs no new list", () => {
    expect((HARNESS_MODEL_SEED.claude ?? []).map((model) => model.id)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(HARNESS_MODEL_SEED.claude?.find((model) => model.isDefault)?.id).toBe("fable");
    expect(HARNESS_MODEL_SEED.codex?.find((model) => model.isDefault)?.id).toBe("gpt-6.1-sol");
  });

  it("seeds opencode with the Codex models through the ChatGPT login, and no default of its own", () => {
    const codex = (HARNESS_MODEL_SEED.codex ?? []).map((model) => `openai/${model.id}`);
    expect((HARNESS_MODEL_SEED.opencode ?? []).map((model) => model.id)).toEqual(codex);
    expect(HARNESS_MODEL_SEED.opencode?.some((model) => model.isDefault)).toBe(false);
    expect(HARNESS_MODEL_SEED.opencode?.[0]?.id).toBe(OPENCODE_DEFAULT_MODEL);
    expect(composeLaunchArgv("opencode", { model: OPENCODE_DEFAULT_MODEL })).toEqual([
      "opencode",
      "--model",
      "openai/gpt-6.1-sol",
    ]);
  });

  it("clamps an effort the harness does not take at all to the highest it does", () => {
    expect(composeLaunchArgv("claude", { effort: "ultra" })).toEqual(["claude", "--effort", "max"]);
    // What the chosen model takes was applied by the server before this; the composer passes it.
    expect(composeLaunchArgv("codex", { model: "gpt-6.1-sol", effort: "ultra" })).toEqual([
      "codex",
      "--model",
      "gpt-6.1-sol",
      "-c",
      "model_reasoning_effort=ultra",
    ]);
    const protocol = composeProtocolArgv("claude", { effort: "ultra" }, "provider-1");
    expect(Array.isArray(protocol) && protocol.join(" ")).toContain("--effort max");
  });
});

describe("takesReviewFollowUp", () => {
  it("is offered only where delivery has an agent to start (verify 2026-10-10)", () => {
    expect(["claude", "codex", "opencode", "pi"].filter(takesReviewFollowUp)).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
    ]);
    expect(takesReviewFollowUp("run")).toBe(false);
    expect(takesReviewFollowUp("shell")).toBe(false);
  });
});

describe("resumesOwnHarness", () => {
  it("resumes an agent or a shell, never a `mend run` command (verify 2026-10-11)", () => {
    expect(["claude", "codex", "opencode", "pi", "shell"].every(resumesOwnHarness)).toBe(true);
    expect(resumesOwnHarness("run")).toBe(false);
  });
});
