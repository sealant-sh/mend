import { describe, expect, it, vi } from "vitest";

import type { OpenAction, OpenState } from "./open-flow.js";
import { OpenRunner, type OpenEffects, type OpenTarget } from "./open-runner.js";
import { rowCapability, type RowCapability } from "./session-capability.js";
import type { Project, Session } from "./types.js";
import type { WindowRole } from "./window-role.js";

const WORKSPACE = "61aaf28f-f715-4ce1-89be-8626d33acbb6";

const project: Project = {
  id: "project-1",
  name: "newsroom-api",
  originUrl: null,
  storePath: "/store/newsroom-api",
  defaultBranch: "main",
};

const session = (overrides: Partial<Session> = {}): Session => ({
  id: "session-1",
  projectId: project.id,
  harness: "claude",
  model: null,
  label: "add-rate-limit",
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  status: "running",
  sealantWorkspaceId: WORKSPACE,
  summary: null,
  createdAt: "2026-10-19T09:00:00.000Z",
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
  ...overrides,
});

type Facts = Pick<Session, "status" | "sealantWorkspaceId">;

/** A world where everything is set up and the session runs with a workspace, unless told otherwise. */
const world = (
  overrides: Partial<OpenEffects> & { readonly reads?: ReadonlyArray<Facts> } = {},
) => {
  let clock = 0;
  const reads = [...(overrides.reads ?? [{ status: "running", sealantWorkspaceId: WORKSPACE }])];
  const states: Array<OpenState> = [];
  const effects = {
    capability: async (): Promise<RowCapability> => ({ kind: "open" }),
    refuse: vi.fn(),
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    thisWindow: (): WindowRole => ({ kind: "local" }),
    focusAgentTerminal: vi.fn(async () => undefined),
    focusProgress: vi.fn(),
    remoteSshInstalled: () => true,
    installRemoteSsh: vi.fn(async () => undefined),
    workspaceSsh: async (): Promise<"ready" | "needsSetup"> => "ready",
    sshConsent: (): "given" | "never" => "given",
    askSshConsent: vi.fn(async () => true),
    setUpWorkspaceSsh: vi.fn(async () => undefined),
    seedRemotePlatform: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    sessionNow: vi.fn(async (_id: string) => {
      const next = reads.length > 1 ? reads.shift() : reads[0];
      if (next === undefined) throw new Error("the test world has no session read");
      return next;
    }),
    openFolder: vi.fn(async () => undefined),
    render: (_id: string, _name: string, state: OpenState) => {
      states.push(state);
    },
    report: vi.fn(async (): Promise<OpenAction | undefined> => undefined),
    ...overrides,
  } satisfies OpenEffects;
  return { effects, states, runner: new OpenRunner(effects, { pollMs: 2000 }) };
};

const target = (overrides: Partial<Session> = {}): OpenTarget => ({
  session: session(overrides),
  project,
});

describe("OpenRunner, a session Ana launched", () => {
  const anas = (sharedControlEnabledAt: string | null) =>
    target({ ownerUserId: "ana", workspaceLauncherUserId: "ana", sharedControlEnabledAt });
  /** Dana's world, reading capabilities the way the extension does. */
  const danas = () =>
    world({
      capability: async (session) =>
        rowCapability({ session, viewer: "dana", members: [{ userId: "ana", name: "Ana" }] }),
    });

  it("opens nothing, from any entry point: it says why once and offers Watch terminal with shared control", async () => {
    const { effects, runner, states } = danas();
    const shared = anas("2026-10-19T09:00:00.000Z");
    expect(await runner.open(shared, "follow-setting")).toBe("refused");
    expect(effects.refuse).toHaveBeenCalledTimes(1);
    expect(effects.refuse).toHaveBeenCalledWith(
      shared,
      "Ana launched this workspace · Remote-SSH opens it only for them",
      "Watch terminal",
    );
    expect(effects.openFolder).not.toHaveBeenCalled();
    expect(effects.resume).not.toHaveBeenCalled();
    expect(effects.installRemoteSsh).not.toHaveBeenCalled();
    expect(effects.seedRemotePlatform).not.toHaveBeenCalled();
    expect(effects.report).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it("offers Review when shared control is off, and Open in New Window refuses the same way", async () => {
    const { effects, runner } = danas();
    expect(await runner.open(anas(null), "new-window")).toBe("refused");
    expect(effects.refuse).toHaveBeenCalledWith(
      anas(null),
      "Ana launched this workspace · Remote-SSH opens it only for them",
      "Review",
    );
    expect(effects.openFolder).not.toHaveBeenCalled();
  });

  it("still opens Dana's own session in the same world", async () => {
    const { effects, runner } = danas();
    expect(await runner.open(target(), "follow-setting")).toBe("opened");
    expect(effects.refuse).not.toHaveBeenCalled();
    expect(effects.openFolder).toHaveBeenCalledTimes(1);
  });
});

describe("OpenRunner", () => {
  it("joins a second open of the same session: one window, the first open's progress shown", async () => {
    const { effects, runner } = world();
    const first = runner.open(target(), "follow-setting");
    const second = runner.open(target(), "follow-setting");
    expect(await Promise.all([first, second])).toEqual(["opened", "opened"]);
    expect(effects.openFolder).toHaveBeenCalledTimes(1);
    expect(effects.focusProgress).toHaveBeenCalledTimes(1);
    expect(effects.focusProgress).toHaveBeenCalledWith("session-1");
  });

  it("opens again once the first open has settled", async () => {
    const { effects, runner } = world();
    await runner.open(target(), "follow-setting");
    await runner.open(target(), "follow-setting");
    expect(effects.openFolder).toHaveBeenCalledTimes(2);
    expect(effects.focusProgress).not.toHaveBeenCalled();
  });

  it("lets VS Code follow the person's setting for Open, and forces a window for Open in New Window", async () => {
    const { effects, runner } = world();
    await runner.open(target(), "follow-setting");
    await runner.open(target(), "new-window");
    expect(effects.openFolder).toHaveBeenNthCalledWith(1, WORKSPACE, {});
    expect(effects.openFolder).toHaveBeenNthCalledWith(2, WORKSPACE, { forceNewWindow: true });
  });

  it("resumes a stopped session once, waits for its workspace, and opens it", async () => {
    const { effects, runner, states } = world({
      reads: [
        { status: "stopped", sealantWorkspaceId: null },
        { status: "starting", sealantWorkspaceId: null },
        { status: "starting", sealantWorkspaceId: null },
        { status: "running", sealantWorkspaceId: WORKSPACE },
      ],
    });
    expect(
      await runner.open(target({ status: "stopped", sealantWorkspaceId: null }), "follow-setting"),
    ).toBe("opened");
    expect(effects.resume).toHaveBeenCalledTimes(1);
    expect(effects.resume).toHaveBeenCalledWith("session-1");
    expect(effects.openFolder).toHaveBeenCalledTimes(1);
    expect(states.map((state) => state.kind)).toEqual([
      "preparing",
      "awaitingWorkspace",
      "opening",
      "done",
    ]);
  });

  it("never resumes a session that is already starting: it waits for the workspace", async () => {
    const { effects, runner } = world({
      reads: [
        { status: "starting", sealantWorkspaceId: null },
        { status: "running", sealantWorkspaceId: WORKSPACE },
      ],
    });
    expect(
      await runner.open(target({ status: "starting", sealantWorkspaceId: null }), "new-window"),
    ).toBe("opened");
    expect(effects.resume).not.toHaveBeenCalled();
    expect(effects.sessionNow).toHaveBeenCalledTimes(2);
    expect(effects.openFolder).toHaveBeenCalledWith(WORKSPACE, { forceNewWindow: true });
  });

  it("gives up waiting with Retry when the workspace never comes", async () => {
    const { effects, runner } = world({
      reads: [{ status: "starting", sealantWorkspaceId: null }],
    });
    expect(await runner.open(target(), "follow-setting")).toBe("failed");
    expect(effects.openFolder).not.toHaveBeenCalled();
    expect(effects.report).toHaveBeenCalledWith(
      "session-1",
      "add-rate-limit's workspace did not start in time",
      "Retry",
    );
  });

  it("installs Remote-SSH as a step of the same open, then opens", async () => {
    let installed = false;
    const { effects, runner, states } = world({
      remoteSshInstalled: () => installed,
      installRemoteSsh: vi.fn(async () => {
        installed = true;
      }),
    });
    expect(await runner.open(target(), "follow-setting")).toBe("opened");
    expect(effects.installRemoteSsh).toHaveBeenCalledTimes(1);
    expect(effects.openFolder).toHaveBeenCalledTimes(1);
    expect(states[0]).toEqual({
      kind: "preparing",
      step: { kind: "installingRemoteSsh" },
      since: 0,
    });
  });

  it("asks the one consent question when SSH was never set up, and stops quietly on no", async () => {
    const { effects, runner } = world({
      workspaceSsh: async () => "needsSetup",
      sshConsent: () => "never",
      askSshConsent: vi.fn(async () => false),
    });
    expect(await runner.open(target(), "follow-setting")).toBe("cancelled");
    expect(effects.askSshConsent).toHaveBeenCalledTimes(1);
    expect(effects.setUpWorkspaceSsh).not.toHaveBeenCalled();
    expect(effects.openFolder).not.toHaveBeenCalled();
    expect(effects.report).not.toHaveBeenCalled();
  });

  it("sets SSH up after a yes, then opens", async () => {
    const { effects, runner } = world({
      workspaceSsh: async () => "needsSetup",
      sshConsent: () => "never",
    });
    expect(await runner.open(target(), "follow-setting")).toBe("opened");
    expect(effects.askSshConsent).toHaveBeenCalledTimes(1);
    expect(effects.setUpWorkspaceSsh).toHaveBeenCalledTimes(1);
    expect(effects.openFolder).toHaveBeenCalledTimes(1);
  });

  it("sets SSH up without a question once consent was given", async () => {
    const { effects, runner, states } = world({ workspaceSsh: async () => "needsSetup" });
    expect(await runner.open(target(), "follow-setting")).toBe("opened");
    expect(effects.askSshConsent).not.toHaveBeenCalled();
    expect(effects.setUpWorkspaceSsh).toHaveBeenCalledTimes(1);
    expect(states[0]).toMatchObject({ kind: "preparing", step: { kind: "settingUpWorkspaceSsh" } });
  });

  it("seeds the Remote-SSH platform before every window it opens", async () => {
    const order: Array<string> = [];
    const { runner } = world({
      seedRemotePlatform: async () => {
        order.push("seed");
      },
      openFolder: async () => {
        order.push("openFolder");
      },
    });
    await runner.open(target(), "follow-setting");
    await runner.open(target(), "follow-setting");
    expect(order).toEqual(["seed", "openFolder", "seed", "openFolder"]);
  });

  it("focuses the agent's terminal when this window already is the workspace", async () => {
    const { effects, runner } = world({
      thisWindow: (): WindowRole => ({ kind: "workspace", workspaceId: WORKSPACE }),
    });
    expect(await runner.open(target(), "follow-setting")).toBe("focused");
    expect(effects.focusAgentTerminal).toHaveBeenCalledTimes(1);
    expect(effects.openFolder).not.toHaveBeenCalled();
    expect(effects.resume).not.toHaveBeenCalled();
  });

  it("reports a failure once, with the action that helps", async () => {
    const { effects, runner } = world({
      workspaceSsh: async () => "needsSetup",
      setUpWorkspaceSsh: vi.fn(async () => {
        throw new Error("~/.ssh/config is not writable");
      }),
    });
    expect(await runner.open(target(), "follow-setting")).toBe("failed");
    expect(effects.report).toHaveBeenCalledTimes(1);
    expect(effects.report).toHaveBeenCalledWith(
      "session-1",
      "~/.ssh/config is not writable",
      "Set up",
    );
    expect(effects.openFolder).not.toHaveBeenCalled();
  });

  it("runs a new open when she picks Retry", async () => {
    let failures = 1;
    const { effects, runner } = world({
      openFolder: vi.fn(async () => {
        if (failures-- > 0) throw new Error("Remote-SSH refused the window");
      }),
      report: vi.fn(async (): Promise<OpenAction | undefined> => "Retry"),
    });
    expect(await runner.open(target(), "follow-setting")).toBe("failed");
    await vi.waitFor(() => expect(effects.openFolder).toHaveBeenCalledTimes(2));
    expect(effects.report).toHaveBeenCalledTimes(1);
    expect(effects.report).toHaveBeenCalledWith(
      "session-1",
      "Remote-SSH refused the window",
      "Retry",
    );
  });
});
