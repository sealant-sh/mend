import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  attachTunnelTargets,
  createServiceTunnels,
  listenLocal,
  type OpenTunnel,
  type ServerEvents,
  type ServiceTunnels,
  type TunnelService,
  touchesSessionServices,
  tunnelLine,
} from "./service-tunnels.ts";

const service = (overrides: Partial<TunnelService> & { readonly id: string }): TunnelService => ({
  sessionId: "session-a",
  label: overrides.id,
  protocol: "tcp",
  browserScheme: "http",
  workspacePort: 0,
  ...overrides,
});

/** A port nothing on this machine listens on right now. */
const freePort = async (): Promise<number> => {
  const server = net.createServer();
  const port = await listenLocal(server, 0, false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** Server events a test fires by hand. */
const manualEvents = () => {
  let handlers: Parameters<ServerEvents>[0] | null = null;
  const events: ServerEvents = (next, signal) =>
    new Promise<void>((resolve) => {
      handlers = next;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  return {
    events,
    fire: (payload: unknown) => handlers?.onPayload(JSON.stringify(payload)),
  };
};

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const open: ServiceTunnels[] = [];
afterEach(() => {
  for (const tunnels of open.splice(0)) tunnels.close();
});

describe("what an attach tunnels", () => {
  it("takes the session's TCP Services that declare a browser scheme, nothing else", () => {
    const services = [
      service({ id: "web" }),
      service({ id: "api", browserScheme: "https" }),
      service({ id: "db", browserScheme: null }),
      service({ id: "stats", protocol: "udp", browserScheme: null }),
      service({ id: "other", sessionId: "session-b" }),
    ];
    expect(attachTunnelTargets(services, "session-a").map((s) => s.id)).toEqual(["web", "api"]);
  });

  it("says where each one opens", () => {
    expect(tunnelLine(service({ id: "web" }), 5173)).toBe("web → http://localhost:5173");
    expect(tunnelLine(service({ id: "api", browserScheme: "https" }), 8443)).toBe(
      "api → https://localhost:8443",
    );
  });

  it("re-reads on the session's own process and session events only", () => {
    expect(touchesSessionServices('{"type":"session-process","sessionId":"s1"}', "s1")).toBe(true);
    expect(touchesSessionServices('{"type":"session","sessionId":"s1"}', "s1")).toBe(true);
    expect(touchesSessionServices('{"type":"session-process","sessionId":"s2"}', "s1")).toBe(false);
    expect(touchesSessionServices('{"type":"session-progress","sessionId":"s1"}', "s1")).toBe(
      false,
    );
    expect(touchesSessionServices("not json", "s1")).toBe(false);
  });
});

describe("listenLocal", () => {
  it("binds the asked port when free, and a free one when it is taken", async () => {
    const wanted = await freePort();
    const first = net.createServer();
    expect(await listenLocal(first, wanted, true)).toBe(wanted);
    const second = net.createServer();
    const fallback = await listenLocal(second, wanted, true);
    expect(fallback).not.toBe(wanted);
    expect(fallback).toBeGreaterThan(0);
    // Without the fallback a taken port is the caller's error to state.
    const third = net.createServer();
    await expect(listenLocal(third, wanted, false)).rejects.toMatchObject({ code: "EADDRINUSE" });
    first.close();
    second.close();
  });
});

describe("createServiceTunnels", () => {
  it("opens a tunnel per browser Service on its own port, follows the Services, and never touches them", async () => {
    const webPort = await freePort();
    let live: ReadonlyArray<TunnelService> = [
      service({ id: "web", workspacePort: webPort }),
      service({ id: "db", browserScheme: null, workspacePort: 5432 }),
    ];
    let lists = 0;
    const tunnelRequests: string[] = [];
    const opened: OpenTunnel[] = [];
    const closed: Array<readonly [string, string]> = [];
    const { events, fire } = manualEvents();
    const tunnels = createServiceTunnels({
      listServices: async () => {
        lists += 1;
        return live;
      },
      tunnelUrl: async (serviceId) => {
        tunnelRequests.push(serviceId);
        throw new Error("no ticket in this test");
      },
      events,
      onOpen: (tunnel) => opened.push(tunnel),
      onClose: (tunnel, reason) => closed.push([tunnel.service.id, reason]),
      settleMs: 5,
      pollMs: 60_000,
    });
    open.push(tunnels);

    await tunnels.focus("session-a");
    expect(opened.map((tunnel) => tunnel.line)).toEqual([`web → http://localhost:${webPort}`]);
    expect(tunnels.current()).toHaveLength(1);
    expect(await accepts(webPort)).toBe(true);
    // A connection asks for its own ticket; a refused one ends the local connection.
    await until(() => tunnelRequests.length === 1, "the connection's ticket");
    expect(tunnelRequests).toEqual(["web"]);

    // The agent starts a second browser Service: an event, then one re-read, opens it.
    const apiPort = await freePort();
    live = [...live, service({ id: "api", browserScheme: "https", workspacePort: apiPort })];
    fire({ type: "session-process", sessionId: "session-a", projectId: "p" });
    await until(() => opened.length === 2, "the second tunnel");
    expect(opened[1]?.line).toBe(`api → https://localhost:${apiPort}`);

    // Another session's events do not re-read.
    const before = lists;
    fire({ type: "session-process", sessionId: "session-b", projectId: "p" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lists).toBe(before);

    // The web Service stops: its tunnel closes and its port is released.
    live = live.filter((candidate) => candidate.id !== "web");
    fire({ type: "session-process", sessionId: "session-a", projectId: "p" });
    await until(() => closed.length === 1, "the stopped Service's tunnel to close");
    expect(closed).toEqual([["web", "stopped"]]);
    expect(await accepts(webPort)).toBe(false);

    // Detach: every tunnel closes; nothing was asked of the Services beyond the list.
    tunnels.close();
    expect(closed).toEqual([
      ["web", "stopped"],
      ["api", "closed"],
    ]);
    expect(tunnels.current()).toEqual([]);
    expect(await accepts(apiPort)).toBe(false);
  });

  it("falls back to a free port when the Service's own is taken here", async () => {
    const taken = net.createServer();
    const port = await listenLocal(taken, 0, false);
    const tunnels = createServiceTunnels({
      listServices: async () => [service({ id: "web", workspacePort: port })],
      tunnelUrl: async () => new URL("ws://127.0.0.1:1/"),
      events: manualEvents().events,
      pollMs: 60_000,
    });
    open.push(tunnels);
    await tunnels.focus("session-a");
    const [tunnel] = tunnels.current();
    expect(tunnel?.port).not.toBe(port);
    expect(tunnel?.line).toBe(`web → http://localhost:${tunnel?.port}`);
    taken.close();
  });

  it("moves with the focus: the previous session's tunnels close, the next one's open", async () => {
    const aPort = await freePort();
    const bPort = await freePort();
    const closed: Array<readonly [string, string]> = [];
    const tunnels = createServiceTunnels({
      listServices: async () => [
        service({ id: "a-web", workspacePort: aPort }),
        service({ id: "b-web", sessionId: "session-b", workspacePort: bPort }),
      ],
      tunnelUrl: async () => new URL("ws://127.0.0.1:1/"),
      events: manualEvents().events,
      onClose: (tunnel, reason) => closed.push([tunnel.service.id, reason]),
      pollMs: 60_000,
    });
    open.push(tunnels);
    const seen: Array<ReadonlyArray<string>> = [];
    tunnels.subscribe(() => seen.push(tunnels.current().map((tunnel) => tunnel.service.id)));

    await tunnels.focus("session-a");
    await tunnels.focus("session-b");
    expect(closed).toEqual([["a-web", "unfocused"]]);
    expect(tunnels.current().map((tunnel) => tunnel.service.id)).toEqual(["b-web"]);
    expect(await accepts(aPort)).toBe(false);
    await tunnels.focus(null);
    expect(tunnels.current()).toEqual([]);
    expect(seen).toEqual([["a-web"], ["b-web"], []]);
  });

  it("keeps open tunnels when the Service list cannot be read", async () => {
    const port = await freePort();
    let failing = false;
    const tunnels = createServiceTunnels({
      listServices: async () => {
        if (failing) throw new Error("server restarting");
        return [service({ id: "web", workspacePort: port })];
      },
      tunnelUrl: async () => new URL("ws://127.0.0.1:1/"),
      events: manualEvents().events,
      pollMs: 60_000,
    });
    open.push(tunnels);
    await tunnels.focus("session-a");
    failing = true;
    await tunnels.refresh();
    expect(tunnels.current()).toHaveLength(1);
    expect(await accepts(port)).toBe(true);
  });
});
