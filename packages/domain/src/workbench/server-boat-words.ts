import type { SessionRuntime } from "../settings.ts";
import { type BoatKeyHolder, boatProblemWords } from "./boat-failure-words.ts";
import type { BoatFailure, BoatFailureKind } from "./boat-failure.ts";
import { boatKeyFacts, boatKeyWarnings } from "./boat-key-words.ts";
import type { BoatKeyReport, BoatUnreachable } from "./boat-key.ts";
import { hasUnreachable, unreachableWords } from "./boat-wallet-words.ts";
import type { BoatAddress, BoatLaunch, ServerBoatFacts, ServerBoatKey } from "./server-boat.ts";

/**
 * Where sessions run and how Boat is doing, as status lines (SLNT-799): `mend server status`,
 * `mend doctor` and the instance page print these. Each says what was declared or observed and
 * when; a line that needs a person ends with what to do. Never a verdict.
 */

/** ok: observed as it should be · info: a fact · todo: worth doing soon · failed: needs a person. */
export type StatusState = "ok" | "info" | "todo" | "failed";

export interface StatusLine {
  readonly label: string;
  readonly state: StatusState;
  readonly detail: string;
  /** What to do, as a sentence or a command; null when nothing needs doing. */
  readonly fix: string | null;
}

/** `2026-11-13 14:02 UTC`: when something was observed, to the minute. */
export const minuteOf = (at: Date): string =>
  `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const observed = (at: Date): string => `observed ${minuteOf(at)}`;

const RUNTIME_WORDS: Readonly<Record<SessionRuntime, string>> = {
  docker: "this server's Docker",
  boat: "Boat",
};

/** What the server offers organizations, and what one gets until an owner chooses. */
export const sessionRuntimesLine = (offer: {
  readonly offered: ReadonlyArray<SessionRuntime>;
  readonly default: SessionRuntime;
}): StatusLine => ({
  label: "sessions",
  state: "info",
  detail: `offered on ${offer.offered.map((runtime) => RUNTIME_WORDS[runtime]).join(" and ")} · new organizations run on ${RUNTIME_WORDS[offer.default]} until an owner chooses · declared`,
  fix: null,
});

const PURPOSE_WORDS: Readonly<Record<BoatAddress["purpose"], string>> = {
  sessions: "session traffic",
  "saved-work": "saved work",
};

/**
 * One public address Boat VMs dial. `from` is where it was asked: this machine (`mend server
 * status`) or the server (its machine view). Neither is Boat's network.
 */
export const boatAddressLine = (address: BoatAddress, from: string): StatusLine =>
  address.answer.answered
    ? {
        label: "boat address",
        state: "ok",
        detail: `${PURPOSE_WORDS[address.purpose]} at ${address.url} · answered HTTP ${address.answer.status} from ${from} · ${observed(address.observedAt)}`,
        fix: null,
      }
    : {
        label: "boat address",
        state: "failed",
        detail: `${PURPOSE_WORDS[address.purpose]} at ${address.url} · no answer from ${from} (${address.answer.detail}) · ${observed(address.observedAt)}`,
        fix: `Forward ${address.url} to this server with a Tailscale Funnel or your own TLS proxy. Boat VMs dial it, and a Boat session cannot start or keep its work without it.`,
      };

const NO_WORKER_FIX =
  "On the server's machine, mend server logs --tail 200 shows what the worker said, and mend server restart starts it again.";

/**
 * Whether Sealant lists Boat. It does once a worker has reported that it launches Boat VMs and
 * some Boat key can pay for them, so a server with no key at all is told to connect one first.
 */
export const boatLaunchLine = (
  launch: BoatLaunch,
  keys: { readonly serverKey: ServerBoatKey; readonly storedKeys: number | null },
): StatusLine => {
  switch (launch.state) {
    case "listed":
      return {
        label: "boat launch",
        state: "ok",
        detail: `Sealant lists Boat: a worker reported that it launches Boat VMs · ${observed(launch.observedAt)}`,
        fix: null,
      };
    case "not-listed":
      return keys.serverKey.state === "none" && keys.storedKeys === 0
        ? {
            label: "boat launch",
            state: "todo",
            detail: `Sealant does not list Boat yet: no Boat key is connected to launch with · ${observed(launch.observedAt)}`,
            fix: "An owner connects their organization's Boat key in Settings, Organization, Boat, or with mend boat connect.",
          }
        : {
            label: "boat launch",
            state: "failed",
            detail: `Sealant does not list Boat: no worker has reported that it launches Boat VMs, so Boat sessions are refused · ${observed(launch.observedAt)}`,
            fix: NO_WORKER_FIX,
          };
    case "unread":
      return {
        label: "boat launch",
        state: "info",
        detail: `not read · ${launch.reason}`,
        fix: null,
      };
  }
};

/**
 * Whether Boat sessions reach project resources (`@db`) through the resource gateway. `declared`
 * is the server's setting where the reader knows it (`mend server status`); null when the line
 * has nothing to say.
 */
export const boatGatewayLine = (
  launch: BoatLaunch,
  declared: boolean | undefined,
): StatusLine | null => {
  if (declared === false)
    return {
      label: "boat gateway",
      state: "info",
      detail:
        "off · declared · a Boat session in a project with resources (@db) is refused; sessions in other projects run",
      fix: "mend server setup --boat-resources turns it on",
    };
  if (launch.state === "listed")
    return launch.resourceGateway
      ? {
          label: "boat gateway",
          state: "ok",
          detail: `${declared === true ? "declared on · " : ""}present on the worker that launches Boat · ${observed(launch.observedAt)}`,
          fix: null,
        }
      : {
          label: "boat gateway",
          state: "failed",
          detail: `${declared === true ? "declared on · " : ""}the worker that launches Boat reports no resource gateway, so a Boat session in a project with resources is refused · ${observed(launch.observedAt)}`,
          fix: NO_WORKER_FIX,
        };
  return declared === true
    ? {
        label: "boat gateway",
        state: "info",
        detail:
          launch.state === "unread"
            ? "declared on · not observed"
            : "declared on · not observed while Sealant does not list Boat",
        fix: null,
      }
    : null;
};

/** The Boat failures that mean Boat refuses the key itself, not that it was busy or silent. */
const KEY_REFUSALS: ReadonlySet<BoatFailureKind> = new Set<BoatFailureKind>([
  "key-refused",
  "key-expired",
  "organization-mismatch",
  "sandbox-outside-key",
  "account-suspended",
]);

/** Boat's refusal of the key at its last check, read from the facts Boat would not show. */
export const reportRefusal = (report: BoatKeyReport): BoatFailure | null => {
  for (const fact of [report.identity, report.wallet, report.keyKind, report.start]) {
    if (!fact.observed && fact.boat !== null && KEY_REFUSALS.has(fact.boat.kind)) return fact.boat;
  }
  return null;
};

const SUMMARY_LABELS: Readonly<Record<string, string>> = {
  "Key of": "key of",
  Bills: "bills",
  "Starts a VM": "starts a VM:",
  Expires: "expires",
};

/** Who the key is, the wallet it bills, whether it can start a VM and its expiry, on one line. */
const summaryOf = (report: BoatKeyReport, now: Date): string =>
  [
    ...boatKeyFacts(report, now).flatMap((fact) => {
      const label = SUMMARY_LABELS[fact.label];
      return label === undefined ? [] : [`${label} ${fact.value}`];
    }),
    observed(report.observedAt),
  ].join(" · ");

/**
 * A Boat key as Sealant last reported it. A refused key, an expired one, missing permissions and
 * a wallet that cannot start a VM need a person; a key that expires within fourteen days is worth
 * doing soon. `replace` says where the reader makes a new key.
 */
export const boatKeyStatusLine = (input: {
  readonly label: string;
  readonly holder: BoatKeyHolder;
  readonly report: BoatKeyReport;
  readonly replace: string;
  readonly now: Date;
}): StatusLine => {
  const { label, holder, report, replace, now } = input;
  const refusal = reportRefusal(report);
  if (refusal !== null) {
    const words = boatProblemWords(
      { kind: refusal.kind, failure: refusal },
      { holder, place: "status" },
    );
    return {
      label,
      state: "failed",
      detail: `Boat refused the key when Sealant last checked it · ${observed(report.observedAt)}`,
      fix: `${words.happened} ${words.todo}`,
    };
  }
  const detail = summaryOf(report, now);
  const warnings = boatKeyWarnings(report, now, replace);
  const needs = warnings.filter((warning) => warning.tone !== "note");
  const state: StatusState = needs.some((warning) => warning.tone === "bad")
    ? "failed"
    : needs.length > 0
      ? "todo"
      : "ok";
  return {
    label,
    state,
    detail,
    fix: needs.length === 0 ? null : needs.map((warning) => warning.text).join(" "),
  };
};

/**
 * What a key made in Boat that sealant cannot reach in any wallet it can bill, as a status line;
 * null when sealant names nothing.
 */
export const boatUnreachableLine = (
  label: string,
  unreachable: BoatUnreachable | null,
  holder: BoatKeyHolder,
): StatusLine | null =>
  hasUnreachable(unreachable)
    ? {
        label,
        state: "todo",
        detail: `${unreachable.savedImages.length + unreachable.runs.length + unreachable.builds.length} things in Boat in no wallet the key can bill · reported by sealant`,
        fix: unreachableWords(unreachable, holder),
      }
    : null;

const REPLACE_SERVER_KEY =
  "Give this server a new key with mend server setup --boat-api-key-stdin.";

/** The server's own Boat key, which only its operator reads. */
export const serverBoatKeyLine = (key: ServerBoatKey, now: Date): StatusLine => {
  switch (key.state) {
    case "none":
      return {
        label: "boat key",
        state: "info",
        detail:
          "this server has no Boat key of its own · each organization's Boat sessions run on the key its owner connects",
        fix: null,
      };
    case "unread":
      return { label: "boat key", state: "info", detail: `not read · ${key.reason}`, fix: null };
    case "held":
      return key.report === null
        ? {
            label: "boat key",
            state: "info",
            detail:
              "this server has a Boat key of its own · Sealant has not checked it with Boat yet; it does when the server starts and once a day",
            fix: null,
          }
        : boatKeyStatusLine({
            label: "boat key",
            holder: "server",
            report: key.report,
            replace: REPLACE_SERVER_KEY,
            now,
          });
  }
};

/**
 * Every Boat line of a server's machine view, in the order a person reads them: the addresses,
 * the server's key, whether Sealant lists Boat, the gateway.
 */
export const serverBoatLines = (input: {
  readonly facts: ServerBoatFacts;
  readonly now: Date;
  readonly from: string;
  /** The gateway setting, when the reader knows it. */
  readonly gatewayDeclared?: boolean | undefined;
}): ReadonlyArray<StatusLine> => {
  const { facts, now, from } = input;
  const gateway = boatGatewayLine(facts.launch, input.gatewayDeclared);
  const unreachable =
    facts.serverKey.state === "held"
      ? boatUnreachableLine("boat unreachable", facts.serverKey.unreachable, "server")
      : null;
  return [
    ...facts.addresses.map((address) => boatAddressLine(address, from)),
    serverBoatKeyLine(facts.serverKey, now),
    ...(unreachable === null ? [] : [unreachable]),
    boatLaunchLine(facts.launch, facts),
    ...(gateway === null ? [] : [gateway]),
  ];
};
