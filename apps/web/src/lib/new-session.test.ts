import { SessionId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { ConnectedAccountDto } from "./api.ts";
import {
  agentLogin,
  landingChoice,
  launchFields,
  loginBlock,
  noAgentLogin,
  promptProblem,
  startingAgent,
  startingProject,
} from "./new-session.ts";
import { composerStart, type StartCalls } from "./start-session.ts";

const at = new Date("2026-11-18T09:00:00Z");

const account = (
  provider: ConnectedAccountDto["provider"],
  extra: Partial<Pick<ConnectedAccountDto, "status" | "isDefault">> = {},
): ConnectedAccountDto => ({
  id: `${provider}-1`,
  provider,
  name: "default",
  kind: "oauth-token",
  status: extra.status ?? "active",
  metadata: {},
  connectedAt: at,
  updatedAt: at,
  lastUsedAt: null,
  isDefault: extra.isDefault ?? true,
});

describe("agentLogin", () => {
  it("is ready only with a chosen, active login for the agent's provider", () => {
    expect(agentLogin([account("claude")], "claude")).toBe("ready");
    expect(agentLogin([account("claude")], "codex")).toBe("none");
    expect(agentLogin([account("claude", { status: "invalid" })], "claude")).toBe("refused");
    expect(agentLogin([account("claude", { status: "archived" })], "claude")).toBe("none");
    expect(agentLogin([account("claude", { isDefault: false })], "claude")).toBe("unchosen");
  });

  it("runs opencode and pi on the Codex login", () => {
    expect(agentLogin([account("codex")], "pi")).toBe("ready");
    expect(agentLogin([account("codex")], "opencode")).toBe("ready");
    expect(agentLogin([account("claude")], "pi")).toBe("none");
  });

  it("knows when the person holds no agent login at all", () => {
    expect(noAgentLogin([])).toBe(true);
    expect(noAgentLogin([account("github")])).toBe(true);
    expect(noAgentLogin([account("claude", { status: "invalid" })])).toBe(false);
  });
});

describe("loginBlock", () => {
  it("lets a ready agent start", () => {
    expect(loginBlock("claude", "ready", [])).toBeNull();
  });

  it("names the missing login, and an agent that can start instead", () => {
    expect(loginBlock("codex", "none", ["claude"])).toEqual({
      title: "Codex can't start.",
      text: "You haven't added a Codex login. Add one in your account settings, or pick Claude Code.",
      action: "Add Codex login",
      hint: "You can start the session once Codex has a login.",
    });
    expect(loginBlock("pi", "unchosen", [])?.action).toBe("Choose a Codex login");
    expect(loginBlock("claude", "refused", [])?.text).toBe(
      "Claude Code refused your login. Connect it again in your account settings.",
    );
  });
});

describe("what the composer opens on", () => {
  it("starts on the agent last used, and on Claude Code after a shell or nothing", () => {
    expect(startingAgent({ harness: "codex", byHarness: {} })).toBe("codex");
    expect(startingAgent({ harness: "shell", byHarness: {} })).toBe("claude");
    expect(startingAgent({ harness: null, byHarness: {} })).toBe("claude");
  });

  it("starts in the project last used while it still exists", () => {
    const projects = [{ id: "a" }, { id: "b" }];
    expect(startingProject(projects, "b")?.id).toBe("b");
    expect(startingProject(projects, "gone")?.id).toBe("a");
    expect(startingProject([], null)).toBeUndefined();
  });
});

describe("landingChoice", () => {
  it("starts from the person's automation and keeps what they pick", () => {
    expect(landingChoice({ autoLand: "inherit" }, true, null)).toEqual({
      _tag: "pick",
      land: true,
    });
    expect(landingChoice({ autoLand: "on" }, false, null)).toEqual({ _tag: "pick", land: false });
    expect(landingChoice({ autoLand: "inherit" }, true, false)).toEqual({
      _tag: "pick",
      land: false,
    });
  });

  it("can't land in a project whose own policy is off", () => {
    expect(landingChoice({ autoLand: "off" }, true, true)).toEqual({ _tag: "project-off" });
  });
});

describe("the start request", () => {
  it("refuses a task the agent would read as an option", () => {
    expect(promptProblem("  --help me")).not.toBeNull();
    expect(promptProblem("Fix the -1 offset")).toBeNull();
  });

  it("sends only what was chosen", () => {
    expect(
      launchFields({
        agent: "claude",
        prompt: "  ",
        model: null,
        effort: null,
        speed: null,
        permission: null,
        autoLand: null,
      }),
    ).toEqual({});
    expect(
      launchFields({
        agent: "codex",
        prompt: " Fix it ",
        model: "gpt-6.1",
        effort: "high",
        speed: "fast",
        permission: "ask",
        autoLand: true,
      }),
    ).toEqual({
      prompt: "Fix it",
      model: "gpt-6.1",
      effort: "high",
      speed: "fast",
      permissionMode: "ask",
    });
  });
});

/** Mend's start call, recording what it was asked; it answers as given. */
const recording = (answer: Promise<{ readonly id: SessionId }>) => {
  const calls: Array<string> = [];
  const fake: StartCalls = {
    start: (key, target, harness, launch) => {
      calls.push(`${key} ${JSON.stringify(target)} ${harness} ${JSON.stringify(launch)}`);
      return answer;
    },
  };
  return { calls, fake };
};

describe("a composer's start", () => {
  const spec = {
    agent: "claude",
    prompt: "Fix it",
    model: "opus",
    effort: null,
    speed: null,
    permission: null,
    autoLand: false,
  } as const;

  it("makes the session and launches it on the task in one call (SLNT-1239)", async () => {
    const { calls, fake } = recording(Promise.resolve({ id: SessionId.make("s-new") }));
    await expect(composerStart(fake, "p1", { _tag: "new" }, spec).start("k1")).resolves.toBe(
      "s-new",
    );
    await composerStart(fake, "p1", { _tag: "existing", id: "w1", branch: "mend/a" }, spec).start(
      "k2",
    );
    expect(calls).toEqual([
      'k1 {"_tag":"project","projectId":"p1","autoLand":false} claude {"prompt":"Fix it","model":"opus"}',
      'k2 {"_tag":"worktree","worktreeId":"w1","autoLand":false} claude {"prompt":"Fix it","model":"opus"}',
    ]);
  });

  it("fails when Mend refuses the start", async () => {
    const { fake } = recording(Promise.reject(new Error("The project is gone.")));
    await expect(composerStart(fake, "p1", { _tag: "new" }, spec).start("k1")).rejects.toThrow(
      "The project is gone.",
    );
  });
});
