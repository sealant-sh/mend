import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachableProcesses,
  isEndFrame,
  mintTtyTicket,
  resizeFrame,
  ttyUrl,
} from "./tty-protocol.js";
import type { SessionProcess } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const process = (overrides: Partial<SessionProcess>): SessionProcess => ({
  id: "p",
  kind: "shell",
  harness: null,
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  ...overrides,
});

describe("the terminal's address", () => {
  it("is ws: over http and wss: behind an https edge, with the ticket and no token", () => {
    expect(ttyUrl("http://192.168.1.20:3105", { process: "shell-1" }, "tkt").toString()).toBe(
      "ws://192.168.1.20:3105/api/tty?process=shell-1&from=0&ticket=tkt",
    );
    expect(ttyUrl("https://mend.example.com/", { session: "s-1" }, "tkt").toString()).toBe(
      "wss://mend.example.com/api/tty?session=s-1&from=0&ticket=tkt",
    );
  });

  it("offers live shells and terminal agents, newest first, and nothing a PTY cannot show", () => {
    expect(
      attachableProcesses([
        process({ id: "old-shell" }),
        process({ id: "ended-shell", exitedAt: "2026-10-10T00:00:00Z", status: "exited" }),
        process({ id: "protocol", kind: "agent-protocol" }),
        process({ id: "observed", kind: "agent-external" }),
        process({ id: "service", kind: "service", status: "reachable" }),
        process({ id: "agent", kind: "agent-pty", harness: "claude" }),
      ]).map((candidate) => candidate.id),
    ).toEqual(["agent", "old-shell"]);
  });

  it("reads the end frame and writes the resize frame the route expects", () => {
    expect(isEndFrame('{"t":"end"}')).toBe(true);
    expect(isEndFrame('{"t":"other"}')).toBe(false);
    expect(isEndFrame("not json")).toBe(false);
    expect(JSON.parse(resizeFrame(120, 40))).toEqual({ t: "resize", cols: 120, rows: 40 });
  });
});

describe("mintTtyTicket", () => {
  it("mints over the API with the token in a header, for exactly this terminal", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ticket: "tkt", expiresInSeconds: 30 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mintTtyTicket({ url: "http://192.168.1.20:3105", token: "mdt_x" }, { process: "shell-1" }),
    ).resolves.toBe("tkt");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://192.168.1.20:3105/api/upgrade-tickets");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mdt_x");
    expect(JSON.parse(String(init?.body))).toEqual({ target: "tty", process: "shell-1" });
  });

  it("fails on a server that does not mint, rather than putting the token in the URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 })),
    );
    await expect(
      mintTtyTicket({ url: "http://192.168.1.20:3105", token: "mdt_x" }, { session: "s-1" }),
    ).rejects.toThrow(
      "This Mend server does not issue terminal tickets. Upgrade it to open terminals here.",
    );
  });
});
