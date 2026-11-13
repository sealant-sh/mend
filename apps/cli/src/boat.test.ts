import {
  boatKeyProofFixture,
  boatKeyReportFixture,
  organizationKeyReportFixture,
} from "@mend/domain/boat-key-fixtures";
import { describe, expect, it } from "vitest";

import { boatCommand } from "./boat.ts";
import { flagRefusal } from "./flag-gate.ts";
import { renderGroup } from "./help.ts";
import type { ApiCall } from "./pair.ts";
import { MendRequestError } from "./server-request.ts";

const KEY = "boat_live_SYNTHETIC0123456789abcdef";

interface Sent {
  readonly method: string;
  readonly route: string;
  readonly body: unknown;
}

const none = { connected: false, sessionRuntime: "boat", details: null };
const memberView = { connected: true, sessionRuntime: "boat", details: null };
const ownerView = {
  connected: true,
  sessionRuntime: "boat",
  details: {
    sealantBoatAccountId: "core-boat-1",
    connectedByUserId: "alice",
    connectedByName: "Alice",
    connectedAt: "2026-11-13T12:00:00.000Z",
    keyReplacedAt: null,
    report: null,
    fullCheck: { last: null, runningSince: null },
  },
};

/** The command against a fake server: `answer` gets each call, and throws to refuse it. */
const run = async (
  args: ReadonlyArray<string>,
  answer: (sent: Sent) => unknown = () => null,
  input: {
    readonly terminal?: boolean;
    readonly typed?: string | null;
    readonly piped?: string;
  } = {},
) => {
  const sent: Array<Sent> = [];
  const asked: Array<string> = [];
  let stdout = "";
  let stderr = "";
  const api: ApiCall = async (method, route, body) => {
    const call = { method, route, body };
    sent.push(call);
    const reply: unknown = answer(call);
    return JSON.parse(JSON.stringify(reply ?? null));
  };
  const code = await boatCommand(args, {
    connect: () => ({ api }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    terminal: input.terminal ?? false,
    askHidden: async (label) => {
      asked.push(label);
      return input.typed === undefined ? KEY : input.typed;
    },
    readStdin: async () => input.piped ?? "",
    sleep: async () => undefined,
  });
  return { code, sent, asked, stdout, stderr };
};

const refused = (status: number, tag: string, message: string) => () => {
  throw new MendRequestError("http", message, status, { call: "", tag });
};

describe("mend boat status", () => {
  it("tells an owner who connected the key and when, and what it does", async () => {
    // An older server without the person's route: the organization's lines alone.
    const { code, stdout, sent } = await run([], (call) => {
      if (call.route === "/me/boat-key") throw new Error("404");
      return ownerView;
    });
    expect(code).toBe(0);
    expect(sent.map((call) => call.route)).toEqual(["/organization/boat-key", "/me/boat-key"]);
    expect(stdout.split("\n")).toEqual([
      "This organization has its own Boat key · connected by Alice 2026-11-13 12:00 UTC",
      "New Boat sessions run in, and are billed to, its Boat account (Sealant account core-boat-1). Running sessions stay where they started.",
      "Not observed yet: who the key is, the wallet it bills, whether it can start a VM, its saved snapshot slots, its permissions and when it expires. Sealant has not checked this key with Boat since it was connected. mend boat check asks Boat.",
      "",
    ]);
  });

  it("prints what Boat said about the key the last time Sealant checked, fact by fact", async () => {
    const report = boatKeyReportFixture({}, new Date("2026-11-13T14:02:00.000Z"));
    const { stdout } = await run([], () => ({
      ...ownerView,
      details: { ...ownerView.details, report },
    }));
    const lines = stdout.split("\n");
    expect(lines.slice(2, 9)).toEqual([
      "What Boat said about the key · observed 2026-11-13 14:02 UTC",
      "  Key of           Acme CI @acme-ci service account · a personal key",
      "  Bills            the Boat organization acme-boat · the key's role there: admin",
      "  Starts a VM      yes · 2 of 5 VMs running",
      "  Saved snapshots  7 of 10 included slots used",
      "  Permissions      11 permissions · none Mend needs missing",
      expect.stringMatching(/^ {2}Expires {10}.* · in \d+ days$/),
    ]);
    expect(stdout).not.toContain("! ");
  });

  it("says an organization key's permissions and expiry cannot be read from it, and where to see them", async () => {
    const { stdout } = await run([], () => ({
      ...ownerView,
      details: { ...ownerView.details, report: organizationKeyReportFixture() },
    }));
    expect(stdout).toContain(
      "  Permissions      not observed · not readable from a Boat organization's key",
    );
    expect(stdout).toContain("run boat --org acme-boat api-key list");
  });

  it("tells a member only that there is a key", async () => {
    const { stdout } = await run(["status"], () => memberView);
    expect(stdout).toContain(
      "This organization has its own Boat key · new Boat sessions run in its Boat account.",
    );
    expect(stdout).toContain("Only an owner can read its details or change it.");
  });

  it("says the server's key is used without one, and when the organization's sessions do not run on Boat", async () => {
    const { stdout } = await run([], () => ({ ...none, sessionRuntime: "docker" }));
    expect(stdout.split("\n")).toEqual([
      "This organization has no Boat key · new Boat sessions use the server's own, if it has one; otherwise they are refused.",
      "An owner connects one with mend boat connect.",
      "This organization's new sessions run on this server's Docker, so no session uses a Boat key until they run on Boat.",
      "",
    ]);
  });

  it("prints the versioned status as JSON", async () => {
    const { stdout } = await run(["--json"], () => ownerView);
    expect(JSON.parse(stdout)).toEqual({
      version: 1,
      status: { ...ownerView, peopleWithOwnKeys: null },
    });
  });
});

const ownNone = {
  organizationName: "Acme",
  connected: false,
  sessionRuntime: "boat",
  organizationKey: true,
  details: null,
};
const ownConnected = {
  ...ownNone,
  connected: true,
  details: {
    sealantBoatAccountId: "core-boat-own",
    connectedByUserId: "carol",
    connectedByName: "Carol",
    connectedAt: "2026-11-13T12:00:00.000Z",
    keyReplacedAt: null,
    report: null,
    fullCheck: { last: null, runningSince: null },
  },
};

describe("mend boat with --mine (SLNT-797)", () => {
  it("says, after the organization's key, what decides the caller's own sessions", async () => {
    const { stdout } = await run([], (call) =>
      call.route === "/me/boat-key" ? ownNone : { ...memberView, peopleWithOwnKeys: null },
    );
    expect(stdout).toContain(
      "You have no Boat key of your own in Acme · your Boat sessions use the organization's key.",
    );
    expect(stdout).toContain("Connect one with mend boat connect --mine.");
  });

  it("names the members with their own key to an owner, and nothing more", async () => {
    const { stdout } = await run([], (call) =>
      call.route === "/me/boat-key"
        ? ownNone
        : { ...ownerView, peopleWithOwnKeys: [{ userId: "carol", name: "Carol" }] },
    );
    expect(stdout).toContain(
      "With their own Boat key: Carol · their Boat sessions here run in their own Boat accounts.",
    );
  });

  it("connects the caller's own key on their own route, and says it is theirs", async () => {
    let stored: unknown = ownNone;
    const { code, sent, stdout } = await run(
      ["connect", "--mine"],
      (call) => {
        if (call.method === "PUT") stored = ownConnected;
        return stored;
      },
      { piped: `${KEY}\n` },
    );
    expect(code).toBe(0);
    expect(sent).toEqual([
      { method: "GET", route: "/me/boat-key", body: undefined },
      { method: "PUT", route: "/me/boat-key", body: { key: KEY } },
    ]);
    expect(stdout.split("\n")).toEqual([
      "✓ connected your own Boat key",
      "Your own Boat key in Acme · connected 2026-11-13 12:00 UTC",
      "The Boat sessions you start there run in, and are billed to, your Boat account (Sealant account core-boat-own). Mend keeps no standby workspace on it.",
      "Not observed yet: who the key is, the wallet it bills, whether it can start a VM, its saved snapshot slots, its permissions and when it expires. Sealant has not checked this key with Boat since it was connected. mend boat check --mine asks Boat.",
      "",
    ]);
    expect(stdout).not.toContain(KEY);
  });

  it("checks and removes only the caller's own key", async () => {
    const checked = await run(["check", "--mine"], () => ({
      state: "active",
      observedAt: "2026-11-13T14:02:00.000Z",
      keyReplacedAt: null,
      report: null,
    }));
    expect(checked.sent.map((call) => [call.method, call.route])).toEqual([
      ["POST", "/me/boat-key/check"],
    ]);
    expect(checked.stdout).toContain(
      "Sealant holds your Boat key · active · observed 2026-11-13 14:02 UTC",
    );
    const removed = await run(["disconnect", "--mine"], (call) =>
      call.method === "DELETE" ? { ...ownNone, removal: { standbysDrained: 0 } } : ownConnected,
    );
    expect(removed.sent.map((call) => [call.method, call.route])).toEqual([
      ["GET", "/me/boat-key"],
      ["DELETE", "/me/boat-key"],
    ]);
    expect(removed.stdout).toContain(
      "✓ removed your own Boat key · Sealant deletes the images it built in that Boat account",
    );
    expect(removed.stdout).toContain("your Boat sessions use the organization's key.");
  });

  it("asks nothing to be removed when the caller has no key of their own", async () => {
    const { sent, stdout } = await run(["disconnect", "--mine"], () => ownNone);
    expect(sent.map((call) => call.method)).toEqual(["GET"]);
    expect(stdout).toContain("You have no Boat key of your own here · nothing to remove");
  });

  it("prints the caller's own status as JSON", async () => {
    const { stdout } = await run(["status", "--mine", "--json"], () => ownConnected);
    expect(JSON.parse(stdout)).toEqual({ version: 1, status: ownConnected });
  });

  it("prints what Boat said about the caller's own key, with how to replace it", async () => {
    const report = JSON.parse(
      JSON.stringify(
        boatKeyReportFixture({
          expiry: {
            observed: true,
            expiresAt: new Date(Date.now() + 5 * 86_400_000),
            expired: false,
            expiringSoon: true,
          },
        }),
      ),
    );
    const status = { ...ownConnected, details: { ...ownConnected.details, report } };
    const { stdout } = await run(["status", "--mine"], () => status);
    expect(stdout).toContain("What Boat said about the key · observed");
    expect(stdout).toContain("Key of");
    expect(stdout).toMatch(
      /! This Boat key expires on .*, in 5 days\..* then run mend boat connect --mine to replace this one\./,
    );
    const checked = await run(["check", "--mine"], () => ({
      state: "active",
      observedAt: "2026-11-13T12:00:00.000Z",
      keyReplacedAt: null,
      report,
      unanswered: null,
    }));
    expect(checked.sent.map((call) => [call.method, call.route])).toEqual([
      ["POST", "/me/boat-key/check"],
    ]);
    expect(checked.stdout).toContain("Sealant holds your Boat key · active");
    expect(checked.stdout).toContain("Bills");
  });

  it("includes the caller's own key in the organization's status as JSON", async () => {
    const { stdout } = await run(["status", "--json"], (call) =>
      call.route === "/me/boat-key" ? ownConnected : ownerView,
    );
    expect(JSON.parse(stdout)).toEqual({
      version: 1,
      status: { ...ownerView, peopleWithOwnKeys: null },
      own: ownConnected,
    });
  });

  it("leaves the caller's own key out of the JSON on a server without it", async () => {
    const { stdout } = await run(["status", "--json"], (call) => {
      if (call.route === "/me/boat-key") throw new Error("404");
      return ownerView;
    });
    expect(JSON.parse(stdout)).toEqual({
      version: 1,
      status: { ...ownerView, peopleWithOwnKeys: null },
    });
  });
});

describe("mend boat connect", () => {
  it("reads the key from standard input, trims it, and sends it once", async () => {
    const { code, sent, stdout, stderr } = await run(
      ["connect"],
      ({ method }) => (method === "GET" ? none : ownerView),
      { piped: `${KEY}\n` },
    );
    expect(code).toBe(0);
    expect(sent).toEqual([
      { method: "GET", route: "/organization/boat-key", body: undefined },
      { method: "PUT", route: "/organization/boat-key", body: { key: KEY } },
    ]);
    expect(stdout.split("\n")[0]).toBe("✓ connected the organization's Boat key");
    expect(`${stdout}${stderr}`).not.toContain(KEY);
  });

  it("asks with a hidden prompt at a terminal, and says it replaced a key that was there", async () => {
    const { asked, stdout } = await run(["connect"], () => ownerView, { terminal: true });
    expect(asked).toEqual(["Boat key (hidden): "]);
    expect(stdout.split("\n")[0]).toBe("✓ replaced the organization's Boat key");
  });

  it("never takes the key as an argument, and sends nothing", async () => {
    const { code, sent, stderr } = await run(["connect", KEY]);
    expect(code).toBe(1);
    expect(sent).toEqual([]);
    expect(stderr).toContain("never from the command line");
    expect(stderr).not.toContain(KEY);
  });

  it("sends nothing when the prompt was cancelled, empty, or not a Boat key", async () => {
    for (const input of [
      { terminal: true, typed: null },
      { terminal: true, typed: "  " },
      { piped: "" },
      { piped: "not a key\n" },
    ]) {
      const { code, sent } = await run(["connect"], () => none, input);
      expect(code).toBe(1);
      expect(sent).toEqual([]);
    }
  });

  it("prints the server's words when it refuses, as text or JSON", async () => {
    const words =
      "This key cannot see 3 VMs or saved images the organization's Boat account holds now, so it is most likely another Boat account's key.";
    const answer = ({ method }: Sent) =>
      method === "GET" ? ownerView : refused(409, "BoatKeyConflict", words)();
    const text = await run(["connect"], answer, { piped: KEY });
    expect(text.code).toBe(1);
    expect(text.stderr).toBe(`mend: ${words}\n`);
    const json = await run(["connect", "--json"], answer, { piped: KEY });
    expect(JSON.parse(json.stdout)).toEqual({
      version: 1,
      error: { tag: "BoatKeyConflict", message: words },
    });
  });
});

describe("mend boat check", () => {
  it("says what needs doing about an expired key, with the command that makes a new one", async () => {
    const now = new Date();
    const { stdout } = await run(["check"], () => ({
      state: "active",
      observedAt: now.toISOString(),
      keyReplacedAt: null,
      report: boatKeyReportFixture(
        {
          expiry: {
            observed: true,
            expiresAt: new Date(now.getTime() - 86_400_000),
            expired: true,
            expiringSoon: false,
          },
        },
        now,
      ),
      unanswered: null,
    }));
    expect(stdout).toMatch(
      /! This Boat key expired on .*, so new Boat sessions cannot start with it\. Create a new key with boat --org <your-boat-organization> api-key create mend --ttl 365d --actions .* then run mend boat connect to replace this one\./,
    );
  });

  it("says when Boat did not answer, and prints the last report", async () => {
    const { stdout } = await run(["check"], () => ({
      state: "active",
      observedAt: "2026-11-13T15:00:00.000Z",
      keyReplacedAt: null,
      report: boatKeyReportFixture({}, new Date("2026-11-13T14:02:00.000Z")),
      unanswered:
        "Boat did not answer this check, so Mend observed nothing new: the report shown is the last one. Try again in a minute.",
    }));
    expect(stdout.split("\n").slice(1, 3)).toEqual([
      "Boat did not answer this check, so Mend observed nothing new: the report shown is the last one. Try again in a minute.",
      "What Boat said about the key · observed 2026-11-13 14:02 UTC",
    ]);
  });

  it("says what Sealant holds and when it was observed", async () => {
    const { sent, stdout } = await run(["check"], () => ({
      state: "active",
      observedAt: "2026-11-13T14:02:31.000Z",
      keyReplacedAt: null,
      report: null,
    }));
    expect(sent).toEqual([
      { method: "POST", route: "/organization/boat-key/check", body: undefined },
    ]);
    expect(stdout.split("\n")[0]).toBe(
      "Sealant holds the organization's Boat key · active · observed 2026-11-13 14:02 UTC",
    );
    expect(stdout).toContain("Not observed yet: who the key is");
  });

  it("says when Sealant no longer lists the account, and what to do", async () => {
    const { stdout } = await run(["check"], () => ({
      state: "missing",
      observedAt: "2026-11-13T14:02:31.000Z",
      keyReplacedAt: null,
      report: null,
    }));
    expect(stdout).toContain("Sealant no longer lists the organization's Boat account");
    expect(stdout).toContain("mend boat disconnect");
  });
});

describe("mend boat check --full", () => {
  const FINISHED = new Date("2026-11-13T14:01:04.000Z");
  const withFullCheck = (fullCheck: unknown) => ({
    ...ownerView,
    details: { ...ownerView.details, fullCheck },
  });

  it("runs a full check of the caller's own key on their own route, with --mine", async () => {
    const { code, stdout, sent } = await run(["check", "--full", "--mine"], () => ({
      last: null,
      runningSince: null,
    }));
    expect(code).toBe(0);
    expect(sent).toEqual([{ method: "POST", route: "/me/boat-key/full-check", body: undefined }]);
    expect(stdout).toContain(
      "No full check has run on this key. mend boat check --full --mine runs one.",
    );
  });

  it("says what it costs, runs it, and prints each step with what it left", async () => {
    const { code, stdout, sent } = await run(["check", "--full"], () => ({
      last: boatKeyProofFixture("passed", FINISHED),
      runningSince: null,
    }));
    expect(code).toBe(0);
    expect(sent).toEqual([
      { method: "POST", route: "/organization/boat-key/full-check", body: undefined },
    ]);
    expect(stdout.split("\n")).toEqual([
      "A full check starts the smallest VM in this key's Boat account, runs a command in it, publishes a port and saves a snapshot, then deletes the snapshot and the VM. It uses one VM start, takes about a minute, and holds one saved snapshot slot for that minute.",
      "Full check · passed · finished 2026-11-13 14:01 UTC",
      "  Start a VM           passed",
      "  Run a command        passed",
      "  Publish a port       passed",
      "  Save a snapshot      passed",
      "  Delete the snapshot  passed",
      "  Delete the VM        passed",
      "It used one VM start. Sealant saw Boat delete everything the check made.",
      "",
    ]);
  });

  it("names the step Boat refused and why, and the steps it did not reach", async () => {
    const { stdout } = await run(["check", "--full"], () => ({
      last: boatKeyProofFixture("refused", FINISHED),
      runningSince: null,
    }));
    expect(stdout).toContain(
      "Full check · refused at publish a port · finished 2026-11-13 14:01 UTC",
    );
    expect(stdout).toContain(
      "  Publish a port       refused\n    ! This Boat key lacks the Boat permission host, so the full check stopped there.",
    );
    expect(stdout).toContain("  Save a snapshot      not reached");
  });

  it("says an interrupted check was swept, and what is not yet confirmed removed", async () => {
    const { stdout } = await run(["check", "--full"], () => ({
      last: boatKeyProofFixture("interrupted", FINISHED, {
        vm: "bx_abc123",
        snapshot: "sealant-key-proof-1",
        removalConfirmed: false,
      }),
      runningSince: null,
    }));
    expect(stdout).toContain("Full check · interrupted");
    expect(stdout).toContain("  Run a command        no answer");
    expect(stdout).toContain(
      "! It used one VM start. Sealant has not yet seen Boat delete VM bx_abc123 and snapshot sealant-key-proof-1. It keeps deleting what is left, and the key cannot be replaced or removed until it has.",
    );
  });

  it("reads the status while one runs, then prints the result Sealant kept", async () => {
    let reads = 0;
    const { code, stdout, sent } = await run(["check", "--full"], (call) => {
      if (call.method === "POST") return { last: null, runningSince: "2026-11-13T14:00:00.000Z" };
      reads += 1;
      return withFullCheck(
        reads < 2
          ? { last: null, runningSince: "2026-11-13T14:00:00.000Z" }
          : { last: boatKeyProofFixture("passed", FINISHED), runningSince: null },
      );
    });
    expect(code).toBe(0);
    expect(sent.map((call) => call.method)).toEqual(["POST", "GET", "GET"]);
    expect(stdout).toContain(
      "A full check is running · started 2026-11-13 14:00 UTC · it takes about a minute.",
    );
    expect(stdout).toContain("Full check · passed");
  });

  it("prints the server's words when a check is running already", async () => {
    const { code, stderr } = await run(
      ["check", "--full"],
      refused(
        409,
        "BoatKeyConflict",
        "A full check of this key is running, or Sealant is still removing what the last one made in Boat, so no other was started.",
      ),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("A full check of this key is running");
  });

  it("prints the versioned full check as JSON, and refuses --full elsewhere", async () => {
    const json = await run(["check", "--full", "--json"], () => ({
      last: boatKeyProofFixture("passed", FINISHED),
      runningSince: null,
    }));
    expect(JSON.parse(json.stdout)).toMatchObject({
      version: 1,
      fullCheck: { last: { outcome: "passed" }, runningSince: null },
    });
    expect((await run(["status", "--full"])).code).toBe(1);
  });

  it("shows the last full check on status", async () => {
    const { stdout } = await run([], () =>
      withFullCheck({ last: boatKeyProofFixture("passed", FINISHED), runningSince: null }),
    );
    expect(stdout).toContain("Full check · passed · finished 2026-11-13 14:01 UTC");
  });
});

describe("mend boat disconnect", () => {
  it("removes the key and says new sessions use the server's", async () => {
    const { code, sent, stdout } = await run(["disconnect"], ({ method }) =>
      method === "GET" ? ownerView : { ...none, removal: { standbysDrained: 0 } },
    );
    expect(code).toBe(0);
    expect(sent.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(stdout.split("\n").slice(0, 2)).toEqual([
      "✓ removed the organization's Boat key · Sealant deletes the images it built in that Boat account",
      "This organization has no Boat key · new Boat sessions use the server's own, if it has one; otherwise they are refused.",
    ]);
  });

  it("says how many standbys Mend stopped in the account first (SLNT-803)", async () => {
    const { stdout } = await run(["disconnect"], ({ method }) =>
      method === "GET" ? ownerView : { ...none, removal: { standbysDrained: 2 } },
    );
    expect(stdout.split("\n").slice(0, 3)).toEqual([
      "✓ removed the organization's Boat key · Sealant deletes the images it built in that Boat account",
      "Mend stopped 2 standby workspaces there first. Projects with hot sessions warm new ones where sessions run now.",
      "This organization has no Boat key · new Boat sessions use the server's own, if it has one; otherwise they are refused.",
    ]);
  });

  it("does not claim a removal another request made at the same moment", async () => {
    const { code, stdout } = await run(["disconnect"], ({ method }) =>
      method === "GET" ? ownerView : none,
    );
    expect(code).toBe(0);
    expect(stdout.split("\n")[0]).toBe(
      "The organization's Boat key was already removed, by another request · nothing more to do",
    );
  });

  it("asks nothing to be removed when there is no key", async () => {
    const { sent, stdout } = await run(["disconnect"], () => none);
    expect(sent.map((call) => call.method)).toEqual(["GET"]);
    expect(stdout.split("\n")[0]).toBe("This organization has no Boat key · nothing to remove");
  });

  it("prints Sealant's count when VMs would be stranded", async () => {
    const words =
      "The organization's Boat account still has 2 session workspaces whose VMs Boat may be running, so nothing changed and the key stays.";
    const { code, stderr } = await run(["disconnect"], ({ method }) =>
      method === "GET" ? ownerView : refused(409, "BoatKeyConflict", words)(),
    );
    expect(code).toBe(1);
    expect(stderr).toBe(`mend: ${words}\n`);
  });
});

describe("mend help boat", () => {
  it("lists the four subcommands and lets --json through the gate", () => {
    const page = renderGroup("boat", 80) ?? "";
    for (const name of ["boat status", "boat connect", "boat check", "boat disconnect"])
      expect(page).toContain(name);
    expect(flagRefusal(["boat", "--json"])).toBeNull();
    expect(flagRefusal(["boat", "connect", "--json"])).toBeNull();
    expect(flagRefusal(["boat", "connect", "--key"])).toMatch(/^unknown flag --key/);
  });
});
