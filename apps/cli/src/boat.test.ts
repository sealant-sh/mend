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
  });
  return { code, sent, asked, stdout, stderr };
};

const refused = (status: number, tag: string, message: string) => () => {
  throw new MendRequestError("http", message, status, { call: "", tag });
};

describe("mend boat status", () => {
  it("tells an owner who connected the key and when, and what it does", async () => {
    const { code, stdout, sent } = await run([], () => ownerView);
    expect(code).toBe(0);
    expect(sent).toEqual([{ method: "GET", route: "/organization/boat-key", body: undefined }]);
    expect(stdout.split("\n")).toEqual([
      "This organization has its own Boat key · connected by Alice 2026-11-13 12:00 UTC",
      "New Boat sessions run in, and are billed to, its Boat account (Sealant account core-boat-1). Running sessions stay where they started.",
      "",
    ]);
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
      "This organization has no Boat key · new Boat sessions use the server's.",
      "An owner connects one with mend boat connect.",
      "This organization's new sessions run on this server's Docker, so no session uses a Boat key until they run on Boat.",
      "",
    ]);
  });

  it("prints the versioned status as JSON", async () => {
    const { stdout } = await run(["--json"], () => ownerView);
    expect(JSON.parse(stdout)).toEqual({ version: 1, status: ownerView });
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
    expect(stdout).toContain("needs a newer Sealant on this server");
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

describe("mend boat disconnect", () => {
  it("removes the key and says new sessions use the server's", async () => {
    const { code, sent, stdout } = await run(["disconnect"], ({ method }) =>
      method === "GET" ? ownerView : none,
    );
    expect(code).toBe(0);
    expect(sent.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(stdout.split("\n").slice(0, 2)).toEqual([
      "✓ removed the organization's Boat key · Sealant deletes the images it built in that Boat account",
      "This organization has no Boat key · new Boat sessions use the server's.",
    ]);
  });

  it("asks nothing to be removed when there is no key", async () => {
    const { sent, stdout } = await run(["disconnect"], () => none);
    expect(sent.map((call) => call.method)).toEqual(["GET"]);
    expect(stdout.split("\n")[0]).toBe("This organization has no Boat key · nothing to remove");
  });

  it("prints Sealant's count when VMs would be stranded", async () => {
    const words =
      "The organization's Boat account still has 2 workspaces whose VMs Boat may be running, standby workspaces included.";
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
