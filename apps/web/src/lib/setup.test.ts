import { describe, expect, it } from "vitest";

import { setupSteps } from "./onboarding.ts";
import {
  afterSignIn,
  firstProjectEntry,
  firstProjectSkippable,
  hasAgentLogin,
  homeEntry,
  namesOrganization,
  nextStepPage,
  previousStep,
  railSteps,
  signInEntry,
  STEP_PAGES,
  welcomeEntry,
} from "./setup.ts";

const noKey = {
  mode: "mend-key",
  key: { exists: false, publicKey: null, fingerprint: null },
} as const;
const withKey = {
  mode: "mend-key",
  key: { exists: true, publicKey: "ssh-ed25519 AAAA mend:ada", fingerprint: "SHA256:abc" },
} as const;
const bridge = {
  mode: "bridge",
  key: { exists: false, publicKey: null, fingerprint: null },
} as const;

/** An agent login read that fails the test if it is asked when it decides nothing. */
const notAsked = () => Promise.reject(new Error("asked for the agent login"));
const loggedIn = () => Promise.resolve(true);
const notLoggedIn = () => Promise.resolve(false);

describe("where /welcome sends a person", () => {
  it("shows Git access to anyone without it, project or not", async () => {
    expect(
      await welcomeEntry({
        access: noKey,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: false,
        ended: false,
        hasAgentLogin: notAsked,
      }),
    ).toBe("git-access");
    expect(
      await welcomeEntry({
        access: noKey,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: true,
        ended: false,
        hasAgentLogin: notAsked,
      }),
    ).toBe("git-access");
  });

  it("keeps a new member in an organization with projects on Git access until they log an agent in", async () => {
    // Their key exists from their first visit: a reload must not send them out of setup.
    expect(
      await welcomeEntry({
        access: withKey,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: true,
        ended: false,
        hasAgentLogin: notLoggedIn,
      }),
    ).toBe("git-access");
    expect(
      await welcomeEntry({
        access: withKey,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: false,
        ended: false,
        hasAgentLogin: notLoggedIn,
      }),
    ).toBe("git-access");
  });

  it("sends someone with an agent login on to First project, or Mend once they have a project", async () => {
    expect(
      await welcomeEntry({
        access: bridge,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: false,
        ended: false,
        hasAgentLogin: loggedIn,
      }),
    ).toBe("first-project");
    expect(
      await welcomeEntry({
        access: withKey,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: true,
        ended: false,
        hasAgentLogin: loggedIn,
      }),
    ).toBe("home");
  });
});

describe("who names the organization during setup", () => {
  it("is the first account: the server's operator and its organization's owner", () => {
    expect(namesOrganization({ operator: true, role: "owner" })).toBe(true);
  });

  it("is never someone who joined from an invitation, even as an owner", () => {
    expect(namesOrganization({ operator: false, role: "owner" })).toBe(false);
    expect(namesOrganization({ operator: false, role: "member" })).toBe(false);
  });

  it("is not an operator who joined another organization as a member", () => {
    expect(namesOrganization({ operator: true, role: "member" })).toBe(false);
  });
});

describe("where /welcome sends someone who still owes Command line", () => {
  it("shows Git access: Command line's Continue and Skip both lead there, so nothing loops", async () => {
    expect(
      await welcomeEntry({
        access: noKey,
        namesOrganization: true,
        commandLineOwed: true,
        hasProject: false,
        ended: false,
        hasAgentLogin: notAsked,
      }),
    ).toBe("git-access");
  });
});

describe("where /welcome/first-project sends a person", () => {
  it("sends someone without Git access back to that step", () => {
    expect(firstProjectEntry({ access: noKey, hasProject: false })).toBe("git-access");
  });

  it("shows the step to someone with Git access and no project, whatever their agent login", () => {
    expect(firstProjectEntry({ access: bridge, hasProject: false })).toBe("first-project");
  });

  it("sends someone who can see a project on to How Mend fits together, such as a member of an organization that shares one", () => {
    expect(firstProjectEntry({ access: withKey, hasProject: true })).toBe("nouns");
  });
});

describe("who may skip First project", () => {
  it("lets a member of an organization with others skip, but not its only account", () => {
    expect(firstProjectSkippable(1)).toBe(false);
    expect(firstProjectSkippable(2)).toBe(true);
  });
});

describe("where signing in with no page to return to goes", () => {
  it("opens setup for someone without Git access", async () => {
    expect(
      await signInEntry({
        access: noKey,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: true,
        ended: false,
        hasAgentLogin: notAsked,
      }),
    ).toBe("git-access");
  });

  it("opens Mend for someone with Git access and a project, agent login or not", async () => {
    expect(
      await signInEntry({
        access: withKey,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: true,
        ended: false,
        hasAgentLogin: notAsked,
      }),
    ).toBe("home");
  });

  it("starts again at Command line for someone who left before Git access, unless they skipped it", async () => {
    const left = {
      namesOrganization: false,
      hasProject: false,
      ended: false,
      hasAgentLogin: notAsked,
    };
    expect(await signInEntry({ ...left, access: noKey, commandLineOwed: true })).toBe(
      "command-line",
    );
    expect(await signInEntry({ ...left, access: noKey, commandLineOwed: false })).toBe(
      "git-access",
    );
  });

  it("sends the first account with an agent login and no project to Organization, before First project", async () => {
    const first = { namesOrganization: true, commandLineOwed: false, hasProject: false };
    expect(
      await signInEntry({ ...first, access: withKey, ended: false, hasAgentLogin: loggedIn }),
    ).toBe("organization");
    expect(
      await welcomeEntry({ ...first, access: withKey, ended: false, hasAgentLogin: loggedIn }),
    ).toBe("organization");
  });

  it("with no project, opens the step left", async () => {
    expect(
      await signInEntry({
        access: bridge,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: false,
        ended: false,
        hasAgentLogin: loggedIn,
      }),
    ).toBe("first-project");
    expect(
      await signInEntry({
        access: withKey,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: false,
        ended: false,
        hasAgentLogin: notLoggedIn,
      }),
    ).toBe("git-access");
  });
});

const account = (provider: "claude" | "codex" | "github", status: "active" | "invalid") => ({
  id: `${provider}-1`,
  provider,
  name: "default",
  kind: "oauth-token",
  status,
  metadata: {},
  connectedAt: new Date(0),
  updatedAt: new Date(0),
  lastUsedAt: null,
  isDefault: true,
});

describe("agent logins", () => {
  it("counts a working Claude or Codex login, not GitHub or a login that stopped working", () => {
    expect(hasAgentLogin({ accounts: [] })).toBe(false);
    expect(hasAgentLogin({ accounts: [account("github", "active")] })).toBe(false);
    expect(hasAgentLogin({ accounts: [account("claude", "invalid")] })).toBe(false);
    expect(hasAgentLogin({ accounts: [account("codex", "active")] })).toBe(true);
  });
});

describe("after signing in", () => {
  it("returns to the page that sent the person, without reading setup", async () => {
    expect(await afterSignIn("/sessions/s-1", notAsked)).toBe("/sessions/s-1");
  });

  it("with no page to return to, opens the page setup answers", async () => {
    expect(await afterSignIn("/", () => Promise.resolve("git-access"))).toBe("/welcome");
    expect(await afterSignIn("/", () => Promise.resolve("first-project"))).toBe(
      "/welcome/first-project",
    );
    expect(await afterSignIn("/", () => Promise.resolve("home"))).toBe("/");
  });

  it("opens Mend when setup can't be read", async () => {
    expect(await afterSignIn("/", notAsked)).toBe("/");
  });
});

/** A read of the rest of setup that fails the test if `/` asks for it when it decides nothing. */
const fullNotRead = () => Promise.reject(new Error("read the rest of setup"));

describe("where opening Mend at / goes", () => {
  it("opens Mend for someone with Git access and a project, without reading the rest of setup", async () => {
    const quick = () => Promise.resolve({ access: withKey, hasProject: true, ended: false });
    expect(await homeEntry(quick, fullNotRead)).toBe("home");
    const bridged = () => Promise.resolve({ access: bridge, hasProject: true, ended: false });
    expect(await homeEntry(bridged, fullNotRead)).toBe("home");
  });

  it("opens Mend for someone this browser saw reach setup's last step, project or not", async () => {
    // A member who skipped First project, waiting for a teammate to share one.
    const skipped = () => Promise.resolve({ access: withKey, hasProject: false, ended: true });
    expect(await homeEntry(skipped, fullNotRead)).toBe("home");
  });

  it("sends someone who closed the tab after Agent login on to the step after it", async () => {
    const quick = () => Promise.resolve({ access: withKey, hasProject: false, ended: false });
    const full = (firstAccount: boolean) => () =>
      Promise.resolve({
        access: withKey,
        namesOrganization: firstAccount,
        commandLineOwed: false,
        hasProject: false,
        ended: false,
        hasAgentLogin: loggedIn,
      });
    expect(await homeEntry(quick, full(true))).toBe("organization");
    expect(await homeEntry(quick, full(false))).toBe("first-project");
  });

  it("gives the answer signing in gives for someone who left before Git access", async () => {
    const quick = () => Promise.resolve({ access: noKey, hasProject: false, ended: false });
    const full = (commandLineOwed: boolean) => () =>
      Promise.resolve({
        access: noKey,
        namesOrganization: true,
        commandLineOwed,
        hasProject: false,
        ended: false,
        hasAgentLogin: notAsked,
      });
    expect(await homeEntry(quick, full(true))).toBe("command-line");
    expect(await homeEntry(quick, full(false))).toBe("git-access");
  });

  it("opens Mend when setup can't be read", async () => {
    const quick = () => Promise.resolve({ access: noKey, hasProject: false, ended: false });
    expect(await homeEntry(fullNotRead, fullNotRead)).toBe("home");
    expect(await homeEntry(quick, fullNotRead)).toBe("home");
  });
});

describe("where signing in goes for someone who reached setup's last step here", () => {
  it("opens Mend, even with no project and no agent login", async () => {
    expect(
      await signInEntry({
        access: withKey,
        namesOrganization: false,
        commandLineOwed: false,
        hasProject: false,
        ended: true,
        hasAgentLogin: notAsked,
      }),
    ).toBe("home");
  });
});

const FIRST = setupSteps(true);
const JOINER = setupSteps(false);

/** Each step's state and whether it links, as `key:state` with a `→` for a link. */
const rail = (...args: Parameters<typeof railSteps>) =>
  railSteps(...args).map(({ key, state, page }) => `${key}:${state}${page === null ? "" : "→"}`);

describe("which steps beside the sheet lead back", () => {
  it("links every step the first account is past, but never Account, the current step or one not reached", () => {
    expect(
      rail({ steps: FIRST, step: "organization", reached: "organization", skipped: [] }),
    ).toEqual([
      "account:done",
      "cli:done→",
      "git:done→",
      "agent:done→",
      "organization:current",
      "project:later",
      "nouns:later",
    ]);
  });

  it("links a skipped step, so the person can do it now", () => {
    expect(
      rail({ steps: JOINER, step: "project", reached: "project", skipped: ["cli", "agent"] }),
    ).toEqual([
      "account:done",
      "cli:skipped→",
      "git:done→",
      "agent:skipped→",
      "project:current",
      "nouns:later",
    ]);
  });

  it("keeps the steps after the current one as links once the person went back from them", () => {
    expect(rail({ steps: FIRST, step: "cli", reached: "project", skipped: ["agent"] })).toEqual([
      "account:done",
      "cli:current",
      "git:done→",
      "agent:skipped→",
      "organization:done→",
      "project:left→",
      "nouns:later",
    ]);
  });

  it("says how the person left the last step, which no later page remembers them reaching", () => {
    const back = { steps: JOINER, step: "git", reached: "nouns", skipped: [] } as const;
    expect(rail(back).at(-1)).toBe("nouns:left→");
    expect(rail({ ...back, ended: "skipped" }).at(-1)).toBe("nouns:skipped→");
    expect(rail({ ...back, ended: "seen" }).at(-1)).toBe("nouns:done→");
    // On the step itself it is the current step, however it was left before.
    expect(rail({ ...back, step: "nouns", ended: "skipped" }).at(-1)).toBe("nouns:current");
  });

  it("treats a step remembered from the other list (the first account's Organization, for a joiner) as nothing reached", () => {
    expect(rail({ steps: JOINER, step: "git", reached: "organization", skipped: [] })).toEqual([
      "account:done",
      "cli:done→",
      "git:current",
      "agent:later",
      "project:later",
      "nouns:later",
    ]);
  });

  it("links each step to its own page, which sends nobody on", () => {
    const pages = railSteps({ steps: FIRST, step: "project", reached: "project", skipped: [] }).map(
      ({ page }) => page,
    );
    expect(pages).toEqual([
      null,
      "/welcome/command-line",
      "/welcome/git-access",
      "/welcome/agent-login",
      "/welcome/organization",
      null,
      null,
    ]);
    // Not `/welcome`, which sends someone past Git access on.
    expect(Object.values(STEP_PAGES)).not.toContain("/welcome");
  });
});

describe("where each step's Continue goes, the first time and on a visit back", () => {
  it("walks the first account's steps one by one to How Mend fits together, then out of setup", () => {
    expect(FIRST.map((step) => nextStepPage(FIRST, step))).toEqual([
      "/welcome/command-line",
      "/welcome/git-access",
      "/welcome/agent-login",
      "/welcome/organization",
      "/welcome/first-project",
      "/welcome/how-mend-fits",
      null,
    ]);
  });

  it("leads someone who joined from First project to How Mend fits together too", () => {
    expect(nextStepPage(JOINER, "project")).toBe("/welcome/how-mend-fits");
  });

  it("skips Organization for someone who joined", () => {
    expect(nextStepPage(JOINER, "agent")).toBe("/welcome/first-project");
  });

  it("never goes back: each Continue opens a later step than the page it is on", () => {
    for (const steps of [FIRST, JOINER]) {
      const order = steps.map((step) => nextStepPage(steps, step));
      steps.forEach((step, index) => {
        const next = order[index];
        if (next === null || next === undefined) return;
        const target = steps.find((key) => key !== "account" && STEP_PAGES[key] === next);
        expect(target === undefined ? -1 : steps.indexOf(target)).toBeGreaterThan(index);
      });
    }
  });
});

describe("the phone's back arrow", () => {
  it("goes to the step before, for every step after Command line", () => {
    expect(previousStep(FIRST, "account")).toBeNull();
    expect(previousStep(FIRST, "cli")).toBeNull();
    expect(previousStep(FIRST, "git")).toEqual({ key: "cli", page: "/welcome/command-line" });
    expect(previousStep(FIRST, "agent")).toEqual({ key: "git", page: "/welcome/git-access" });
    expect(previousStep(FIRST, "project")).toEqual({
      key: "organization",
      page: "/welcome/organization",
    });
    expect(previousStep(JOINER, "project")).toEqual({ key: "agent", page: "/welcome/agent-login" });
  });
});
