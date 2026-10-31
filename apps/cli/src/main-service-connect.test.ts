import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";

import { describe, expect, it, onTestFinished } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend, waitFor } = mainTestFixtures();

/** Reserved ports start here, above the well-known and commonly configured fixed ports. */
const RESERVED_FROM = 10_000;

/**
 * The first port of the kernel's ephemeral range. Every listen on port 0 and every outgoing
 * connection on the machine draws from that range, so a port released there can be taken before
 * the CLI binds it (#1012); below it, only an explicit bind of that number lands.
 */
const ephemeralFloor = (): number => {
  let range: string;
  try {
    range = fs
      .readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
      .trim()
      .split(/\s+/)
      .join("–");
  } catch {
    // Not Linux: macOS and Windows start their ephemeral ranges at 49152.
    return 32_768;
  }
  const low = Number(range.split("–")[0]);
  if (!Number.isInteger(low) || low <= RESERVED_FROM) {
    throw new Error(`The ephemeral range is ${range}: no ports below it from ${RESERVED_FROM}.`);
  }
  return low;
};

/** Whether `server` now listens on `port`; false when something else holds it. */
const listenOn = (server: net.Server, port: number) =>
  new Promise<boolean>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve(true);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, "127.0.0.1");
  });

/** Listens on the first free port, from a random start, between `RESERVED_FROM` and the floor. */
const listenBelowEphemeral = async (server: net.Server): Promise<number> => {
  const floor = ephemeralFloor();
  const span = floor - RESERVED_FROM;
  const start = Math.floor(Math.random() * span);
  for (let offset = 0; offset < span; offset += 1) {
    const port = RESERVED_FROM + ((start + offset) % span);
    if (await listenOn(server, port)) return port;
  }
  throw new Error(`No free port between ${RESERVED_FROM} and ${floor}.`);
};

/**
 * Keep unused ports owned; only hand the selected listener ports to the child CLI. They come from
 * below the ephemeral range, so nothing else on the machine is handed one in the moment between
 * its release and the CLI's bind.
 */
const serviceConnectPorts = async (count: number) => {
  const reservations = new Map<number, net.Server>();
  const release = async (ports: ReadonlyArray<number>) => {
    for (const port of ports) {
      const server = reservations.get(port);
      if (server === undefined) throw new Error(`Missing reservation for ${port}.`);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
      reservations.delete(port);
    }
  };
  onTestFinished(() => release([...reservations.keys()]));
  for (let index = 0; index < count; index += 1) {
    const reservation = net.createServer((socket) => socket.end("reserved test port\n"));
    reservations.set(await listenBelowEphemeral(reservation), reservation);
  }
  return { ports: [...reservations.keys()], release };
};

const connectServiceView = (name: string, port: number, transport: "tcp" | "udp" = "tcp") => ({
  service: {
    id: `service-${name}`,
    sessionId: name === "foreign" ? "another-session" : "owned-session",
    name,
    workspacePort: port,
    transport,
    browserScheme: null,
    currentAttemptId: null,
  },
  attempts: [],
  currentForward: { id: `forward-${name}`, hostPort: null, state: "bound" },
  latestObservation: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  endpoints: [],
});

const connectCases: ReadonlyArray<{
  readonly label: string;
  readonly names: ReadonlyArray<string>;
  readonly selected: ReadonlyArray<string>;
  readonly portPosition: "before" | "after" | null;
  readonly reclaimUnselected?: boolean;
}> = [
  { label: "one requested name", names: ["web"], selected: ["web"], portPosition: null },
  {
    label: "both requested names",
    names: ["web", "api"],
    selected: ["web", "api"],
    portPosition: null,
  },
  {
    label: "both reversed requested names",
    names: ["api", "web"],
    selected: ["web", "api"],
    portPosition: null,
  },
  {
    label: "one name while an unrelated listener reclaims an unselected port",
    names: ["web"],
    selected: ["web"],
    portPosition: null,
    reclaimUnselected: true,
  },
  { label: "an ID prefix", names: ["service-we"], selected: ["web"], portPosition: null },
  { label: "a port before the name", names: ["web"], selected: ["web"], portPosition: "before" },
  { label: "a port after the name", names: ["web"], selected: ["web"], portPosition: "after" },
  {
    label: "no names (every live TCP service)",
    names: [],
    selected: ["web", "api", "foreign"],
    portPosition: null,
  },
];

describe("mend service connect", spawning, () => {
  it.each(connectCases)(
    "tunnels $label through the public CLI",
    async ({ names, selected, portPosition, reclaimUnselected }) => {
      const reservation = await serviceConnectPorts(4);
      const [webPort, apiPort, foreignPort, override] = reservation.ports;
      if (
        webPort === undefined ||
        apiPort === undefined ||
        foreignPort === undefined ||
        override === undefined
      )
        throw new Error("Missing service fixture ports.");
      const views = [
        connectServiceView("web", webPort),
        connectServiceView("api", apiPort),
        connectServiceView("foreign", foreignPort),
        connectServiceView("metrics", foreignPort, "udp"),
      ];
      const calls: string[] = [];
      const tickets: string[] = [];
      const fake = await startFakeMend(
        (request, response) => {
          calls.push(`${request.method} ${request.url}`);
          if (request.url === "/api/services") json(response, views);
          else if (request.url === "/api/upgrade-tickets") {
            let body = "";
            request.on("data", (chunk: Buffer) => {
              body += chunk.toString();
            });
            request.on("end", () => {
              tickets.push(body);
              json(response, { ticket: `synthetic-service-ticket-${tickets.length}` });
            });
          } else response.writeHead(404).end();
        },
        "hold",
        false,
      );
      const sockets: net.Socket[] = [];
      const args =
        portPosition === null
          ? [...names]
          : portPosition === "before"
            ? ["--port", String(override), ...names]
            : [...names, "--port", String(override)];
      // The fake API and unselected services retain their ports throughout the test.
      // Binding an extra service now fails instead of confusing an unrelated listener for a tunnel.
      await reservation.release(
        portPosition === null
          ? views
              .filter((view) => selected.includes(view.service.name))
              .map((view) => view.service.workspacePort)
          : [override],
      );
      if (reclaimUnselected) {
        // Deterministically reproduce another process taking a port after its reservation closes.
        await reservation.release([apiPort]);
        const unrelated = net.createServer((socket) => socket.end("unrelated listener\n"));
        unrelated.listen(apiPort, "127.0.0.1");
        await once(unrelated, "listening");
        onTestFinished(
          () =>
            new Promise<void>((resolve, reject) =>
              unrelated.close((error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              }),
            ),
        );
      }
      const cli = startCli(fake.url, ["service", "connect", ...args], {
        MEND_TOKEN: "synthetic-service-token",
      });
      try {
        await waitFor(() => cli.stdout().includes("Ctrl-C stops") || cli.child.exitCode !== null);
        expect(cli.child.exitCode, cli.stderr()).toBeNull();
        const opened = [...cli.stdout().matchAll(/● (\w+) → 127\.0\.0\.1:(\d+)/g)].map(
          (match) => match[1],
        );
        expect(opened).toEqual(selected);
        for (const view of views.filter(
          (candidate) =>
            candidate.service.transport === "tcp" && !selected.includes(candidate.service.name),
        )) {
          const socket = net.createConnection({
            host: "127.0.0.1",
            port: view.service.workspacePort,
          });
          sockets.push(socket);
          socket.setEncoding("utf8");
          let response = "";
          for await (const chunk of socket) response += chunk;
          expect(response, `${view.service.name} must not have a local tunnel`).toBe(
            reclaimUnselected && view.service.name === "api"
              ? "unrelated listener\n"
              : "reserved test port\n",
          );
        }
        for (const view of views.filter((candidate) => selected.includes(candidate.service.name))) {
          const localPort = portPosition === null ? view.service.workspacePort : override;
          const socket = net.createConnection({ host: "127.0.0.1", port: localPort });
          sockets.push(socket);
          await once(socket, "connect");
        }
        await waitFor(() => fake.upgradeCount() === selected.length);
        expect(tickets.toSorted()).toEqual(
          selected
            .map((name) => JSON.stringify({ target: "service-tunnel", service: `service-${name}` }))
            .toSorted(),
        );
        expect(
          fake
            .upgradeUrls()
            .map((value) => new URL(value, fake.url).searchParams.get("service"))
            .toSorted(),
        ).toEqual(selected.map((name) => `service-${name}`).toSorted());
        expect(calls.filter((call) => call === "GET /api/services")).toHaveLength(1);
        expect(fake.upgradeUrls().some((value) => value.includes("synthetic-service-token"))).toBe(
          false,
        );
        if (names.length > 0) expect(tickets.join(" ")).not.toContain("service-foreign");
      } finally {
        try {
          for (const socket of sockets) socket.destroy();
          if (cli.child.exitCode === null && cli.child.signalCode === null) {
            const closed = once(cli.child, "close");
            cli.child.kill("SIGKILL");
            await closed;
          }
        } finally {
          await fake.close();
        }
      }
    },
  );

  it("outlives a local peer that resets before its tunnel opens, and still tunnels the next", async () => {
    const reservation = await serviceConnectPorts(1);
    const [webPort] = reservation.ports;
    if (webPort === undefined) throw new Error("Missing service fixture port.");
    const ticketRequests: Array<() => void> = [];
    const fake = await startFakeMend(
      (request, response) => {
        if (request.url === "/api/services") json(response, [connectServiceView("web", webPort)]);
        else if (request.url === "/api/upgrade-tickets") {
          request.resume();
          // Each ticket waits for the test: the first peer resets while its ticket is pending.
          ticketRequests.push(() =>
            json(response, { ticket: `synthetic-service-ticket-${ticketRequests.length}` }),
          );
        } else response.writeHead(404).end();
      },
      "hold",
      false,
    );
    await reservation.release([webPort]);
    const cli = startCli(fake.url, ["service", "connect", "web"], {
      MEND_TOKEN: "synthetic-service-token",
    });
    const sockets: net.Socket[] = [];
    const connectErrors: NodeJS.ErrnoException[] = [];
    const connect = async () => {
      const socket = net.createConnection({ host: "127.0.0.1", port: webPort });
      sockets.push(socket);
      socket.on("error", (error: NodeJS.ErrnoException) => connectErrors.push(error));
      await waitFor(
        () =>
          socket.readyState === "open" || connectErrors.length > 0 || cli.child.exitCode !== null,
      );
      expect(cli.child.exitCode, cli.stderr()).toBeNull();
      expect(connectErrors).toEqual([]);
      return socket;
    };
    try {
      await waitFor(() => cli.stdout().includes("Ctrl-C stops") || cli.child.exitCode !== null);
      expect(cli.child.exitCode, cli.stderr()).toBeNull();
      const first = await connect();
      await waitFor(() => ticketRequests.length === 1);
      first.resetAndDestroy();
      ticketRequests[0]?.();
      await connect();
      await waitFor(() => ticketRequests.length === 2 || cli.child.exitCode !== null);
      expect(cli.child.exitCode, cli.stderr()).toBeNull();
      ticketRequests[1]?.();
      await waitFor(() => fake.upgradeCount() === 1 || cli.child.exitCode !== null);
      expect(cli.child.exitCode, cli.stderr()).toBeNull();
      expect(
        fake.upgradeUrls().map((value) => new URL(value, fake.url).searchParams.get("service")),
      ).toEqual(["service-web"]);
    } finally {
      try {
        for (const socket of sockets) socket.destroy();
        if (cli.child.exitCode === null && cli.child.signalCode === null) {
          const closed = once(cli.child, "close");
          cli.child.kill("SIGKILL");
          await closed;
        }
      } finally {
        await fake.close();
      }
    }
  });
});

describe("mend service connect errors", spawning, () => {
  it.each([
    {
      args: ["missing"],
      message: 'no live TCP service matches "missing"',
      listed: true,
      tcp: true,
    },
    {
      args: ["web", "api", "--port", "32123"],
      message: "--port applies to exactly one service — name it",
      listed: true,
      tcp: true,
    },
    {
      args: ["--port", "32123"],
      message: "--port applies to exactly one service — name it",
      listed: true,
      tcp: true,
    },
    {
      args: ["web", "--port", "invalid"],
      message: "--port takes a port number",
      listed: false,
      tcp: true,
    },
    {
      args: [],
      message: "no live TCP services — mend service run starts one",
      listed: true,
      tcp: false,
    },
  ])("preserves $message and opens no tunnel", async ({ args, message, listed, tcp }) => {
    const {
      ports: [webPort, apiPort],
    } = await serviceConnectPorts(2);
    if (webPort === undefined || apiPort === undefined)
      throw new Error("Missing error fixture ports.");
    const calls: string[] = [];
    const fake = await startFakeMend((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      if (request.url === "/api/services")
        json(
          response,
          tcp
            ? [connectServiceView("web", webPort), connectServiceView("api", apiPort)]
            : [connectServiceView("metrics", webPort, "udp")],
        );
      else response.writeHead(404).end();
    });
    const cli = startCli(fake.url, ["service", "connect", ...args]);
    try {
      // The missing-name regression used to keep the process alive tunneling every service.
      await waitFor(() => cli.child.exitCode !== null || cli.stdout().includes("Ctrl-C stops"));
      expect(cli.child.exitCode, cli.stdout() + cli.stderr()).toBe(1);
      expect(cli.stderr()).toContain(message);
      expect(cli.stdout()).not.toContain(" → 127.0.0.1:");
      expect(calls).toEqual(listed ? ["GET /api/services"] : []);
      expect(fake.upgradeCount()).toBe(0);
    } finally {
      try {
        if (cli.child.exitCode === null && cli.child.signalCode === null) {
          const closed = once(cli.child, "close");
          cli.child.kill("SIGKILL");
          await closed;
        }
      } finally {
        await fake.close();
      }
    }
  });
});
