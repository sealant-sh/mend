import { existsSync, readFileSync } from "node:fs";
import { hostname, networkInterfaces, platform } from "node:os";

import { MachineView, MendApi, type AddressKind } from "@mend/api-contracts";
import {
  HOST_USER_NAMESPACE_FILES,
  type HostUserNamespaces,
  hostUserNamespacesOf,
} from "@mend/domain/workbench";
import { addressKindOf, isTrustedHop, NetworkConfig, trustedProxyCidrs } from "@mend/network";
import { WorkspaceHostUserNamespaces } from "@mend/sessions";
import { Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ExposureConfig } from "../exposure.ts";

/** The first IPv4 address in 100.64.0.0/10 bound to any interface. Kept for older clients. */
export const detectTailnetAddress = (
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null => {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        addressKindOf(entry.address, "IPv4") === "cgnat"
      ) {
        return entry.address;
      }
    }
  }
  return null;
};

const KIND_ORDER: ReadonlyArray<AddressKind> = [
  "loopback",
  "private",
  "cgnat",
  "link-local",
  "public",
];

/** The kinds of address the host holds, each once, in a fixed order. No address leaves the server. */
export const observedAddressKinds = (
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): ReadonlyArray<AddressKind> => {
  const seen = new Set<AddressKind>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) seen.add(addressKindOf(entry.address, entry.family));
  }
  return KIND_ORDER.filter((kind) => seen.has(kind));
};

/**
 * Whether the request that asked came through an edge in front of the web tier. This process's
 * own peer is always the web tier (loopback in the bundle, a Pod in the chart), which appends the
 * address IT saw; so that hop says nothing. What says something is the entry the web tier
 * appended: when it is a trusted hop and another entry stands before it, a proxy the operator
 * named (or one on this machine) forwarded a client. A browser that reached the web tier directly
 * leaves one entry, its own address.
 */
export const arrivedThroughAnEdge = (
  peer: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: ReadonlyArray<string>,
): boolean => {
  // Forwarded entries are believed only from a trusted hop; anything else wrote its own.
  if (peer === undefined || !isTrustedHop(peer, trustedProxies)) return false;
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const webTierSaw = entries.at(-1);
  return (
    entries.length >= 2 && webTierSaw !== undefined && isTrustedHop(webTierSaw, trustedProxies)
  );
};

/** Whether a browser origin names this machine's own loopback: it is reachable from here only. */
export const originOnMachine = (appUrl: string): boolean => {
  try {
    const host = new URL(appUrl).hostname;
    return host === "localhost" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return false;
  }
};

const readHostFile = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * Whether workspaces' rootless Docker services can start on this host, when workspaces run on its
 * Docker: the bundle drives the host's daemon through its socket unless the deployment turned that
 * runtime off (`scripts/bundle-supervisor.mjs`). A container reads its host's kernel in /proc/sys,
 * so this answers for the host. Null when workspaces run elsewhere. Read afresh on every call: a
 * host the operator fixed answers at once.
 */
export const observedHostUserNamespaces = (
  read: (file: string) => string | null = readHostFile,
  dockerOnThisHost: boolean = process.env.DOCKER_RUNTIME_ENABLED?.trim() !== "false" &&
    existsSync("/var/run/docker.sock"),
): HostUserNamespaces | null => {
  if (!dockerOnThisHost) return null;
  const [restrict, apparmor, clone] = HOST_USER_NAMESPACE_FILES;
  return hostUserNamespacesOf({
    apparmorRestrictUnprivilegedUserns: read(restrict),
    apparmorEnabled: read(apparmor),
    unprivilegedUsernsClone: read(clone),
  });
};

/** `observedHostUserNamespaces` as the machine view carries it; undefined when workspaces run elsewhere. */
export const observedUserNamespaces = (
  ...args: Parameters<typeof observedHostUserNamespaces>
): MachineView["userNamespaces"] => {
  const observed = observedHostUserNamespaces(...args);
  if (observed === null) return undefined;
  return observed.allowed
    ? { allowed: true, setting: null }
    : { allowed: false, setting: observed.setting };
};

/** The session engine's view of the same host: a launch on a refusing one fails before it builds. */
export const WorkspaceHostUserNamespacesLive: Layer.Layer<WorkspaceHostUserNamespaces> =
  Layer.succeed(WorkspaceHostUserNamespaces, {
    observe: () => Effect.sync(() => observedHostUserNamespaces()),
  });

export const readMachine = (exposure: NonNullable<MachineView["exposure"]>): MachineView => {
  const address = detectTailnetAddress();
  const userNamespaces = observedUserNamespaces();
  return new MachineView({
    hostname: hostname(),
    platform: platform(),
    tailnet:
      address === null
        ? { status: "not-detected", address: null }
        : { status: "reachable", address },
    exposure,
    ...(userNamespaces === undefined ? {} : { userNamespaces }),
  });
};

export const MachineGroupLive = HttpApiBuilder.group(MendApi, "machine", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      const exposure = yield* ExposureConfig;
      const network = yield* NetworkConfig;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const trusted = yield* trustedProxyCidrs.pipe(Effect.orDie);
      const viaProxy = arrivedThroughAnEdge(
        Option.getOrUndefined(request.remoteAddress),
        request.headers["x-forwarded-for"],
        trusted,
      );
      return readMachine({
        declared: exposure.exposure,
        originScheme: network.appUrl.startsWith("https://") ? "https" : "http",
        originOnMachine: originOnMachine(network.appUrl),
        arrivedVia: viaProxy ? "trusted-proxy" : "direct",
        addressKinds: observedAddressKinds(),
        gateOpen: (yield* exposure.gate).filter((outcome) => outcome.established === "open").length,
      });
    }),
  ),
);
