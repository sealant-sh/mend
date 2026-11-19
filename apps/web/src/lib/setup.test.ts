import { describe, expect, it } from "vitest";

import {
  afterSignIn,
  firstProjectEntry,
  firstProjectSkippable,
  hasAgentLogin,
  namesOrganization,
  signInEntry,
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
    expect(await welcomeEntry({ access: noKey, namesOrganization: false, commandLineOwed: false, hasProject: false, hasAgentLogin: notAsked })).toBe(
      "git-access",
    );
    expect(await welcomeEntry({ access: noKey, namesOrganization: false, commandLineOwed: false, hasProject: true, hasAgentLogin: notAsked })).toBe(
      "git-access",
    );
  });

  it("keeps a new member in an organization with projects on Git access until they log an agent in", async () => {
    // Their key exists from their first visit: a reload must not send them out of setup.
    expect(
      await welcomeEntry({ access: withKey, namesOrganization: false, commandLineOwed: false, hasProject: true, hasAgentLogin: notLoggedIn }),
    ).toBe("git-access");
    expect(
      await welcomeEntry({ access: withKey, namesOrganization: false, commandLineOwed: false, hasProject: false, hasAgentLogin: notLoggedIn }),
    ).toBe("git-access");
  });

  it("sends someone with an agent login on to First project, or Mend once they have a project", async () => {
    expect(await welcomeEntry({ access: bridge, namesOrganization: false, commandLineOwed: false, hasProject: false, hasAgentLogin: loggedIn })).toBe(
      "first-project",
    );
    expect(await welcomeEntry({ access: withKey, namesOrganization: false, commandLineOwed: false, hasProject: true, hasAgentLogin: loggedIn })).toBe(
      "home",
    );
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

  it("sends someone who can see a project on to Mend, such as a member of an organization that shares one", () => {
    expect(firstProjectEntry({ access: withKey, hasProject: true })).toBe("home");
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
    expect(await signInEntry({ access: noKey, namesOrganization: false, commandLineOwed: false, hasProject: true, hasAgentLogin: notAsked })).toBe(
      "git-access",
    );
  });

  it("opens Mend for someone with Git access and a project, agent login or not", async () => {
    expect(await signInEntry({ access: withKey, namesOrganization: false, commandLineOwed: false, hasProject: true, hasAgentLogin: notAsked })).toBe(
      "home",
    );
  });

  it("starts again at Command line for someone who left before Git access, unless they skipped it", async () => {
    const left = { namesOrganization: false, hasProject: false, hasAgentLogin: notAsked };
    expect(await signInEntry({ ...left, access: noKey, commandLineOwed: true })).toBe(
      "command-line",
    );
    expect(await signInEntry({ ...left, access: noKey, commandLineOwed: false })).toBe(
      "git-access",
    );
  });

  it("sends the first account with an agent login and no project to Organization, before First project", async () => {
    const first = { namesOrganization: true, commandLineOwed: false, hasProject: false };
    expect(await signInEntry({ ...first, access: withKey, hasAgentLogin: loggedIn })).toBe(
      "organization",
    );
    expect(await welcomeEntry({ ...first, access: withKey, hasAgentLogin: loggedIn })).toBe(
      "organization",
    );
  });

  it("with no project, opens the step left", async () => {
    expect(await signInEntry({ access: bridge, namesOrganization: false, commandLineOwed: false, hasProject: false, hasAgentLogin: loggedIn })).toBe(
      "first-project",
    );
    expect(
      await signInEntry({ access: withKey, namesOrganization: false, commandLineOwed: false, hasProject: false, hasAgentLogin: notLoggedIn }),
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
