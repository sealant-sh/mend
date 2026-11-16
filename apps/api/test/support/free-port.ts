import { existsSync, readFileSync } from "node:fs";
import * as net from "node:net";

/**
 * Ports for servers that must be told their port before they listen: the gateway, the edges in
 * front of it and the Services behind it are each configured with the others' ports.
 *
 * A port the kernel hands out for `listen(0)` comes from its ephemeral range, the pool that every
 * outgoing connection on the machine also takes its local port from. Once released, it can go to
 * a browser's or a database client's next connection before its server listens, which then fails
 * with EADDRINUSE. So these ports come from below that range, where the kernel hands out nothing
 * on its own, and each Vitest worker takes its own slice so two workers never pick the same one.
 */
const FLOOR = 20_000;
const SLICE = 400;

const ephemeralFloor = (): number => {
  const range = "/proc/sys/net/ipv4/ip_local_port_range";
  const low = existsSync(range) ? Number(readFileSync(range, "utf8").trim().split(/\s+/)[0]) : NaN;
  // Linux's default, and below macOS's 49152.
  return Number.isInteger(low) && low > FLOOR + SLICE ? low : 32_768;
};

const slices = Math.floor((ephemeralFloor() - FLOOR) / SLICE);
const worker = Number(process.env.VITEST_POOL_ID ?? "1");
const sliceStart =
  FLOOR + ((Number.isInteger(worker) && worker > 0 ? worker - 1 : 0) % slices) * SLICE;
let handedOut = 0;

const bindable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });

/** A port nothing listens on now and no outgoing connection can take before its server listens. */
export const freePort = async (): Promise<number> => {
  for (let tried = 0; tried < SLICE; tried += 1) {
    const port = sliceStart + (handedOut % SLICE);
    handedOut += 1;
    if (await bindable(port)) return port;
  }
  throw new Error(`no free port in ${sliceStart}-${sliceStart + SLICE - 1}`);
};
