import { describe, expect, it, vi } from "vitest";

import {
  accountEmail,
  connectionOf,
  firstRun,
  missingSteps,
  openConsent,
  originLabel,
  parseSshConsent,
  projectMatch,
  runConnect,
  runSetUp,
  setUpTitle,
  TRY_AGAIN,
  useCli,
  viewMode,
  offerOf,
  type ConnectEffects,
  type FirstRun,
  type SetUpEffects,
  type SignInOutcome,
  type SshFacts,
} from "./first-run.js";
import type { OpenAction } from "./open-flow.js";
import { OpenRunner, type OpenEffects } from "./open-runner.js";
import type { RowCapability } from "./session-capability.js";
import type { Project, Session } from "./types.js";
import type { WindowRole } from "./window-role.js";

const MINI = "http://mend-mini.local:3105";
const offer = { url: MINI, email: "dana@example.com" };

const connectEffects = (outcomes: ReadonlyArray<SignInOutcome>, picks: ReadonlyArray<string>) => {
  const signIns = [...outcomes];
  const answers = [...picks];
  const effects = {
    askUrl: vi.fn(async (prefill: string | null) => prefill ?? MINI),
    signIn: vi.fn(async (): Promise<SignInOutcome> => signIns.shift() ?? { kind: "cancelled" }),
    toast: vi.fn(),
    fail: vi.fn(async () => (answers.shift() === TRY_AGAIN ? TRY_AGAIN : undefined)),
    useCliSignIn: vi.fn(async () => undefined),
  } satisfies ConnectEffects;
  return effects;
};

describe("Connect (h2)", () => {
  it("toasts exactly once for one sign-in, in the story's words", async () => {
    const effects = connectEffects([{ kind: "signedIn", email: "dana@example.com" }], []);
    expect(await runConnect(null, effects)).toBe(true);
    expect(effects.toast.mock.calls).toEqual([
      ["Signed in to mend-mini.local as dana@example.com"],
    ]);
    expect(effects.fail).not.toHaveBeenCalled();
  });

  it("ends a denial in one error toast with Try again, which asks again from her URL", async () => {
    const effects = connectEffects(
      [
        { kind: "failed", reason: "Sign-in denied in the browser." },
        { kind: "signedIn", email: "dana@example.com" },
      ],
      [TRY_AGAIN],
    );
    expect(await runConnect("http://typed.example:3105", effects)).toBe(true);
    expect(effects.fail.mock.calls).toEqual([["Sign-in denied in the browser."]]);
    expect(effects.askUrl.mock.calls).toEqual([
      ["http://typed.example:3105"],
      ["http://typed.example:3105"],
    ]);
    expect(effects.toast).toHaveBeenCalledTimes(1);
  });

  it("says nothing when she cancels, and stops after a failure she does not retry", async () => {
    const cancelled = connectEffects([{ kind: "cancelled" }], []);
    expect(await runConnect(MINI, cancelled)).toBe(false);
    expect(cancelled.toast).not.toHaveBeenCalled();
    expect(cancelled.fail).not.toHaveBeenCalled();

    const unreachable = connectEffects([{ kind: "failed", reason: "Cannot reach Mend" }], []);
    expect(await runConnect(MINI, unreachable)).toBe(false);
    expect(unreachable.fail).toHaveBeenCalledTimes(1);
    expect(unreachable.signIn).toHaveBeenCalledTimes(1);
    expect(unreachable.toast).not.toHaveBeenCalled();
  });
});

describe("a machine whose Mend CLI is signed in (h1 variant)", () => {
  const cli = { url: MINI, token: "mdt_cli" };

  it("is not connected until she says so, and is offered Use it with the CLI's server and account", () => {
    const connection = connectionOf({ configured: null, own: null, cli });
    expect(connection).toEqual({ kind: "notConnected", prefill: MINI, cli });
    const state = firstRun({
      connection,
      offer,
      ssh: null,
      consent: "never",
      project: { kind: "unread" },
      workspaceWindow: false,
    });
    const mode = viewMode(state);
    expect(mode).toEqual({ kind: "welcome", welcome: { kind: "useCli", offer } });
    if (mode.kind !== "welcome") throw new Error("no welcome");
    expect(offerOf(mode.welcome)).toMatchObject({
      message: "Mend at mend-mini.local:3105 · signed in as dana@example.com (from the Mend CLI)",
      action: { label: "Use it", command: "mend.useCli" },
    });
  });

  it("offers Connect, not Use it, when Mend did not name the CLI's account", () => {
    const state = firstRun({
      connection: connectionOf({ configured: null, own: null, cli }),
      offer: null,
      ssh: null,
      consent: "never",
      project: { kind: "unread" },
      workspaceWindow: false,
    });
    expect(viewMode(state)).toEqual({ kind: "welcome", welcome: { kind: "connect" } });
  });

  it("Use it asks nothing: no URL, no browser, no toast", async () => {
    const effects = connectEffects([], []);
    await useCli(offer, effects);
    expect(effects.useCliSignIn.mock.calls).toEqual([[MINI]]);
    expect(effects.askUrl).not.toHaveBeenCalled();
    expect(effects.signIn).not.toHaveBeenCalled();
    expect(effects.toast).not.toHaveBeenCalled();
    expect(effects.fail).not.toHaveBeenCalled();
  });

  it("after Use it, the editor is connected on the CLI's sign-in", () => {
    expect(connectionOf({ configured: MINI, own: null, cli })).toEqual({
      kind: "connected",
      url: MINI,
      token: "mdt_cli",
      source: { kind: "cli" },
    });
  });

  it("after a sign-out in this editor, does not quietly fall back to the CLI's sign-in", () => {
    expect(connectionOf({ configured: MINI, own: { kind: "none", url: MINI }, cli })).toMatchObject(
      { kind: "notConnected" },
    );
  });

  it("names the account by the members entry of the signed-in user", () => {
    expect(
      accountEmail({ userId: "u2" }, [
        { userId: "u1", email: "ana@example.com" },
        { userId: "u2", email: "dana@example.com" },
      ]),
    ).toBe("dana@example.com");
    expect(accountEmail({ userId: "u3" }, [{ userId: "u1", email: "ana@example.com" }])).toBe(null);
  });
});

/** One machine: the consent record, Remote-SSH, the key and Host block, the platform seed. */
const machine = (start: Partial<Extract<SshFacts, { kind: "read" }>> = {}) => {
  const facts = { remoteSsh: false, workspaceSsh: false, platform: false, ...start };
  let consent: unknown;
  const ran: Array<string> = [];
  const setUp: SetUpEffects = {
    installRemoteSsh: async () => {
      ran.push("installRemoteSsh");
      facts.remoteSsh = true;
    },
    workspaceSsh: async () => {
      ran.push("workspaceSsh");
      facts.workspaceSsh = true;
    },
    seedPlatform: async () => {
      ran.push("seedPlatform");
      facts.platform = true;
    },
    recordConsent: async (given) => {
      consent = given;
    },
  };
  return {
    facts,
    ran,
    setUp,
    read: (): Extract<SshFacts, { kind: "read" }> => ({ kind: "read", ...facts }),
    consent: () => parseSshConsent(consent),
    skip: () => {
      consent = "skipped";
    },
  };
};

const session: Session = {
  id: "session-1",
  projectId: "project-1",
  harness: "claude",
  model: null,
  label: "add-rate-limit",
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  status: "running",
  sealantWorkspaceId: "61aaf28f-f715-4ce1-89be-8626d33acbb6",
  summary: null,
  createdAt: "2026-10-19T09:00:00.000Z",
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
};
const project: Project = {
  id: "project-1",
  name: "newsroom-api",
  originUrl: null,
  storePath: "/store/newsroom-api",
  defaultBranch: "main",
};

/** #1084's open runner on this machine: its consent read is the extension's (`open-command.ts`). */
const openOn = (box: ReturnType<typeof machine>) => {
  const effects = {
    capability: async (): Promise<RowCapability> => ({ kind: "open" }),
    refuse: vi.fn(),
    now: () => 0,
    sleep: async () => undefined,
    thisWindow: (): WindowRole => ({ kind: "local" }),
    focusAgentTerminal: vi.fn(async () => undefined),
    focusProgress: vi.fn(),
    remoteSshInstalled: () => box.facts.remoteSsh,
    installRemoteSsh: box.setUp.installRemoteSsh,
    workspaceSsh: async (): Promise<"ready" | "needsSetup"> =>
      box.facts.workspaceSsh ? "ready" : "needsSetup",
    sshConsent: () => openConsent(box.consent()),
    askSshConsent: vi.fn(async () => true),
    setUpWorkspaceSsh: vi.fn(async () => {
      await box.setUp.workspaceSsh();
      await box.setUp.recordConsent("given");
    }),
    seedRemotePlatform: box.setUp.seedPlatform,
    resume: vi.fn(async () => undefined),
    sessionNow: async () => session,
    openFolder: vi.fn(async () => undefined),
    render: () => undefined,
    report: vi.fn(async (): Promise<OpenAction | undefined> => undefined),
  } satisfies OpenEffects;
  return { effects, runner: new OpenRunner(effects) };
};

const connected = (box: ReturnType<typeof machine>): FirstRun =>
  firstRun({
    connection: { kind: "connected", url: MINI, token: "t", source: { kind: "cli" } },
    offer: null,
    ssh: box.read(),
    consent: box.consent(),
    project: { kind: "projects" },
    workspaceWindow: false,
  });

describe("Set up (h3)", () => {
  it("is the welcome's next step once connected, while workspace SSH is missing", () => {
    expect(viewMode(connected(machine()))).toEqual({
      kind: "welcome",
      welcome: { kind: "setUp" },
    });
  });

  it("runs every missing step in order, and records the consent", async () => {
    const box = machine();
    expect(await runSetUp(box.read(), box.setUp)).toEqual([
      "installRemoteSsh",
      "workspaceSsh",
      "seedPlatform",
    ]);
    expect(box.ran).toEqual(["installRemoteSsh", "workspaceSsh", "seedPlatform"]);
    expect(box.consent()).toBe("given");
    expect(viewMode(connected(box))).toEqual({ kind: "tree" });
  });

  it("runs only what is missing, and records the consent even when nothing was", async () => {
    const partial = machine({ remoteSsh: true, platform: true });
    await runSetUp(partial.read(), partial.setUp);
    expect(partial.ran).toEqual(["workspaceSsh"]);
    expect(partial.consent()).toBe("given");

    const done = machine({ remoteSsh: true, workspaceSsh: true, platform: true });
    await runSetUp(done.read(), done.setUp);
    expect(done.ran).toEqual([]);
    expect(done.consent()).toBe("given");
  });

  it("names what it sets up in its progress", () => {
    expect(setUpTitle(missingSteps(machine().read()))).toBe(
      "Setting up: Remote-SSH · an SSH key for Mend · one Host block in ~/.ssh/config",
    );
  });

  it("leaves Open nothing to ask, even when the Host block is gone again later", async () => {
    const box = machine();
    await runSetUp(box.read(), box.setUp);
    const ready = openOn(box);
    expect(await ready.runner.open({ session, project }, "follow-setting")).toBe("opened");
    expect(ready.effects.askSshConsent).not.toHaveBeenCalled();

    box.facts.workspaceSsh = false;
    const lost = openOn(box);
    expect(await lost.runner.open({ session, project }, "follow-setting")).toBe("opened");
    expect(lost.effects.askSshConsent).not.toHaveBeenCalled();
    expect(lost.effects.setUpWorkspaceSsh).toHaveBeenCalledTimes(1);
  });
});

describe("skipping Set up", () => {
  it("moves the welcome on, and leaves Open's one deferred question in place", async () => {
    const box = machine({ remoteSsh: true });
    box.skip();
    expect(viewMode(connected(box))).toEqual({ kind: "tree" });
    const open = openOn(box);
    expect(await open.runner.open({ session, project }, "follow-setting")).toBe("opened");
    expect(open.effects.askSshConsent).toHaveBeenCalledTimes(1);
    expect(box.consent()).toBe("given");

    const again = openOn(box);
    await again.runner.open({ session, project }, "follow-setting");
    expect(again.effects.askSshConsent).not.toHaveBeenCalled();
  });

  it("reads an unknown record as never given", () => {
    expect(parseSshConsent(undefined)).toBe("never");
    expect(parseSshConsent("yes")).toBe("never");
    expect(openConsent("skipped")).toBe("never");
  });
});

describe("her first project (h4)", () => {
  const atProject = (match: ReturnType<typeof projectMatch>) =>
    viewMode(
      firstRun({
        connection: { kind: "connected", url: MINI, token: "t", source: { kind: "cli" } },
        offer: null,
        ssh: { kind: "read", remoteSsh: true, workspaceSsh: true, platform: true },
        consent: "given",
        project: match,
        workspaceWindow: false,
      }),
    );

  it("offers Adopt <repo> from <origin> for a window on a repository Mend does not have", () => {
    const mode = atProject(
      projectMatch({
        read: true,
        projects: 0,
        unmatched: {
          name: "newsroom-api",
          origin: "git@github.com:acme/newsroom-api.git",
        },
      }),
    );
    expect(mode).toEqual({
      kind: "welcome",
      welcome: {
        kind: "adopt",
        name: "newsroom-api",
        origin: "git@github.com:acme/newsroom-api.git",
      },
    });
    if (mode.kind !== "welcome") throw new Error("no welcome");
    expect(offerOf(mode.welcome)).toMatchObject({
      message: "Adopt newsroom-api from github.com/acme/newsroom-api",
      action: { label: "Adopt", command: "mend.adoptHere" },
    });
  });

  it("offers Adopt a repository… in an empty window, and the sessions once a project exists", () => {
    expect(atProject(projectMatch({ read: true, projects: 0, unmatched: null }))).toEqual({
      kind: "welcome",
      welcome: { kind: "adoptRepository" },
    });
    expect(atProject(projectMatch({ read: true, projects: 1, unmatched: null }))).toEqual({
      kind: "tree",
    });
  });

  it("names an origin the same way in every URL form", () => {
    for (const origin of [
      "https://github.com/acme/newsroom-api.git",
      "https://token@github.com/acme/newsroom-api",
      "git@github.com:acme/newsroom-api.git",
      "ssh://git@github.com/acme/newsroom-api.git",
    ]) {
      expect(originLabel(origin), origin).toBe("github.com/acme/newsroom-api");
    }
  });
});

describe("a session's workspace window", () => {
  it("has first run behind it", () => {
    const state = firstRun({
      connection: { kind: "connected", url: MINI, token: "t", source: { kind: "cli" } },
      offer: null,
      ssh: null,
      consent: "never",
      project: { kind: "unread" },
      workspaceWindow: true,
    });
    expect(viewMode(state)).toEqual({ kind: "tree" });
  });
});
