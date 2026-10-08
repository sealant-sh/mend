import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiCall } from "./pair.ts";
import { MendRequestError } from "./server-request.ts";
import { workspaceCommand } from "./workspace-replace.ts";

const retirement = {
  state: "marked",
  preRelease: true,
  launcher: "anna",
  stops: [{ kind: "terminal", label: "fix-auth · claude" }],
  reason: null,
  canReplace: true,
};

/** A fake server: answers by route, records every call, refuses the replacement when told. */
const fakeServer = (refusal: string | null = null) => {
  const calls: Array<string> = [];
  const answer = (method: string, route: string): unknown => {
    calls.push(`${method} ${route}`);
    if (route === "/sessions?retained=1") {
      return [
        { id: "3f2a0001", harness: "claude", livePeople: [{ accountId: "anna", name: "Anna" }] },
        { id: "9b000002", harness: "codex" },
      ];
    }
    if (route.endsWith("/workspace-retirement")) return retirement;
    if (route === "/organization/members") return [];
    if (route.endsWith("/replace") && refusal !== null) {
      throw new MendRequestError("http", refusal, 409);
    }
    return null;
  };
  // Through JSON, as the wire carries it: the fake answers any T the caller reads.
  const tryApi: ApiCall = async (method, route) =>
    JSON.parse(JSON.stringify(answer(method, route)) ?? "null");
  // The CLI's `api`: a failure prints and exits.
  const api: ApiCall = async (method, route, body) => {
    try {
      return await tryApi(method, route, body);
    } catch (error) {
      process.stderr.write(`mend: ${error instanceof Error ? error.message : String(error)}\n`);
      return process.exit(1);
    }
  };
  return { calls, api, tryApi };
};

const captured = () => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  return { out, err };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mend workspace replace", () => {
  it("says what would stop, asks, and replaces once answered yes", async () => {
    const { out } = captured();
    const server = fakeServer();
    const asked: Array<string> = [];
    await workspaceCommand(server.api, server.tryApi, ["replace", "3f2a"], {
      interactive: true,
      ask: async (question) => {
        asked.push(question);
        return true;
      },
    });
    expect(asked).toEqual(["replace it?"]);
    expect(server.calls.at(-1)).toBe("POST /sessions/3f2a0001/workspace-retirement/replace");
    const text = out.join("");
    expect(text).toContain(
      "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced",
    );
    expect(text).toContain("Replace this workspace now?");
    expect(text).toContain("  terminal session (ends resumable) · fix-auth · claude");
    expect(text).toContain("Replacing this workspace so that each person runs as themselves");
  });

  it("replaces nothing when the answer is no", async () => {
    const { out } = captured();
    const server = fakeServer();
    await workspaceCommand(server.api, server.tryApi, ["replace", "3f2a"], {
      interactive: true,
      ask: async () => false,
    });
    expect(server.calls.some((call) => call.startsWith("POST"))).toBe(false);
    expect(out.join("")).toContain("nothing replaced");
  });

  it("refuses a script without --yes, and replaces with it", async () => {
    const { err } = captured();
    const refused = fakeServer();
    const io = { interactive: false, ask: async () => true };
    await expect(
      workspaceCommand(refused.api, refused.tryApi, ["replace", "3f2a"], io),
    ).rejects.toThrow("exit 1");
    expect(err.join("")).toContain("pass --yes");
    expect(refused.calls.some((call) => call.startsWith("POST"))).toBe(false);

    const confirmed = fakeServer();
    await workspaceCommand(confirmed.api, confirmed.tryApi, ["replace", "3f2a", "--yes"], io);
    expect(confirmed.calls.at(-1)).toBe("POST /sessions/3f2a0001/workspace-retirement/replace");
  });

  it("prints the server's refusal as it is", async () => {
    const { err } = captured();
    const server = fakeServer("An agent turn is in flight in this workspace; it is never stopped.");
    await expect(
      workspaceCommand(server.api, server.tryApi, ["replace", "3f2a", "--yes"], {
        interactive: false,
        ask: async () => true,
      }),
    ).rejects.toThrow("exit 1");
    expect(err.join("")).toBe(
      "mend: An agent turn is in flight in this workspace; it is never stopped.\n",
    );
  });

  it("takes the usage it documents", async () => {
    const { err } = captured();
    const server = fakeServer();
    await expect(workspaceCommand(server.api, server.tryApi, ["replace"])).rejects.toThrow(
      "exit 1",
    );
    expect(err.join("")).toContain("usage: mend workspace replace <session> [--yes]");
  });
});
