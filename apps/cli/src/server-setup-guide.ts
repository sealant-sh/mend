import * as net from "node:net";

import {
  DECLARABLE_ITEMS,
  DEFAULT_T3_GATEWAY_PORT,
  type DeclarableItem,
  type Exposure,
  parseEdgeHost,
  publishedAddress,
  type Tenancy,
} from "./server-edge.ts";
import {
  DEFAULT_DOCKER_MIRROR_MAX_SIZE,
  DEFAULT_NPM_MIRROR_MAX_SIZE,
  dockerMirrorLogin,
  parseMirrorSize,
  type ServerMirrors,
} from "./server-mirrors.ts";

/**
 * The guided `mend server setup`: questions in plain words on a terminal, answered one at a time,
 * whose answers become the same flags a script passes. The guide never writes anything itself.
 * It ends with the flags, the changes they make in words, and the command a script would run;
 * setup then runs those flags exactly as if they had been typed.
 *
 * Nothing here asks for a bind address. The questions are about who reaches the server; the
 * addresses, the origins, the posture and the declarations follow from the answers.
 */

/**
 * What setup decides about how the server is reached and what runs beside it: the part of the
 * server config a person chooses. Resolved from flags against the saved config by
 * `resolveSetupSettings` (server-setup.ts), so the guide's answers and a script's flags are
 * compared on the same terms.
 */
export interface SetupSettings {
  readonly bind: string;
  /** Where workspace SSH is published when not on `bind`; undefined, it follows `bind`. */
  readonly sshBind: string | undefined;
  readonly appUrl: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly appPort: number;
  readonly sshPort: number;
  readonly edgeHost: string | undefined;
  readonly exposure: Exposure | undefined;
  readonly tenancy: Tenancy | undefined;
  readonly declared: ReadonlyArray<DeclarableItem>;
  readonly t3GatewayPort: number | undefined;
  readonly mirrors: ServerMirrors;
}

const LOOPBACK = "127.0.0.1";

export const isLoopbackAddress = (address: string): boolean =>
  address === "::1" || address.startsWith("127.");

const isLoopbackName = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || isLoopbackAddress(hostname);

const sameSet = <T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean =>
  left.length === right.length && left.every((item) => right.includes(item));

const sameMirrors = (left: ServerMirrors, right: ServerMirrors): boolean =>
  left.npm?.maxSize === right.npm?.maxSize &&
  (left.npm === null) === (right.npm === null) &&
  (left.docker === null) === (right.docker === null) &&
  left.docker?.maxSize === right.docker?.maxSize &&
  dockerMirrorLogin(left.docker) === dockerMirrorLogin(right.docker);

/** Equal as settings: the lists as sets, since their order changes nothing the server reads. */
export const sameSettings = (left: SetupSettings, right: SetupSettings): boolean =>
  left.bind === right.bind &&
  left.sshBind === right.sshBind &&
  left.appUrl === right.appUrl &&
  sameSet(left.allowedOrigins, right.allowedOrigins) &&
  left.appPort === right.appPort &&
  left.sshPort === right.sshPort &&
  left.edgeHost === right.edgeHost &&
  left.exposure === right.exposure &&
  left.tenancy === right.tenancy &&
  sameSet(left.declared, right.declared) &&
  left.t3GatewayPort === right.t3GatewayPort &&
  sameMirrors(left.mirrors, right.mirrors);

// ─── from settings to flags ─────────────────────────────────────────────────

/**
 * The fewest flags that take `before` (the saved settings, or a fresh install's defaults) to
 * `after`. Setup keeps whatever a flag does not name, so only what differs is written. Setup
 * refuses the flags' result when it differs from `after`, so a gap here cannot apply silently.
 */
export const flagsFor = (before: SetupSettings, after: SetupSettings): ReadonlyArray<string> => {
  const flags: Array<string> = [];
  if (after.edgeHost !== before.edgeHost)
    flags.push(...(after.edgeHost === undefined ? ["--no-edge"] : ["--edge", after.edgeHost]));
  if (after.bind !== before.bind) flags.push("--bind", after.bind);
  // Behind the edge the origin is https://<edge>, derived from --edge.
  if (after.edgeHost === undefined && after.appUrl !== before.appUrl)
    flags.push("--url", after.appUrl);
  if (after.appPort !== before.appPort) flags.push("--port", String(after.appPort));
  if (after.sshPort !== before.sshPort) flags.push("--ssh-port", String(after.sshPort));
  // Naming the --bind address takes a separate SSH publication away.
  if (after.sshBind !== before.sshBind) flags.push("--ssh-bind", after.sshBind ?? after.bind);
  if (!sameSet(after.allowedOrigins, before.allowedOrigins))
    flags.push(
      ...(after.allowedOrigins.length === 0
        ? ["--origin", "none"]
        : after.allowedOrigins.flatMap((origin) => ["--origin", origin])),
    );
  if (after.exposure !== undefined && after.exposure !== before.exposure)
    flags.push("--exposure", after.exposure);
  if (after.tenancy !== undefined && after.tenancy !== before.tenancy)
    flags.push("--tenancy", after.tenancy);
  const added = after.declared.filter((item) => !before.declared.includes(item));
  const removed = before.declared.filter((item) => !after.declared.includes(item));
  if (after.declared.length === 0 && removed.length > 0) flags.push("--declare", "none");
  else {
    for (const item of added) flags.push("--declare", item);
    for (const item of removed) flags.push("--undeclare", item);
  }
  if (after.t3GatewayPort !== before.t3GatewayPort) {
    if (after.t3GatewayPort === undefined) flags.push("--no-t3-gateway");
    else if (before.t3GatewayPort === undefined && after.t3GatewayPort === DEFAULT_T3_GATEWAY_PORT)
      flags.push("--t3-gateway");
    else flags.push("--t3-gateway-port", String(after.t3GatewayPort));
  }
  const npmBefore = before.mirrors.npm;
  const npmAfter = after.mirrors.npm;
  if (npmAfter === null && npmBefore !== null) flags.push("--no-npm-mirror");
  if (npmAfter !== null) {
    const sized = npmAfter.maxSize !== (npmBefore?.maxSize ?? DEFAULT_NPM_MIRROR_MAX_SIZE);
    if (sized) flags.push("--npm-mirror-max-size", npmAfter.maxSize);
    else if (npmBefore === null) flags.push("--npm-mirror");
  }
  const dockerBefore = before.mirrors.docker;
  const dockerAfter = after.mirrors.docker;
  if (dockerAfter === null && dockerBefore !== null) flags.push("--no-docker-mirror");
  if (dockerAfter !== null) {
    const sized = dockerAfter.maxSize !== (dockerBefore?.maxSize ?? DEFAULT_DOCKER_MIRROR_MAX_SIZE);
    if (sized) flags.push("--docker-mirror-max-size", dockerAfter.maxSize);
    else if (dockerBefore === null) flags.push("--docker-mirror");
    if (
      dockerMirrorLogin(dockerBefore) !== undefined &&
      dockerMirrorLogin(dockerAfter) === undefined
    )
      flags.push("--no-docker-hub-login");
  }
  return flags;
};

const shellWord = (word: string): string =>
  /^[A-Za-z0-9_./:@=,+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The command a script runs for the same result. With no flags it carries `--yes`: without a
 * terminal and without flags, a fresh install is refused rather than guessed.
 */
export const setupCommandOf = (flags: ReadonlyArray<string>): string =>
  ["mend", "server", "setup", ...(flags.length === 0 ? ["--yes"] : flags.map(shellWord))].join(" ");

// ─── settings in words ──────────────────────────────────────────────────────

const sshAt = (settings: SetupSettings): string => settings.sshBind ?? settings.bind;

/** Whether Remote-SSH from another machine has a port to reach. */
const sshBeyondThisMachine = (settings: SetupSettings): boolean =>
  !isLoopbackAddress(sshAt(settings));

const reachOf = (settings: SetupSettings): string =>
  settings.edgeHost !== undefined
    ? `the public internet, over HTTPS at ${settings.edgeHost} (the edge, Caddy, on 80 and 443)`
    : isLoopbackAddress(settings.bind)
      ? `this machine only, at ${settings.appUrl}`
      : `your network, at ${settings.appUrl} (listening on ${settings.bind})`;

const exposureOf = (settings: SetupSettings): string =>
  settings.exposure === undefined
    ? "none declared (the server reads private)"
    : `declared ${settings.exposure}`;

const sshOf = (settings: SetupSettings): string => {
  const at = publishedAddress(sshAt(settings), settings.sshPort);
  return sshBeyondThisMachine(settings)
    ? `published on ${at}, beyond this machine`
    : `this machine only (${at})`;
};

const t3Of = (settings: SetupSettings): string =>
  settings.t3GatewayPort === undefined ? "off" : `on, at 127.0.0.1:${settings.t3GatewayPort}`;

const tenancyOf = (settings: SetupSettings): string =>
  settings.tenancy === "multi" ? "several organizations (multi)" : "one organization (single)";

const mirrorsOf = (mirrors: ServerMirrors): string => {
  const login = dockerMirrorLogin(mirrors.docker);
  return [
    `npm ${mirrors.npm === null ? "off" : `on, ${mirrors.npm.maxSize}`}`,
    `Docker Hub ${mirrors.docker === null ? "off" : `on, ${mirrors.docker.maxSize}${login === undefined ? "" : `, pulls as ${login}`}`}`,
  ].join(" · ");
};

const declaredOf = (settings: SetupSettings): string =>
  settings.declared.length === 0 ? "nothing" : settings.declared.join(", ");

const originsOf = (settings: SetupSettings): string =>
  settings.allowedOrigins.length === 0 ? "none" : settings.allowedOrigins.join(", ");

/** One row per thing setup decides, as `label` and value. */
const rowsOf = (settings: SetupSettings): ReadonlyArray<readonly [string, string]> => [
  ["reached", reachOf(settings)],
  ["exposure", exposureOf(settings)],
  ["workspace SSH", sshOf(settings)],
  ["T3 Code gateway", t3Of(settings)],
  ["organizations", tenancyOf(settings)],
  ["mirrors", mirrorsOf(settings.mirrors)],
  ["you declared", declaredOf(settings)],
  ["extra origins", originsOf(settings)],
];

const LABEL_WIDTH = 17;

/** The settings as a table: what is saved, or what a fresh install will be. */
export const settingsLines = (settings: SetupSettings): ReadonlyArray<string> =>
  rowsOf(settings)
    .filter(
      ([label]) =>
        (label !== "you declared" ||
          settings.exposure === "public" ||
          settings.declared.length > 0) &&
        (label !== "extra origins" || settings.allowedOrigins.length > 0),
    )
    .map(([label, value]) => `  ${label.padEnd(LABEL_WIDTH)}${value}`);

/** The settings in one line, the way a person would say them. */
export const headlineOf = (settings: SetupSettings): string =>
  [
    settings.edgeHost !== undefined
      ? `public HTTPS at ${settings.edgeHost}`
      : isLoopbackAddress(settings.bind)
        ? "this machine only"
        : `your network at ${settings.appUrl}`,
    `VS Code SSH from other machines ${sshBeyondThisMachine(settings) ? "on" : "off"}`,
    `T3 gateway ${settings.t3GatewayPort === undefined ? "off" : "on"}`,
  ].join(", ");

/** What differs between two settings, one line each: `label: before → after`. */
export const changeLines = (before: SetupSettings, after: SetupSettings): ReadonlyArray<string> => {
  const was = new Map(rowsOf(before));
  return rowsOf(after).flatMap(([label, value]) => {
    const previous = was.get(label);
    return previous === value ? [] : [`  ${label}: ${previous ?? ""} → ${value}`];
  });
};

// ─── what the guide looks at ────────────────────────────────────────────────

/** An https origin Tailscale Serve forwards, and where to. */
export interface ServeRoute {
  readonly origin: string;
  /** The port on this machine's loopback it forwards to; null when it goes elsewhere. */
  readonly loopbackPort: number | null;
  /** Whether Funnel publishes it to the public internet. */
  readonly funnel: boolean;
}

/** What `tailscale status --json` and `tailscale serve status --json` said. */
export interface TailscaleFacts {
  readonly running: boolean;
  /** MagicDNS name, without the trailing dot. */
  readonly dnsName: string | null;
  readonly ipv4: string | null;
  readonly ipv6: string | null;
  readonly serve: ReadonlyArray<ServeRoute>;
}

const fieldsOf = (value: unknown): ReadonlyMap<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? new Map(Object.entries(value))
    : new Map();

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The loopback port a Serve proxy target names (`http://127.0.0.1:3105`, `localhost:3105`, `3105`). */
const loopbackPortOf = (target: string): number | null => {
  if (/^\d+$/.test(target)) return Number(target);
  try {
    const url = new URL(/^[a-z+]+:\/\//.test(target) ? target : `http://${target}`);
    if (!isLoopbackName(url.hostname) || url.port === "") return null;
    return Number(url.port);
  } catch {
    return null;
  }
};

/** Tailscale's own words, read; null when the status is not Tailscale's JSON. */
export const tailscaleFactsOf = (status: string, serve: string): TailscaleFacts | null => {
  const fields = fieldsOf(parseJson(status));
  if (!fields.has("BackendState")) return null;
  const self = fieldsOf(fields.get("Self"));
  const dns = self.get("DNSName");
  const ips = self.get("TailscaleIPs");
  const addresses = Array.isArray(ips)
    ? ips.filter((ip): ip is string => typeof ip === "string")
    : [];
  const ipv4 = addresses.find((ip) => net.isIPv4(ip));
  const ipv6 = addresses.find((ip) => net.isIPv6(ip));
  const serveFields = fieldsOf(parseJson(serve));
  const funnel = fieldsOf(serveFields.get("AllowFunnel"));
  const routes = [...fieldsOf(serveFields.get("Web")).entries()].flatMap(([hostPort, web]) => {
    const match = /^(.+):(\d+)$/.exec(hostPort);
    if (match === null) return [];
    const [, host = "", port = ""] = match;
    const root = fieldsOf(fieldsOf(fieldsOf(web).get("Handlers")).get("/"));
    const proxy = root.get("Proxy");
    return [
      {
        origin: port === "443" ? `https://${host}` : `https://${host}:${port}`,
        loopbackPort: typeof proxy === "string" ? loopbackPortOf(proxy) : null,
        funnel: funnel.get(hostPort) === true,
      },
    ];
  });
  return {
    running: fields.get("BackendState") === "Running",
    dnsName: typeof dns === "string" && dns !== "" ? dns.replace(/\.$/, "") : null,
    ipv4: ipv4 ?? null,
    ipv6: ipv6 ?? null,
    serve: routes,
  };
};

/** What the guide may look at on this machine. Each is an observation, shown as one. */
export interface GuideObservations {
  /** Tailscale's facts, or null when `tailscale` did not answer. */
  readonly tailscale: () => Promise<TailscaleFacts | null>;
  /** The addresses a name resolves to here; null when it does not resolve. */
  readonly lookupHost: (host: string) => Promise<ReadonlyArray<string> | null>;
  /** This machine's own addresses, loopback excluded. */
  readonly localAddresses: () => ReadonlyArray<string>;
  /** Whether something on this machine already listens on the port. */
  readonly portTaken: (port: number) => Promise<boolean>;
}

/** Where the guide talks: a line out, and one answer in (null: the terminal closed, or Ctrl+C). */
export interface GuideIo {
  readonly write: (line: string) => void;
  readonly ask: (prompt: string) => Promise<string | null>;
}

export interface GuideContext {
  /** The saved settings; null on a fresh install. */
  readonly saved: SetupSettings | null;
  /** A fresh install's settings, with no flags. */
  readonly defaults: SetupSettings;
  readonly observe: GuideObservations;
  /** The settings flags give against the saved config; throws setup's own refusal. */
  readonly resolve: (flags: ReadonlyArray<string>) => SetupSettings;
}

export type GuideOutcome =
  | { readonly _tag: "apply"; readonly flags: ReadonlyArray<string> }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "refused"; readonly message: string };

// ─── asking ─────────────────────────────────────────────────────────────────

class GuideStopped extends Error {
  readonly _tag = "GuideStopped" as const;
}

const answer = async (io: GuideIo, prompt: string): Promise<string> => {
  const line = await io.ask(prompt);
  if (line === null) throw new GuideStopped();
  return line.trim();
};

interface Choice<T> {
  readonly label: string;
  /** One line on what it means; empty when the label says it all. */
  readonly detail: string;
  readonly value: T;
}

/** Numbered choices; enter takes `preferred`, the current answer or the usual one. */
const choose = async <T>(
  io: GuideIo,
  question: string,
  choices: ReadonlyArray<Choice<T>>,
  preferred: number,
): Promise<T> => {
  io.write("");
  io.write(question);
  choices.forEach((choice, index) =>
    io.write(`  ${index + 1}. ${choice.label}${choice.detail === "" ? "" : ` · ${choice.detail}`}`),
  );
  const range = choices.length === 2 ? "1 or 2" : `1-${choices.length}`;
  const fallback = choices[preferred] ?? choices[0];
  for (;;) {
    const given = await answer(io, `  ${range} [${preferred + 1}]: `);
    const picked =
      given === "" ? fallback : /^\d+$/.test(given) ? choices[Number(given) - 1] : undefined;
    if (picked !== undefined) return picked.value;
    io.write(`  "${given}" is not one of the choices.`);
  }
};

const yesNo = async (io: GuideIo, question: string, preferred: boolean): Promise<boolean> => {
  for (;;) {
    const given = (await answer(io, `${question} ${preferred ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
    if (given === "") return preferred;
    if (given === "y" || given === "yes") return true;
    if (given === "n" || given === "no") return false;
    io.write("  y or n.");
  }
};

/** A typed answer; `parse` returns the value, or the reason it is refused. */
const typed = async <T>(
  io: GuideIo,
  question: string,
  preferred: string | undefined,
  parse: (input: string) => { readonly value: T } | { readonly refused: string },
): Promise<T> => {
  for (;;) {
    const given = await answer(
      io,
      `${question}${preferred === undefined ? "" : ` [${preferred}]`}: `,
    );
    const input = given === "" ? preferred : given;
    if (input === undefined) {
      io.write("  An answer is needed here.");
      continue;
    }
    const parsed = parse(input);
    if ("value" in parsed) return parsed.value;
    io.write(`  ${parsed.refused}`);
  }
};

// ─── the questions ──────────────────────────────────────────────────────────

type Reach = "machine" | "network" | "public";

const reachModeOf = (settings: SetupSettings): Reach =>
  settings.edgeHost !== undefined
    ? "public"
    : isLoopbackAddress(settings.bind)
      ? "machine"
      : "network";

const without = (
  declared: ReadonlyArray<DeclarableItem>,
  item: DeclarableItem,
): ReadonlyArray<DeclarableItem> => declared.filter((entry) => entry !== item);

const withItem = (
  declared: ReadonlyArray<DeclarableItem>,
  item: DeclarableItem,
): ReadonlyArray<DeclarableItem> => (declared.includes(item) ? declared : [...declared, item]);

/** An origin as typed: a name, `name:port`, or a whole http(s) origin. */
const originOf = (input: string, port: number): string | null => {
  const withScheme = /^https?:\/\//.test(input) ? input : `http://${input}`;
  try {
    const url = new URL(withScheme);
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
      return null;
    if (url.pathname !== "/") return null;
    if (!/^https?:\/\//.test(input) && url.port === "") url.port = String(port);
    return url.origin;
  } catch {
    return null;
  }
};

/** Memoized: one look at Tailscale per run. */
const tailscaleOnce = (observe: GuideObservations): (() => Promise<TailscaleFacts | null>) => {
  let facts: Promise<TailscaleFacts | null> | undefined;
  return () => (facts ??= observe.tailscale());
};

/** The address the tailnet reaches this machine at: IPv4 when it has one, else IPv6. */
const tailnetAddress = (tailscale: TailscaleFacts | null): string | null =>
  tailscale?.running === true ? (tailscale.ipv4 ?? tailscale.ipv6) : null;

/** An address as a URL's host: an IPv6 literal in brackets. */
const urlHost = (address: string): string => (net.isIPv6(address) ? `[${address}]` : address);

/**
 * The settings as setup itself keeps them: an extra origin that is now the URL is no longer extra,
 * and an SSH publication on the web's own address is no separate publication. The flag resolver
 * folds both the same way, so the guide compares like with like.
 */
const settled = (settings: SetupSettings): SetupSettings => ({
  ...settings,
  sshBind: settings.sshBind === settings.bind ? undefined : settings.sshBind,
  allowedOrigins: [...new Set(settings.allowedOrigins)].filter(
    (origin) => origin !== settings.appUrl,
  ),
});

interface Asked {
  readonly io: GuideIo;
  readonly context: GuideContext;
  readonly tailscale: () => Promise<TailscaleFacts | null>;
  readonly fresh: boolean;
}

const toThisMachine = (settings: SetupSettings): SetupSettings => ({
  ...settings,
  bind: isLoopbackAddress(settings.bind) ? settings.bind : LOOPBACK,
  sshBind: undefined,
  edgeHost: undefined,
  appUrl:
    settings.edgeHost === undefined && isLoopbackName(new URL(settings.appUrl).hostname)
      ? settings.appUrl
      : `http://localhost:${settings.appPort}`,
  exposure: "loopback",
  declared: without(settings.declared, "workspace-ssh"),
});

const askNetwork = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  const { io } = asked;
  const tailscale = await asked.tailscale();
  io.write("");
  if (tailscale === null) io.write("Observed: tailscale did not answer on this machine.");
  else if (!tailscale.running)
    io.write("Observed: Tailscale is installed here and not running (tailscale up starts it).");
  else
    io.write(
      `Observed: Tailscale is up; this machine is ${tailscale.dnsName ?? "unnamed"} at ${[tailscale.ipv4, tailscale.ipv6].filter((ip) => ip !== null).join(" and ") || "no address"} on your tailnet.`,
    );
  const tailnet = tailnetAddress(tailscale);
  const others = asked.context.observe
    .localAddresses()
    .filter((address) => net.isIPv4(address) && address !== tailnet);
  const port = settings.appPort;
  // Where a network install listens now stays a choice, whatever this machine's addresses are.
  const listening =
    reachModeOf(settings) === "network" &&
    settings.bind !== "0.0.0.0" &&
    settings.bind !== tailnet &&
    !others.includes(settings.bind)
      ? settings.bind
      : null;
  const choices: ReadonlyArray<Choice<{ readonly bind: string; readonly host: string | null }>> = [
    ...(listening === null
      ? []
      : [
          {
            label: `where it listens now, ${listening}`,
            detail: "keeps the address it is published on",
            value: { bind: listening, host: urlHost(listening) },
          },
        ]),
    ...(tailnet === null
      ? []
      : [
          {
            label: `over Tailscale, as ${tailscale?.dnsName ?? tailnet}`,
            detail: `listens on ${tailnet}, this machine's tailnet address, and is published there only`,
            value: { bind: tailnet, host: tailscale?.dnsName ?? urlHost(tailnet) },
          },
        ]),
    ...others.map((address) => ({
      label: `on this network address, ${address}`,
      detail: `listens on ${address} only, and is published on that network`,
      value: { bind: address, host: address },
    })),
    {
      label: "on every address of this machine",
      detail: "listens on 0.0.0.0: your firewall decides who reaches it",
      value: { bind: "0.0.0.0", host: null },
    },
  ];
  const current = choices.findIndex((choice) => choice.value.bind === settings.bind);
  const picked = await choose(
    io,
    "Which network do people reach it on?",
    choices,
    current < 0 ? 0 : current,
  );
  const keepsUrl = picked.bind === settings.bind && reachModeOf(settings) === "network";
  const preferred = keepsUrl
    ? settings.appUrl
    : picked.host !== null
      ? `http://${picked.host}:${port}`
      : others[0] === undefined
        ? undefined
        : `http://${others[0]}:${port}`;
  const appUrl = await typed(
    io,
    "The address people open in a browser",
    preferred,
    (input): { readonly value: string } | { readonly refused: string } => {
      const origin = originOf(input, port);
      if (origin === null)
        return { refused: `"${input}" is not a name, an address or an http(s) origin.` };
      if (isLoopbackName(new URL(origin).hostname))
        return {
          refused: "That address reaches this machine only; choose a name others can open.",
        };
      return { value: origin };
    },
  );
  // SSH keeps what was saved: on the web's address it follows the new one, and published apart
  // (loopback only, the tailnet, every address) it stays where it is until the SSH question moves it.
  const followsWeb = settings.sshBind === undefined && !isLoopbackAddress(settings.bind);
  return settled({
    ...settings,
    bind: picked.bind,
    sshBind:
      followsWeb || reachModeOf(settings) === "machine"
        ? undefined
        : (settings.sshBind ?? settings.bind),
    edgeHost: undefined,
    appUrl,
    exposure: "private",
  });
};

const FRESH_PUBLIC = [
  "A fresh install starts on this machine first. Until the first account exists, whoever reaches",
  "the address first can register it, and the server refuses to start as public without one.",
  "Setup installs Mend on this machine now. Create the first account at the address it prints,",
  "then run mend server setup again and choose the public internet.",
];

const askPublic = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  const { io } = asked;
  io.write("");
  io.write(
    "Mend runs an edge, Caddy, on ports 80 and 443 of every address. It gets and renews a certificate for your domain and forwards to Mend, which stays on 127.0.0.1.",
  );
  const domain = await typed(io, "Your domain for Mend", settings.edgeHost, (input) => {
    const host = parseEdgeHost(input);
    return host === null
      ? {
          refused: `"${input}" is not a DNS name a certificate can be issued for, such as mend.example.com.`,
        }
      : { value: host };
  });
  const resolved = await asked.context.observe.lookupHost(domain);
  const own = asked.context.observe.localAddresses();
  if (resolved === null || resolved.length === 0)
    io.write(
      `Observed: ${domain} does not resolve from this machine. Caddy cannot get a certificate until its DNS points here.`,
    );
  else if (resolved.some((address) => own.includes(address)))
    io.write(`Observed: ${domain} resolves to ${resolved.join(", ")}, an address of this machine.`);
  else
    io.write(
      `Observed: ${domain} resolves to ${resolved.join(", ")}; this machine's own addresses are ${own.length === 0 ? "none" : own.join(", ")}. Behind NAT or a load balancer that can still reach here: Caddy needs 80 and 443 to reach this machine from the internet.`,
    );
  if (settings.edgeHost === undefined) {
    const taken = [];
    for (const port of [80, 443]) if (await asked.context.observe.portTaken(port)) taken.push(port);
    io.write(
      taken.length === 0
        ? "Observed: nothing on this machine listens on 80 or 443 yet."
        : `Observed: something on this machine already listens on ${taken.join(" and ")}; the edge needs ${taken.length === 1 ? "it" : "them"}.`,
    );
  }
  // The web goes back to loopback behind the edge; SSH stays where it was published until the
  // SSH question that follows moves it.
  const publicSettings = settled({
    ...settings,
    edgeHost: domain,
    appUrl: `https://${domain}`,
    bind: isLoopbackAddress(settings.bind) ? settings.bind : LOOPBACK,
    sshBind: reachModeOf(settings) === "machine" ? undefined : sshAt(settings),
    exposure: "public",
  });
  return askSsh(asked, publicSettings);
};

/**
 * Remote-SSH from other machines: workspace SSH is a port of its own, published on loopback, on
 * the web's address, on the tailnet or on every address. On a public install, publishing it beyond
 * loopback needs a statement Mend cannot check.
 */
const askSsh = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  const { io } = asked;
  const tailnet = tailnetAddress(await asked.tailscale());
  const port = settings.sshPort;
  const web = isLoopbackAddress(settings.bind) ? null : settings.bind;
  const candidates: ReadonlyArray<Choice<string>> = [
    {
      label: "no, this machine only",
      detail: `SSH on ${publishedAddress(LOOPBACK, port)}`,
      value: LOOPBACK,
    },
    ...(web === null || web === "0.0.0.0" || web === tailnet
      ? []
      : [
          {
            label: "yes, on the same address as the web",
            detail: `SSH on ${publishedAddress(web, port)}`,
            value: web,
          },
        ]),
    ...(tailnet === null
      ? []
      : [
          {
            label: "yes, over Tailscale only",
            detail: `SSH on ${publishedAddress(tailnet, port)}, the tailnet address`,
            value: tailnet,
          },
        ]),
    {
      label: "yes, from any network",
      detail: `SSH on ${publishedAddress("0.0.0.0", port)}: a firewall decides who reaches it`,
      value: "0.0.0.0",
    },
  ];
  // Published somewhere none of these name (a saved --ssh-bind): that stays a choice.
  const at = sshAt(settings);
  const choices: ReadonlyArray<Choice<string>> =
    isLoopbackAddress(at) || candidates.some((choice) => choice.value === at)
      ? candidates
      : [
          ...candidates,
          {
            label: "yes, where it is published now",
            detail: `SSH on ${publishedAddress(at, port)}`,
            value: at,
          },
        ];
  const current = isLoopbackAddress(at) ? 0 : choices.findIndex((choice) => choice.value === at);
  const chosen = await choose(
    io,
    `Should VS Code Remote-SSH and mend ssh reach sessions from other machines?${settings.edgeHost === undefined ? " Workspace SSH" : " The edge carries HTTPS only; workspace SSH"} is a port of its own.`,
    choices,
    current < 0 ? 0 : current,
  );
  const onLoopback = (): SetupSettings =>
    settled({
      ...settings,
      sshBind: isLoopbackAddress(settings.bind) ? undefined : LOOPBACK,
      declared: without(settings.declared, "workspace-ssh"),
    });
  if (isLoopbackAddress(chosen)) return onLoopback();
  if (settings.exposure !== "public") return settled({ ...settings, sshBind: chosen });
  const declared = settings.declared.includes("workspace-ssh") && at === chosen;
  const checked = await choose(
    io,
    `Mend cannot see who reaches ${publishedAddress(chosen, port)} from outside, and a public server does not start until you state that you checked (the exposure gate's workspace-ssh item).`,
    [
      {
        label: "I checked it from a network that should not reach it",
        detail: "declares workspace-ssh",
        value: true,
      },
      { label: "not yet", detail: "SSH stays on this machine for now", value: false },
    ],
    declared ? 0 : 1,
  );
  return checked
    ? settled({
        ...settings,
        sshBind: chosen,
        declared: withItem(settings.declared, "workspace-ssh"),
      })
    : onLoopback();
};

/** Origins Tailscale Serve forwards to Mend's port here, offered as extra browser origins. */
const offerServeOrigins = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  const tailscale = await asked.tailscale();
  let next = settings;
  for (const route of tailscale?.serve ?? []) {
    if (
      route.loopbackPort !== settings.appPort ||
      route.origin === next.appUrl ||
      next.allowedOrigins.includes(route.origin)
    )
      continue;
    asked.io.write("");
    asked.io.write(
      `Observed: Tailscale Serve forwards ${route.origin} to Mend's port here${route.funnel ? "; Funnel is on for it, so it answers from the public internet, not only your tailnet" : ""}.`,
    );
    if (await yesNo(asked.io, `Allow ${route.origin} as a browser origin too?`, true))
      next = { ...next, allowedOrigins: [...next.allowedOrigins, route.origin] };
  }
  return next;
};

const askReach = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  const reach = await choose(
    asked.io,
    "How will people reach this Mend?",
    [
      {
        label: "just this machine",
        detail: `a browser here opens http://localhost:${settings.appPort}`,
        value: "machine" as const,
      },
      {
        label: "my private network or Tailscale",
        detail: "a tailnet, a LAN or a VPN you control who joins",
        value: "network" as const,
      },
      {
        label: "the public internet, with HTTPS",
        detail: "your domain, and an edge that gets its certificate",
        value: "public" as const,
      },
    ],
    asked.fresh ? 0 : ["machine", "network", "public"].indexOf(reachModeOf(settings)),
  );
  let next: SetupSettings;
  if (reach === "public" && asked.fresh) {
    asked.io.write("");
    for (const line of FRESH_PUBLIC) asked.io.write(line);
    next = toThisMachine(settings);
  } else if (reach === "public") next = await askPublic(asked, settings);
  else if (reach === "network") next = await askSsh(asked, await askNetwork(asked, settings));
  else next = toThisMachine(settings);
  return settled(await offerServeOrigins(asked, settled(next)));
};

const DECLARATIONS: ReadonlyArray<{
  readonly item: DeclarableItem;
  readonly text: (settings: SetupSettings) => string;
}> = [
  {
    item: "core-private",
    text: () => "Sealant, the database and the mirrors do not answer from the internet",
  },
  {
    item: "edge-tls",
    text: (settings) =>
      `the certificate for ${settings.edgeHost ?? "the edge"} chains to a public root and renews, and port 80 redirects to https`,
  },
  {
    item: "t3code-gateway",
    text: (settings) =>
      `port ${settings.t3GatewayPort ?? DEFAULT_T3_GATEWAY_PORT} answers nothing from another machine, or only through what you put in front of it`,
  },
];

/** The gate items Mend cannot observe; open until the person says they checked from outside. */
const askDeclarations = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  const { io } = asked;
  io.write("");
  io.write(
    "Mend cannot observe these from inside. mend operator exposure lists each as open until you state you checked it from outside; none of them stops a start. Say yes only to what you checked.",
  );
  let declared = settings.declared;
  for (const { item, text } of DECLARATIONS) {
    if (item === "t3code-gateway" && settings.t3GatewayPort === undefined) continue;
    const checked = await yesNo(
      io,
      `  ${item}: ${text(settings)}. Checked?`,
      declared.includes(item),
    );
    declared = checked ? withItem(declared, item) : without(declared, item);
  }
  return { ...settings, declared: DECLARABLE_ITEMS.filter((item) => declared.includes(item)) };
};

const askT3 = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  const port = settings.t3GatewayPort ?? DEFAULT_T3_GATEWAY_PORT;
  asked.io.write("");
  asked.io.write(
    `The T3 Code gateway lets t3code's desktop, mobile and web apps pair with this Mend (mend pair). It listens on 127.0.0.1:${port} only; another machine reaches it through a tunnel you run, such as ssh -L ${port}:127.0.0.1:${port} <this machine>, or tailscale serve.`,
  );
  const on = await yesNo(
    asked.io,
    "Turn on the T3 Code gateway?",
    settings.t3GatewayPort !== undefined,
  );
  return on
    ? { ...settings, t3GatewayPort: port }
    : {
        ...settings,
        t3GatewayPort: undefined,
        declared: without(settings.declared, "t3code-gateway"),
      };
};

const askSize = (asked: Asked, question: string, preferred: string): Promise<string> =>
  typed(asked.io, question, preferred, (input) => {
    const size = parseMirrorSize(input);
    return size === null
      ? { refused: "A whole number of gibibytes or mebibytes, at least 1g, such as 20g or 1536m." }
      : { value: size };
  });

const askMirrors = async (
  asked: Asked,
  settings: SetupSettings,
  offerKeep: boolean,
): Promise<SetupSettings> => {
  const { io } = asked;
  const { npm, docker } = settings.mirrors;
  io.write("");
  io.write(
    `Mirrors: ${mirrorsOf(settings.mirrors)}. Sessions fetch npm packages and Docker Hub images through them, so each is downloaded once; neither publishes a port.`,
  );
  if (offerKeep && (await yesNo(io, "Keep the mirrors as they are?", true))) return settings;
  const npmOn = await yesNo(io, "Run the npm mirror?", npm !== null);
  const npmSize = npmOn
    ? await askSize(asked, "  its disk cap", npm?.maxSize ?? DEFAULT_NPM_MIRROR_MAX_SIZE)
    : null;
  const dockerOn = await yesNo(io, "Run the Docker Hub mirror?", docker !== null);
  const dockerSize = dockerOn
    ? await askSize(asked, "  its disk cap", docker?.maxSize ?? DEFAULT_DOCKER_MIRROR_MAX_SIZE)
    : null;
  const login = dockerMirrorLogin(docker);
  if (dockerOn && login !== undefined)
    io.write(`  It keeps pulling as ${login}; flags change the login (mend help server setup).`);
  return {
    ...settings,
    mirrors: {
      npm: npmSize === null ? null : { maxSize: npmSize },
      docker:
        dockerSize === null
          ? null
          : login === undefined
            ? { maxSize: dockerSize }
            : { maxSize: dockerSize, upstreamUser: login, upstreamPublicOnly: true },
    },
  };
};

const askTenancy = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  const tenancy = await choose(
    asked.io,
    "One organization on this server, or several?",
    [
      {
        label: "one organization",
        detail: "everyone who signs in shares its projects, folders and audit log",
        value: "single" as const,
      },
      {
        label: "several organizations",
        detail: "each with its own members and projects; also sets the multi mode gate's settings",
        value: "multi" as const,
      },
    ],
    settings.tenancy === "multi" ? 1 : 0,
  );
  // Unset reads as single: an install that never declared it stays as it was.
  return tenancy === "single" && settings.tenancy === undefined
    ? settings
    : { ...settings, tenancy };
};

const askOrigins = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  let next = await offerServeOrigins(asked, settings);
  for (;;) {
    asked.io.write("");
    asked.io.write(
      `Browser origins besides ${next.appUrl}: ${next.allowedOrigins.length === 0 ? "none" : next.allowedOrigins.join(", ")}.`,
    );
    const action = await choose(
      asked.io,
      "Allow another origin, or take one away?",
      [
        { label: "keep these", detail: "", value: "keep" as const },
        { label: "add one", detail: "such as a Tailscale Serve name", value: "add" as const },
        ...(next.allowedOrigins.length === 0
          ? []
          : [{ label: "remove one", detail: "", value: "remove" as const }]),
      ],
      0,
    );
    if (action === "keep") return next;
    if (action === "add") {
      const origin = await typed(asked.io, "The origin", undefined, (input) => {
        const parsed = /^https?:\/\//.test(input) ? originOf(input, next.appPort) : null;
        return parsed === null
          ? { refused: "An http:// or https:// origin, such as https://mend.tail1234.ts.net:8443." }
          : { value: parsed };
      });
      if (origin !== next.appUrl && !next.allowedOrigins.includes(origin))
        next = { ...next, allowedOrigins: [...next.allowedOrigins, origin] };
      continue;
    }
    const gone = await choose(
      asked.io,
      "Which one?",
      next.allowedOrigins.map((origin) => ({ label: origin, detail: "", value: origin })),
      0,
    );
    next = { ...next, allowedOrigins: next.allowedOrigins.filter((origin) => origin !== gone) };
  }
};

/** Every question, in order. */
const walk = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  let next = await askReach(asked, settings);
  next = await askT3(asked, next);
  if (
    next.exposure === "public" &&
    (await yesNo(asked.io, "State what you have checked from outside the network now?", false))
  )
    next = await askDeclarations(asked, next);
  next = await askMirrors(asked, next, true);
  return askTenancy(asked, next);
};

type Topic = "reach" | "ssh" | "t3" | "declared" | "mirrors" | "tenancy" | "origins";

const changeOne = async (asked: Asked, settings: SetupSettings): Promise<SetupSettings> => {
  let next = settings;
  for (;;) {
    const topic = await choose<Topic>(
      asked.io,
      "What should change?",
      [
        { label: "how people reach it", detail: reachOf(next), value: "reach" },
        ...(reachModeOf(next) === "machine"
          ? []
          : [
              {
                label: "VS Code Remote-SSH from other machines",
                detail: sshOf(next),
                value: "ssh" as const,
              },
            ]),
        { label: "the T3 Code gateway", detail: t3Of(next), value: "t3" },
        ...(next.exposure === "public"
          ? [
              {
                label: "what you checked from outside",
                detail: declaredOf(next),
                value: "declared" as const,
              },
            ]
          : []),
        { label: "the mirrors", detail: mirrorsOf(next.mirrors), value: "mirrors" },
        { label: "one organization or several", detail: tenancyOf(next), value: "tenancy" },
        { label: "extra browser origins", detail: originsOf(next), value: "origins" },
      ],
      0,
    );
    if (topic === "reach") next = await askReach(asked, next);
    else if (topic === "ssh") next = await askSsh(asked, next);
    else if (topic === "t3") next = await askT3(asked, next);
    else if (topic === "declared") next = await askDeclarations(asked, next);
    else if (topic === "mirrors") next = await askMirrors(asked, next, false);
    else if (topic === "tenancy") next = await askTenancy(asked, next);
    else next = await askOrigins(asked, next);
    asked.io.write("");
    if (!(await yesNo(asked.io, "Change something else?", false))) return next;
  }
};

/**
 * The conversation: on a fresh install every question; on a saved one, the current settings as
 * the defaults, and the choice to keep them, change one thing, or go through every question.
 * Ends with the changes in words and the equivalent command, and applies only on a yes.
 */
export const runGuide = async (io: GuideIo, context: GuideContext): Promise<GuideOutcome> => {
  const base = context.saved ?? context.defaults;
  const asked: Asked = {
    io,
    context,
    tailscale: tailscaleOnce(context.observe),
    fresh: context.saved === null,
  };
  try {
    let target: SetupSettings;
    if (context.saved === null) {
      io.write("Mend server setup. A few questions; enter takes the answer in brackets.");
      target = await walk(asked, base);
    } else {
      io.write(`Currently: ${headlineOf(base)}.`);
      for (const line of settingsLines(base)) io.write(line);
      const how = await choose(
        io,
        "What would you like to do?",
        [
          {
            label: "keep it as it is",
            detail: "setup checks this install and starts it again",
            value: "keep" as const,
          },
          { label: "change something", detail: "pick it, answer, done", value: "change" as const },
          { label: "go through every question", detail: "", value: "walk" as const },
        ],
        0,
      );
      target =
        how === "keep"
          ? base
          : how === "change"
            ? await changeOne(asked, base)
            : await walk(asked, base);
    }
    target = settled(target);
    const flags = flagsFor(base, target);
    let resolved: SetupSettings;
    try {
      resolved = context.resolve(flags);
    } catch (cause) {
      return { _tag: "refused", message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (!sameSettings(resolved, target))
      return {
        _tag: "refused",
        message: `Setup could not say these answers as flags: ${setupCommandOf(flags)} would set something else. Nothing changed; please report this.`,
      };
    io.write("");
    if (context.saved === null) {
      io.write("Setup will install:");
      for (const line of settingsLines(target)) io.write(line);
    } else {
      const changes = changeLines(base, target);
      if (changes.length === 0)
        io.write("Nothing changes: setup checks this install and starts it as it is.");
      else {
        io.write("What changes:");
        for (const line of changes) io.write(line);
      }
    }
    io.write(`Same as: ${setupCommandOf(flags)}`);
    return (await yesNo(io, "Apply?", true)) ? { _tag: "apply", flags } : { _tag: "stopped" };
  } catch (cause) {
    if (cause instanceof GuideStopped) return { _tag: "stopped" };
    throw cause;
  }
};
