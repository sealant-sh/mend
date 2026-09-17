import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { gitRemoteLocation, repositoryCloneUrlIssue } from "@mend/domain/workbench";
import { Config, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/**
 * Where Mend's own git may reach (docs/adr/0003-organizations-and-tenancy.md, "Multi mode gate").
 * Adoption, reference repositories and dotfiles clone from a URL someone typed, with Mend's
 * network position and, often, a signer. On a machine shared by tenants that URL must not reach
 * the host itself, the cloud metadata service, or the private network behind the instance.
 *
 * `operator`: a single team's own machine. Private networks are fine (a Git server on the LAN),
 * the metadata service never is, and loopback or link-local only for the operator.
 * `tenant`: nothing private, reserved or local, and no unauthenticated `git://`, unless an
 * allowed host names it. Loopback and the metadata service can never be allowed.
 */
export type SourceProfile = "operator" | "tenant";

export class SourceRefused extends Schema.TaggedErrorClass<SourceRefused>()("SourceRefused", {
  message: Schema.String,
}) {}

export interface SourceActor {
  readonly isOperator: boolean;
}

/** A remote the policy let through, with the addresses it checked. */
export interface SourceClearance {
  readonly scheme: "http" | "https" | "ssh" | "git";
  readonly host: string;
  readonly port: number | null;
  readonly addresses: ReadonlyArray<string>;
}

export class SourcePolicy extends Context.Service<
  SourcePolicy,
  {
    readonly profile: SourceProfile;
    /** Refuse a clone URL this actor may not make Mend reach. Never names resolved addresses. */
    readonly check: (
      source: string,
      actor: SourceActor,
    ) => Effect.Effect<SourceClearance, SourceRefused>;
    /**
     * The git environment that dials exactly the address the policy checked, so a name cannot
     * answer differently between the check and the connection (DNS rebinding). `tenant` pins
     * HTTPS through `http.curloptResolve` and ssh through `HostName` with `HostKeyAlias` (known
     * hosts still match the name); `operator` leaves the environment as it is, so a single
     * team's ssh configuration keeps working.
     */
    readonly pinnedEnv: (
      clearance: SourceClearance,
      env: Readonly<Record<string, string>>,
    ) => Record<string, string>;
  }
>()("@mend/store/SourcePolicy") {}

// ─── Addresses ──────────────────────────────────────────────────────────────

type AddressClass = "public" | "private" | "loopback" | "link-local" | "metadata";

const ipv4ToNumber = (address: string): number =>
  address.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);

const inIpv4 = (address: string, cidr: string): boolean => {
  const [base = "", bitsText = "32"] = cidr.split("/");
  const bits = Number(bitsText);
  const size = 2 ** (32 - bits);
  const start = Math.floor(ipv4ToNumber(base) / size) * size;
  const value = ipv4ToNumber(address);
  return value >= start && value < start + size;
};

/** An IPv6 address as a 128-bit number; an embedded dotted IPv4 tail is folded in. */
const ipv6ToBigInt = (address: string): bigint => {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const value = ipv4ToNumber(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => "0"), ...tailGroups];
  return groups.reduce((total, group) => (total << 16n) + BigInt(`0x${group || "0"}`), 0n);
};

const inIpv6 = (address: string, cidr: string): boolean => {
  const [base = "", bitsText = "128"] = cidr.split("/");
  const shift = BigInt(128 - Number(bitsText));
  return ipv6ToBigInt(address) >> shift === ipv6ToBigInt(base) >> shift;
};

const PRIVATE_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
const PRIVATE_V6 = ["::/128", "fc00::/7", "64:ff9b::/96", "2002::/16", "ff00::/8"];

/** What an address is, as far as reaching it from Mend goes. */
export const classifyAddress = (address: string): AddressClass => {
  const family = isIP(address);
  if (family === 4) {
    if (address === "169.254.169.254") return "metadata";
    if (inIpv4(address, "127.0.0.0/8")) return "loopback";
    if (inIpv4(address, "169.254.0.0/16")) return "link-local";
    return PRIVATE_V4.some((cidr) => inIpv4(address, cidr)) ? "private" : "public";
  }
  if (family === 6) {
    // An IPv4-mapped address is that IPv4 address.
    if (inIpv6(address, "::ffff:0:0/96")) {
      const value = ipv6ToBigInt(address) & 0xffffffffn;
      const dotted = [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");
      return classifyAddress(dotted);
    }
    if (inIpv6(address, "fd00:ec2::254/128")) return "metadata";
    if (inIpv6(address, "::1/128")) return "loopback";
    if (inIpv6(address, "fe80::/10")) return "link-local";
    return PRIVATE_V6.some((cidr) => inIpv6(address, cidr)) ? "private" : "public";
  }
  return "private";
};

const METADATA_NAMES = new Set(["metadata.google.internal", "metadata"]);

const isLocalName = (host: string): boolean => host === "localhost" || host.endsWith(".localhost");

/** An allowed-host entry: a host name, or a CIDR over IPv4 or IPv6. */
const allows = (entry: string, host: string, address: string): boolean => {
  if (!entry.includes("/")) return entry.toLowerCase() === host;
  const base = entry.slice(0, entry.indexOf("/"));
  if (isIP(base) !== isIP(address)) return false;
  return isIP(address) === 4 ? inIpv4(address, entry) : inIpv6(address, entry);
};

// ─── The policy ─────────────────────────────────────────────────────────────

export interface SourcePolicyOptions {
  readonly profile: SourceProfile;
  /** Names or CIDRs a tenant profile may still reach (a Git server on the private network). */
  readonly allowedHosts: ReadonlyArray<string>;
  /** Every address a host name resolves to; injected so tests need no DNS. */
  readonly resolve: (host: string) => Promise<ReadonlyArray<string>>;
}

export const makeSourcePolicy = (options: SourcePolicyOptions): SourcePolicy["Service"] => {
  const refused = (message: string) => new SourceRefused({ message });

  const check = Effect.fn("SourcePolicy.check")(function* (source: string, actor: SourceActor) {
    const issue = repositoryCloneUrlIssue(source);
    if (issue !== null) return yield* refused(issue);
    const location = gitRemoteLocation(source);
    if (location === null) return yield* refused("That is not a repository URL Mend can clone.");
    const { host } = location;
    if (options.profile === "tenant" && location.scheme === "git") {
      return yield* refused("git:// is unauthenticated and unencrypted; use HTTPS or SSH.");
    }
    if (METADATA_NAMES.has(host)) return yield* refused(`${host} is not a repository host.`);
    const addresses =
      isIP(host) !== 0
        ? [host]
        : isLocalName(host)
          ? ["127.0.0.1"]
          : yield* Effect.tryPromise({
              try: () => options.resolve(host),
              catch: () => refused(`${host} does not resolve from this Mend.`),
            });
    if (addresses.length === 0) return yield* refused(`${host} does not resolve from this Mend.`);
    const clearance: SourceClearance = {
      scheme: location.scheme,
      host,
      port: location.port,
      addresses,
    };
    for (const address of addresses) {
      const kind = classifyAddress(address);
      if (kind === "public") continue;
      if (kind === "metadata") return yield* refused(`${host} is not a repository host.`);
      if (options.profile === "operator") {
        if (kind === "private" || actor.isOperator) continue;
        return yield* refused(`${host} is this machine; only the operator may clone from it.`);
      }
      // tenant: loopback and link-local can never be allowed, private only by name or range.
      if (
        kind === "private" &&
        options.allowedHosts.some((entry) => allows(entry, host, address))
      ) {
        continue;
      }
      return yield* refused(
        `${host} is on a private or reserved network. The operator can allow it with MEND_SOURCE_ALLOWED_HOSTS.`,
      );
    }
    return clearance;
  });

  const pinnedEnv = (
    clearance: SourceClearance,
    env: Readonly<Record<string, string>>,
  ): Record<string, string> => {
    const address = clearance.addresses[0];
    if (options.profile === "operator" || address === undefined || isIP(clearance.host) !== 0) {
      return { ...env };
    }
    if (clearance.scheme === "ssh") {
      return {
        ...env,
        GIT_SSH_COMMAND: `${env["GIT_SSH_COMMAND"] ?? "ssh"} -o HostName=${address} -o HostKeyAlias=${clearance.host}`,
      };
    }
    if (clearance.scheme === "http" || clearance.scheme === "https") {
      const port = clearance.port ?? (clearance.scheme === "https" ? 443 : 80);
      const existing = Number(env["GIT_CONFIG_COUNT"] ?? "0");
      const index = Number.isInteger(existing) && existing > 0 ? existing : 0;
      return {
        ...env,
        GIT_CONFIG_COUNT: String(index + 1),
        [`GIT_CONFIG_KEY_${index}`]: "http.curloptResolve",
        [`GIT_CONFIG_VALUE_${index}`]: `${clearance.host}:${port}:${isIP(address) === 6 ? `[${address}]` : address}`,
      };
    }
    return { ...env };
  };

  return { profile: options.profile, check, pinnedEnv };
};

const resolveAll = async (host: string): Promise<ReadonlyArray<string>> =>
  (await lookup(host, { all: true, verbatim: true })).map((answer) => answer.address);

export const SourcePolicyLive: Layer.Layer<SourcePolicy, Config.ConfigError> = Layer.effect(
  SourcePolicy,
  Effect.gen(function* () {
    const profile = yield* Config.schema(
      Schema.Literals(["operator", "tenant"]),
      "MEND_SOURCE_POLICY",
    ).pipe(Config.withDefault("operator" as const));
    const allowed = yield* Config.string("MEND_SOURCE_ALLOWED_HOSTS").pipe(Config.withDefault(""));
    return makeSourcePolicy({
      profile,
      allowedHosts: allowed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
      resolve: resolveAll,
    });
  }),
);
