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
import { startSession, type StartCalls } from "./start-session.ts";

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
        autoLand: true,
      }),
    ).toEqual({ prompt: "Fix it", model: "gpt-6.1", effort: "high", speed: "fast" });
  });
});

/** Start calls that record what they were asked, in order; `launch` answers as given. */
const recording = (launch: StartCalls["launch"] = () => Promise.resolve()) => {
  const calls: Array<string> = [];
  const fake: StartCalls = {
    create: (projectId, agent, autoLand) => {
      calls.push(`create ${projectId} ${agent} ${String(autoLand)}`);
      return Promise.resolve({ id: SessionId.make("s-new") });
    },
    createInWorktree: (worktreeId, agent, autoLand) => {
      calls.push(`join ${worktreeId} ${agent} ${String(autoLand)}`);
      return Promise.resolve({ id: SessionId.make("s-join") });
    },
    launch: (sessionId, agent, fields) => {
      calls.push(`launch ${sessionId} ${agent} ${JSON.stringify(fields)}`);
      return launch(sessionId, agent, fields);
    },
  };
  return { calls, fake };
};

describe("startSession", () => {
  const spec = {
    agent: "claude",
    prompt: "Fix it",
    model: "opus",
    effort: null,
    speed: null,
    autoLand: false,
  } as const;

  it("makes a new worktree, or joins the one picked, then starts the agent on the task", async () => {
    const { calls, fake } = recording();
    await expect(startSession(fake, "p1", { _tag: "new" }, spec)).resolves.toBe("s-new");
    await expect(
      startSession(fake, "p1", { _tag: "existing", id: "w1", branch: "mend/a" }, spec),
    ).resolves.toBe("s-join");
    expect(calls).toEqual([
      "create p1 claude false",
      'launch s-new claude {"prompt":"Fix it","model":"opus"}',
      "join w1 claude false",
      'launch s-join claude {"prompt":"Fix it","model":"opus"}',
    ]);
  });

  it("answers with the session even when its agent fails to start: the session page shows that", async () => {
    const { fake } = recording(() => Promise.reject(new Error("no login")));
    await expect(startSession(fake, "p1", { _tag: "new" }, spec)).resolves.toBe("s-new");
  });

  it("fails, and starts nothing, when the session can't be made", async () => {
    const { calls, fake } = recording();
    const refusing: StartCalls = {
      ...fake,
      create: () => Promise.reject(new Error("The project is gone.")),
    };
    await expect(startSession(refusing, "p1", { _tag: "new" }, spec)).rejects.toThrow(
      "The project is gone.",
    );
    expect(calls).toEqual([]);
  });
});
