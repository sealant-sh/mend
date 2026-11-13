import { BoatKeyCheck, BoatKeyStatus, PersonBoatKeyStatus } from "@mend/api-contracts";
import { boatKeyShapeProblem } from "@mend/domain/workbench";
import { Schema } from "effect";

import { usageOf } from "./help.ts";
import type { ApiCall } from "./pair.ts";
import { MendRequestError } from "./server-request.ts";
import { isFlag, jsonWithoutCredentials, redactCredentials } from "./shared.ts";

/**
 * `mend boat`: Boat keys. The organization's (SLNT-790): new Boat sessions in the organization run
 * in, and are billed to, the Boat account of the key an owner connected. With `--mine`, the
 * person's own key in their active organization (SLNT-797): the Boat sessions they start there
 * run in their own Boat account instead. A launch takes the person's key, else the
 * organization's, else the server's. The key is read from a hidden prompt or standard input,
 * never from the command line, and is sent once, to the server, which hands it to Sealant.
 */

const ROUTE = "/organization/boat-key";
const MINE = "/me/boat-key";
/** The server writes its answers through the JSON codec: dates arrive as ISO strings. */
const StatusWire = Schema.toCodecJson(BoatKeyStatus);
const PersonStatusWire = Schema.toCodecJson(PersonBoatKeyStatus);
const CheckWire = Schema.toCodecJson(BoatKeyCheck);

type BoatVerb = "Status" | "Connect" | "Check" | "Disconnect";
type BoatRequest =
  | { readonly _tag: BoatVerb; readonly mine: boolean }
  | { readonly _tag: "Invalid"; readonly message: string };

const KEY_NOT_AN_ARGUMENT =
  "mend boat connect reads the key from a hidden prompt or standard input, never from the command line, so it stays out of your shell history and the process list. Run mend boat connect and paste the key, or pipe it in: mend boat connect < boat-key.txt";

const VERBS: Record<string, { readonly verb: BoatVerb; readonly extra: string }> = {
  status: { verb: "Status", extra: usageOf("boat status") },
  connect: { verb: "Connect", extra: KEY_NOT_AN_ARGUMENT },
  check: { verb: "Check", extra: usageOf("boat check") },
  disconnect: { verb: "Disconnect", extra: usageOf("boat disconnect") },
};

const requestOf = (args: ReadonlyArray<string>): BoatRequest => {
  const words = args.filter((arg) => !isFlag(arg));
  const unknownFlag = args.find((arg) => isFlag(arg) && arg !== "--json" && arg !== "--mine");
  const [word = "status", ...extra] = words;
  if (unknownFlag !== undefined)
    return { _tag: "Invalid", message: `unknown flag ${unknownFlag} · mend help boat` };
  const known = Object.hasOwn(VERBS, word) ? VERBS[word] : undefined;
  if (known === undefined)
    return { _tag: "Invalid", message: `unknown subcommand ${word} · mend help boat` };
  return extra.length === 0
    ? { _tag: known.verb, mine: args.includes("--mine") }
    : { _tag: "Invalid", message: known.extra };
};

/** `2026-11-13 14:02 UTC`: when something was observed, to the minute. */
const at = (date: Date): string => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const runtimeNote = (status: BoatKeyStatus): ReadonlyArray<string> =>
  status.sessionRuntime === "boat"
    ? []
    : [
        `This organization's new sessions run on ${status.sessionRuntime === "docker" ? "this server's Docker" : "the runtime Sealant picks"}, so no session uses a Boat key until they run on Boat.`,
      ];

/** Who in the organization runs their Boat sessions on their own key: owners only. */
const peopleNote = (status: BoatKeyStatus): ReadonlyArray<string> => {
  const people = status.peopleWithOwnKeys;
  if (people === null || people.length === 0) return [];
  const names = people.map((person) => person.name ?? person.userId).join(", ");
  return [
    `With their own Boat key: ${names} · their Boat sessions here run in their own Boat accounts.`,
  ];
};

export const renderStatus = (status: BoatKeyStatus): ReadonlyArray<string> => {
  if (!status.connected) {
    return [
      "This organization has no Boat key · new Boat sessions use the server's.",
      "An owner connects one with mend boat connect.",
      ...runtimeNote(status),
      ...peopleNote(status),
    ];
  }
  const details = status.details;
  if (details === null) {
    return [
      "This organization has its own Boat key · new Boat sessions run in its Boat account.",
      "Only an owner can read its details or change it.",
      ...runtimeNote(status),
    ];
  }
  return [
    `This organization has its own Boat key · connected by ${details.connectedByName ?? details.connectedByUserId} ${at(details.connectedAt)}${details.keyReplacedAt === null ? "" : ` · replaced ${at(details.keyReplacedAt)}`}`,
    `New Boat sessions run in, and are billed to, its Boat account (Sealant account ${details.sealantBoatAccountId}). Running sessions stay where they started.`,
    ...runtimeNote(status),
    ...peopleNote(status),
  ];
};

/** Where the person's Boat sessions go without their own key. */
const fallbackOf = (status: PersonBoatKeyStatus): string =>
  status.organizationKey ? "the organization's" : "the server's";

/** The person's own key in their active organization (SLNT-797), in the words status prints. */
export const renderPersonStatus = (status: PersonBoatKeyStatus): ReadonlyArray<string> => {
  const runtime =
    status.sessionRuntime === "boat"
      ? []
      : [
          `${status.organizationName}'s new sessions run on ${status.sessionRuntime === "docker" ? "this server's Docker" : "the runtime Sealant picks"}, so no session uses a Boat key until they run on Boat.`,
        ];
  const details = status.details;
  if (!status.connected || details === null) {
    return [
      `You have no Boat key of your own in ${status.organizationName} · your Boat sessions use ${fallbackOf(status)} key.`,
      "Connect one with mend boat connect --mine.",
      ...runtime,
    ];
  }
  return [
    `Your own Boat key in ${status.organizationName} · connected ${at(details.connectedAt)}${details.keyReplacedAt === null ? "" : ` · replaced ${at(details.keyReplacedAt)}`}`,
    `The Boat sessions you start there run in, and are billed to, your Boat account (Sealant account ${details.sealantBoatAccountId}). Mend keeps no standby workspace on it.`,
    ...runtime,
  ];
};

const REPORT_PENDING =
  "Boat's own report about the key (who it is, the wallet it bills, its permissions and expiry) needs a newer Sealant on this server. Mend shows it once Sealant returns one.";

export const renderCheck = (check: BoatKeyCheck, mine = false): ReadonlyArray<string> => {
  const observed = `observed ${at(check.observedAt)}`;
  const whose = mine ? "your" : "the organization's";
  switch (check.state) {
    case "none":
      return mine
        ? [`You have no Boat key of your own here · ${observed}`]
        : [
            `This organization has no Boat key · ${observed}`,
            "New Boat sessions use the server's key.",
          ];
    case "active":
      return [
        `Sealant holds ${whose} Boat key · active · ${observed}${check.keyReplacedAt === null ? "" : ` · replaced ${at(check.keyReplacedAt)}`}`,
        REPORT_PENDING,
      ];
    case "removing":
      return [
        `Sealant is removing ${whose} Boat account · ${observed}`,
        "No new session runs in it. Connect a key again once the removal is done.",
      ];
    case "missing":
      return [
        `Sealant no longer lists ${whose} Boat account · ${observed}`,
        `Remove the key with mend boat disconnect${mine ? " --mine" : ""}, then connect it again.`,
      ];
  }
};

/** What a removal did (SLNT-803); an answer without `removal` means another request did it. */
export const removalLines = (
  status: Pick<BoatKeyStatus, "removal">,
  mine = false,
): ReadonlyArray<string> => {
  const key = mine ? "your own Boat key" : "the organization's Boat key";
  if (status.removal === undefined)
    return [
      `${mine ? "Your own" : "The organization's"} Boat key was already removed, by another request · nothing more to do`,
    ];
  const drained = status.removal.standbysDrained;
  return [
    `✓ removed ${key} · Sealant deletes the images it built in that Boat account`,
    ...(drained === 0
      ? []
      : [
          `Mend stopped ${drained} standby workspace${drained === 1 ? "" : "s"} there first. Projects with hot sessions warm new ones where sessions run now.`,
        ]),
  ];
};

const tagOf = (error: unknown): string => {
  if (!(error instanceof MendRequestError)) return "BoatKeyUnreadable";
  if (error.refused?.tag) return error.refused.tag;
  if (error.status === 401) return "Unauthorized";
  return error.kind === "http" ? "BoatKeyRefused" : "BoatKeyNoAnswer";
};

export interface BoatBoundary {
  readonly connect: () => { readonly api: ApiCall };
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Whether standard input is a terminal: then the key is asked for with a hidden prompt. */
  readonly terminal: boolean;
  /** Reads a line without echoing it; null when the person cancelled. */
  readonly askHidden: (label: string) => Promise<string | null>;
  readonly readStdin: () => Promise<string>;
}

/** `mend boat [status|connect|check|disconnect] [--json]`. Exit 1 on any failure. */
export const boatCommand = async (
  args: ReadonlyArray<string>,
  boundary: BoatBoundary,
): Promise<0 | 1> => {
  const json = args.includes("--json");
  const asked = requestOf(args);
  const fail = (tag: string, message: string): 1 => {
    if (json)
      boundary.stdout(`${jsonWithoutCredentials({ version: 1, error: { tag, message } })}\n`);
    else boundary.stderr(`mend: ${redactCredentials(message)}\n`);
    return 1;
  };
  const print = (lines: ReadonlyArray<string>) =>
    boundary.stdout(lines.map((line) => `${redactCredentials(line)}\n`).join(""));
  if (asked._tag === "Invalid") return fail("InvalidBoatArguments", asked.message);
  let server: { readonly api: ApiCall };
  try {
    server = boundary.connect();
  } catch (error) {
    return fail("CliConfigUnreadable", error instanceof Error ? error.message : String(error));
  }
  const call = async <A>(
    schema: Schema.Codec<A, unknown>,
    method: "GET" | "PUT" | "POST" | "DELETE",
    body?: unknown,
    route = ROUTE,
  ): Promise<{ readonly ok: A } | { readonly failed: 1 }> => {
    let raw: unknown;
    try {
      raw = await server.api<unknown>(method, route, body);
    } catch (error) {
      return { failed: fail(tagOf(error), error instanceof Error ? error.message : String(error)) };
    }
    const decoded = Schema.decodeUnknownResult(schema)(raw);
    return decoded._tag === "Failure"
      ? { failed: fail("BoatKeyUnreadable", "this CLI could not read the server's answer") }
      : { ok: decoded.success };
  };
  /** The key a request acts on: the organization's, or with `--mine` the caller's own. */
  interface Target<S extends Pick<BoatKeyStatus, "connected" | "removal">> {
    readonly route: string;
    readonly wire: Schema.Codec<S, unknown>;
    readonly render: (status: S) => ReadonlyArray<string>;
    /** "the organization's Boat key", "your own Boat key". */
    readonly key: string;
    readonly none: string;
  }
  const act = async <S extends Pick<BoatKeyStatus, "connected" | "removal">>(
    verb: Exclude<BoatVerb, "Status">,
    target: Target<S>,
  ): Promise<0 | 1> => {
    const printStatus = (status: S, lead: ReadonlyArray<string> = []) => {
      if (json)
        boundary.stdout(
          `${jsonWithoutCredentials({ version: 1, status: Schema.encodeSync(target.wire)(status) })}\n`,
        );
      else print([...lead, ...target.render(status)]);
    };
    const mine = target.route === MINE;
    switch (verb) {
      case "Connect": {
        const read = boundary.terminal
          ? await boundary.askHidden("Boat key (hidden): ")
          : await boundary.readStdin();
        if (read === null) return fail("BoatKeyCancelled", "cancelled · nothing was sent");
        const key = read.trim();
        if (key === "")
          return fail(
            "BoatKeyMissing",
            boundary.terminal
              ? "no key was entered · nothing was sent"
              : `no key on standard input · nothing was sent. Pipe it in: mend boat connect${mine ? " --mine" : ""} < boat-key.txt`,
          );
        const problem = boatKeyShapeProblem(key);
        if (problem !== null) return fail("BoatKeyRefused", problem);
        const before = await call(target.wire, "GET", undefined, target.route);
        if ("failed" in before) return before.failed;
        const answer = await call(target.wire, "PUT", { key }, target.route);
        if ("failed" in answer) return answer.failed;
        printStatus(answer.ok, [
          `✓ ${before.ok.connected ? "replaced" : "connected"} ${target.key}`,
        ]);
        return 0;
      }
      case "Check": {
        const answer = await call(CheckWire, "POST", undefined, `${target.route}/check`);
        if ("failed" in answer) return answer.failed;
        if (json)
          boundary.stdout(
            `${jsonWithoutCredentials({ version: 1, check: Schema.encodeSync(CheckWire)(answer.ok) })}\n`,
          );
        else print(renderCheck(answer.ok, mine));
        return 0;
      }
      case "Disconnect": {
        const before = await call(target.wire, "GET", undefined, target.route);
        if ("failed" in before) return before.failed;
        if (!before.ok.connected) {
          printStatus(before.ok, [`${target.none} · nothing to remove`]);
          return 0;
        }
        const answer = await call(target.wire, "DELETE", undefined, target.route);
        if ("failed" in answer) return answer.failed;
        printStatus(answer.ok, removalLines(answer.ok, mine));
        return 0;
      }
    }
  };
  const organization: Target<BoatKeyStatus> = {
    route: ROUTE,
    wire: StatusWire,
    render: renderStatus,
    key: "the organization's Boat key",
    none: "This organization has no Boat key",
  };
  const own: Target<PersonBoatKeyStatus> = {
    route: MINE,
    wire: PersonStatusWire,
    render: renderPersonStatus,
    key: "your own Boat key",
    none: "You have no Boat key of your own here",
  };
  if (asked._tag !== "Status") {
    return asked.mine ? act(asked._tag, own) : act(asked._tag, organization);
  }
  if (asked.mine) {
    const answer = await call(PersonStatusWire, "GET", undefined, MINE);
    if ("failed" in answer) return answer.failed;
    if (json)
      boundary.stdout(
        `${jsonWithoutCredentials({ version: 1, status: Schema.encodeSync(PersonStatusWire)(answer.ok) })}\n`,
      );
    else print(renderPersonStatus(answer.ok));
    return 0;
  }
  const answer = await call(StatusWire, "GET");
  if ("failed" in answer) return answer.failed;
  if (json) {
    boundary.stdout(
      `${jsonWithoutCredentials({ version: 1, status: Schema.encodeSync(StatusWire)(answer.ok) })}\n`,
    );
    return 0;
  }
  // What decides the caller's own sessions comes after the organization's: their own key, when
  // the server has the route; an older server's refusal leaves the line out.
  const yours = await server.api<unknown>("GET", MINE).then(
    (raw) => Schema.decodeUnknownResult(PersonStatusWire)(raw),
    () => null,
  );
  print([
    ...renderStatus(answer.ok),
    ...(yours === null || yours._tag === "Failure"
      ? []
      : ["", ...renderPersonStatus(yours.success)]),
  ]);
  return 0;
};
