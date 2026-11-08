import { describe, expect, it } from "vitest";

import { acmeAndGlobex, type Recorded, runCli, startFakeMend } from "./organization.fixture.ts";

const operatorServer = (answer: { status: number; body: unknown }) =>
  startFakeMend((request) =>
    request.url === "/api/operator/organizations"
      ? {
          status: 200,
          body: [
            {
              organization: { id: "org-2", name: "Globex", createdAt: "" },
              memberCount: 1,
              ownerCount: 1,
            },
          ],
        }
      : answer,
  );

const organizations = (
  override: (request: Recorded) => { status: number; body: unknown } | null = () => null,
) => {
  let active: "org-1" | "org-2" = "org-1";
  return startFakeMend((request) => {
    const overridden = override(request);
    if (overridden !== null) return overridden;
    if (request.method === "GET" && request.url === "/api/account/organizations") {
      return { status: 200, body: acmeAndGlobex(active) };
    }
    if (request.method === "PUT" && request.url === "/api/account/organizations/active") {
      active = "org-2";
      return { status: 200, body: acmeAndGlobex(active)[1] };
    }
    if (request.method === "DELETE" && request.url === "/api/account/organizations/org-2") {
      active = "org-1";
      return { status: 204, body: null };
    }
    return { status: 404, body: { _tag: "NotFound", id: request.url } };
  });
};

// Each `runCli` starts the CLI from source in a fresh `node`, 1–3 s on a loaded CI runner, and a
// test runs it up to twice: the 5 s default is too short for that, as it is in `doctor.test.ts`.
describe("mend org and operator org add-member against a server", { timeout: 30_000 }, () => {
  it("org lists every organization and marks the one this sign-in acts in", async () => {
    const fake = await organizations();
    try {
      const listed = await runCli(fake.url, ["org"]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(listed.stdout.split("\n").slice(0, 3)).toEqual([
        "Acme · owner · 2 organizations",
        "▸ Acme    owner   joined 2026-09-01",
        "  Globex  member  joined 2026-11-08",
      ]);
    } finally {
      await fake.close();
    }
  });

  it("org switch moves this sign-in by name, any case, and says where it is now", async () => {
    const fake = await organizations();
    try {
      const switched = await runCli(fake.url, ["org", "switch", "GLOBEX"]);
      expect(switched.code, switched.stderr).toBe(0);
      expect(fake.recorded.at(-1)).toEqual({
        method: "PUT",
        url: "/api/account/organizations/active",
        body: { organizationId: "org-2" },
      });
      expect(switched.stdout).toContain("✓ switched to Globex · member");
      expect(switched.stdout).toContain(
        "this sign-in only · the web and other devices stay where they are",
      );
    } finally {
      await fake.close();
    }
  });

  it("org switch to an organization you are not in says so and switches nothing", async () => {
    const fake = await organizations();
    try {
      const refused = await runCli(fake.url, ["org", "switch", "Initech"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        'mend: you are not a member of an organization named "Initech" · mend org lists yours',
      );
      expect(fake.recorded.some((entry) => entry.method === "PUT")).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("org switch says so when the server no longer counts you a member", async () => {
    const fake = await organizations((request) =>
      request.method === "PUT" ? { status: 404, body: { _tag: "NotFound", id: "org-2" } } : null,
    );
    try {
      const refused = await runCli(fake.url, ["org", "switch", "org-2"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        "mend: you are no longer a member of Globex · mend org lists yours",
      );
    } finally {
      await fake.close();
    }
  });

  it("org says plainly when the server predates organization switching", async () => {
    const fake = await organizations((request) =>
      request.url === "/api/account/organizations"
        ? { status: 404, body: { _tag: "RouteNotFound" } }
        : null,
    );
    try {
      const older = await runCli(fake.url, ["org"]);
      expect(older.code).toBe(1);
      expect(older.stderr).toContain(
        "mend: this Mend server predates organization switching · mend members shows your organization",
      );
    } finally {
      await fake.close();
    }
  });

  it("org leave needs --yes without a terminal, then leaves and says where this sign-in acts", async () => {
    const fake = await organizations();
    try {
      const refused = await runCli(fake.url, ["org", "leave", "globex"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("mend: non-interactive · pass --yes to leave Globex");
      expect(fake.recorded.some((entry) => entry.method === "DELETE")).toBe(false);

      const left = await runCli(fake.url, ["org", "leave", "globex", "--yes"]);
      expect(left.code, left.stderr).toBe(0);
      expect(fake.recorded.some((entry) => entry.method === "DELETE")).toBe(true);
      expect(left.stdout).toContain("✓ left Globex · this sign-in now acts in Acme");
    } finally {
      await fake.close();
    }
  });

  it("org leave passes on the server's refusal in its own words", async () => {
    const lastOwner =
      "An organization needs an owner. Make someone else an owner before you leave.";
    const fake = await organizations((request) =>
      request.method === "DELETE"
        ? { status: 422, body: { _tag: "OrganizationRejected", message: lastOwner } }
        : null,
    );
    try {
      const refused = await runCli(fake.url, ["org", "leave", "org-2", "-y"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`mend: ${lastOwner}`);
    } finally {
      await fake.close();
    }
  });

  it("operator org add-member adds an existing account by email with the role asked for", async () => {
    const fake = await operatorServer({ status: 204, body: null });
    try {
      const add = (email: string, ...flags: ReadonlyArray<string>) =>
        runCli(fake.url, ["operator", "org", "add-member", "Globex", email, ...flags]);
      const owner = await add("sam@acme.dev", "--role", "owner");
      expect(owner.code, owner.stderr).toBe(0);
      expect(fake.recorded.at(-1)).toEqual({
        method: "POST",
        url: "/api/operator/organizations/org-2/members",
        body: { email: "sam@acme.dev", role: "owner" },
      });
      expect(owner.stdout).toContain("✓ sam@acme.dev is an owner of Globex");

      const member = await add("kim@acme.dev");
      expect(member.code, member.stderr).toBe(0);
      expect(fake.recorded.at(-1)?.body).toEqual({ email: "kim@acme.dev", role: "member" });
      expect(member.stdout).toContain("✓ kim@acme.dev is a member of Globex");

      const before = fake.recorded.length;
      const badRole = await add("sam@acme.dev", "--role", "admin");
      expect(badRole.code).toBe(1);
      expect(badRole.stderr).toContain('mend: --role takes "member" or "owner", not "admin"');
      expect(fake.recorded.slice(before).some((entry) => entry.method === "POST")).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("operator org add-member passes on the server's refusal in its own words", async () => {
    const unknown = "No active account in an organization has that email. Invite them instead.";
    const fake = await operatorServer({
      status: 422,
      body: { _tag: "OrganizationRejected", message: unknown },
    });
    try {
      const refused = await runCli(fake.url, [
        "operator",
        "org",
        "add-member",
        "Globex",
        "nobody@acme.dev",
      ]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`mend: ${unknown}`);
    } finally {
      await fake.close();
    }
  });
});
