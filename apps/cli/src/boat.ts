import { BoatKeyCheck, BoatKeyFullCheck, BoatKeyStatus } from "@mend/api-contracts";
import {
  type BoatKeyProof,
  type BoatKeyReport,
  boatKeyCreateCommand,
  boatKeyFacts,
  boatKeyShapeProblem,
  boatKeyWarnings,
  FULL_CHECK_COST,
  INTERRUPTED_WORDS,
  proofLeftoverWords,
  proofOutcomeWords,
  proofStepWords,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import { usageOf } from "./help.ts";
import type { ApiCall } from "./pair.ts";
import { MendRequestError } from "./server-request.ts";
import { isFlag, jsonWithoutCredentials, redactCredentials } from "./shared.ts";

/**
 * `mend boat`: the organization's Boat key (SLNT-790). New Boat sessions in the organization run
 * in, and are billed to, the Boat account of the key an owner connected; without one they use the
 * server's. The key is read from a hidden prompt or standard input, never from the command line,
 * and is sent once, to the server, which hands it to Sealant.
 */

const ROUTE = "/organization/boat-key";
/** The server writes its answers through the JSON codec: dates arrive as ISO strings. */
const StatusWire = Schema.toCodecJson(BoatKeyStatus);
const CheckWire = Schema.toCodecJson(BoatKeyCheck);
const FullCheckWire = Schema.toCodecJson(BoatKeyFullCheck);

/** How often `check --full` reads the status while a full check runs, and for how long at most. */
const FULL_CHECK_POLL_MS = 3_000;
const FULL_CHECK_WAIT_MS = 5 * 60_000;

type BoatRequest =
  | { readonly _tag: "Status" }
  | { readonly _tag: "Connect" }
  | { readonly _tag: "Check"; readonly full: boolean }
  | { readonly _tag: "Disconnect" }
  | { readonly _tag: "Invalid"; readonly message: string };

const KEY_NOT_AN_ARGUMENT =
  "mend boat connect reads the key from a hidden prompt or standard input, never from the command line, so it stays out of your shell history and the process list. Run mend boat connect and paste the key, or pipe it in: mend boat connect < boat-key.txt";

const requestOf = (args: ReadonlyArray<string>): BoatRequest => {
  const words = args.filter((arg) => !isFlag(arg));
  const unknownFlag = args.find(
    (arg) => isFlag(arg) && arg !== "--json" && !(arg === "--full" && words[0] === "check"),
  );
  const [verb, ...extra] = words;
  if (unknownFlag !== undefined)
    return { _tag: "Invalid", message: `unknown flag ${unknownFlag} · mend help boat` };
  switch (verb) {
    case undefined:
    case "status":
      return extra.length === 0
        ? { _tag: "Status" }
        : { _tag: "Invalid", message: usageOf("boat status") };
    case "connect":
      return extra.length === 0
        ? { _tag: "Connect" }
        : { _tag: "Invalid", message: KEY_NOT_AN_ARGUMENT };
    case "check":
      return extra.length === 0
        ? { _tag: "Check", full: args.includes("--full") }
        : { _tag: "Invalid", message: usageOf("boat check") };
    case "disconnect":
      return extra.length === 0
        ? { _tag: "Disconnect" }
        : { _tag: "Invalid", message: usageOf("boat disconnect") };
    default:
      return { _tag: "Invalid", message: `unknown subcommand ${verb} · mend help boat` };
  }
};

/** `2026-11-13 14:02 UTC`: when something was observed, to the minute. */
const at = (date: Date): string => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const runtimeNote = (status: BoatKeyStatus): ReadonlyArray<string> =>
  status.sessionRuntime === "boat"
    ? []
    : [
        `This organization's new sessions run on ${status.sessionRuntime === "docker" ? "this server's Docker" : "the runtime Sealant picks"}, so no session uses a Boat key until they run on Boat.`,
      ];

/** Where the CLI sends a person to make a new key: the command itself. */
const REPLACE_FROM_CLI = `Create a new key with ${boatKeyCreateCommand("<your-boat-organization>")} (or --org personal for a personal account), then run mend boat connect to replace this one.`;

/**
 * Boat's report about the key, as the Boat page shows it (`boatKeyFacts`, `boatKeyWarnings`): one
 * line per fact, then what needs a person. `!` marks a sentence that needs one.
 */
export const renderReport = (
  report: BoatKeyReport | null,
  now: Date = new Date(),
): ReadonlyArray<string> => {
  if (report === null) {
    return [
      "Not observed yet: who the key is, the wallet it bills, whether it can start a VM, its saved snapshot slots, its permissions and when it expires. Sealant has not checked this key with Boat since it was connected. mend boat check asks Boat.",
    ];
  }
  const facts = boatKeyFacts(report, now);
  const width = Math.max(...facts.map((fact) => fact.label.length));
  return [
    `What Boat said about the key · observed ${at(report.observedAt)}`,
    ...facts.map((fact) => `  ${fact.label.padEnd(width)}  ${fact.value}`),
    ...boatKeyWarnings(report, now, REPLACE_FROM_CLI).map((warning) =>
      warning.tone === "note" ? warning.text : `! ${warning.text}`,
    ),
  ];
};

/** A full check as the Boat page shows it: the outcome, each step, and what it left in Boat. */
export const renderProof = (proof: BoatKeyProof): ReadonlyArray<string> => {
  const steps = proof.steps.map(proofStepWords);
  const width = Math.max(...steps.map((step) => step.label.length));
  return [
    `Full check · ${proofOutcomeWords(proof)} · finished ${at(proof.finishedAt)}`,
    ...steps.flatMap((step) => [
      `  ${step.label.padEnd(width)}  ${step.word}`,
      ...(step.reason === null ? [] : [`    ! ${step.reason}`]),
    ]),
    ...(proof.outcome === "interrupted" ? [INTERRUPTED_WORDS] : []),
    `${proof.leftBehind.removalConfirmed ? "" : "! "}${proofLeftoverWords(proof)}`,
  ];
};

const runningLine = (since: Date): string =>
  `A full check is running · started ${at(since)} · it takes about a minute.`;

export const renderFullCheck = (fullCheck: BoatKeyFullCheck): ReadonlyArray<string> => [
  ...(fullCheck.runningSince === null ? [] : [runningLine(fullCheck.runningSince)]),
  ...(fullCheck.last === null
    ? fullCheck.runningSince === null
      ? ["No full check has run on this key. mend boat check --full runs one."]
      : []
    : renderProof(fullCheck.last)),
];

export const renderStatus = (status: BoatKeyStatus): ReadonlyArray<string> => {
  if (!status.connected) {
    return [
      "This organization has no Boat key · new Boat sessions use the server's own, if it has one; otherwise they are refused.",
      "An owner connects one with mend boat connect.",
      ...runtimeNote(status),
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
    ...renderReport(details.report),
    ...(details.fullCheck.last === null && details.fullCheck.runningSince === null
      ? []
      : renderFullCheck(details.fullCheck)),
  ];
};

export const renderCheck = (check: BoatKeyCheck): ReadonlyArray<string> => {
  const observed = `observed ${at(check.observedAt)}`;
  switch (check.state) {
    case "none":
      return [
        `This organization has no Boat key · ${observed}`,
        "New Boat sessions use the server's own key, if it has one.",
      ];
    case "active":
      return [
        `Sealant holds the organization's Boat key · active · ${observed}${check.keyReplacedAt === null ? "" : ` · replaced ${at(check.keyReplacedAt)}`}`,
        ...(check.unanswered === null ? [] : [check.unanswered]),
        ...renderReport(check.report),
      ];
    case "removing":
      return [
        `Sealant is removing the organization's Boat account · ${observed}`,
        "No new session runs in it. Connect a key again once the removal is done.",
      ];
    case "missing":
      return [
        `Sealant no longer lists the organization's Boat account · ${observed}`,
        "Remove the key with mend boat disconnect, then connect it again.",
      ];
  }
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
  /** Waits between reads of a running full check; a test passes one that returns at once. */
  readonly sleep?: (ms: number) => Promise<void>;
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
  const printStatus = (status: BoatKeyStatus, lead: ReadonlyArray<string> = []) => {
    if (json)
      boundary.stdout(
        `${jsonWithoutCredentials({ version: 1, status: Schema.encodeSync(StatusWire)(status) })}\n`,
      );
    else print([...lead, ...renderStatus(status)]);
  };
  switch (asked._tag) {
    case "Status": {
      const answer = await call(StatusWire, "GET");
      if ("failed" in answer) return answer.failed;
      printStatus(answer.ok);
      return 0;
    }
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
            : "no key on standard input · nothing was sent. Pipe it in: mend boat connect < boat-key.txt",
        );
      const problem = boatKeyShapeProblem(key);
      if (problem !== null) return fail("BoatKeyRefused", problem);
      const before = await call(StatusWire, "GET");
      if ("failed" in before) return before.failed;
      const answer = await call(StatusWire, "PUT", { key });
      if ("failed" in answer) return answer.failed;
      printStatus(answer.ok, [
        before.ok.connected
          ? "✓ replaced the organization's Boat key"
          : "✓ connected the organization's Boat key",
      ]);
      return 0;
    }
    case "Check": {
      if (asked.full) {
        if (!json) print([FULL_CHECK_COST]);
        const started = await call(FullCheckWire, "POST", undefined, `${ROUTE}/full-check`);
        if ("failed" in started) return started.failed;
        let fullCheck = started.ok;
        // Core answers when the check is done; until then the status says since when.
        const sleep =
          boundary.sleep ??
          ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        const deadline = Date.now() + FULL_CHECK_WAIT_MS;
        while (fullCheck.runningSince !== null && Date.now() < deadline) {
          if (!json) print([runningLine(fullCheck.runningSince)]);
          await sleep(FULL_CHECK_POLL_MS);
          const status = await call(StatusWire, "GET");
          if ("failed" in status) return status.failed;
          if (status.ok.details === null)
            return fail("BoatKeyChanged", "the organization's Boat key was removed meanwhile");
          fullCheck = status.ok.details.fullCheck;
        }
        if (json)
          boundary.stdout(
            `${jsonWithoutCredentials({ version: 1, fullCheck: Schema.encodeSync(FullCheckWire)(fullCheck) })}\n`,
          );
        else
          print(
            fullCheck.runningSince === null
              ? renderFullCheck(fullCheck)
              : [
                  runningLine(fullCheck.runningSince),
                  "It is still running. mend boat status shows its result when it finishes.",
                ],
          );
        return 0;
      }
      const answer = await call(CheckWire, "POST", undefined, `${ROUTE}/check`);
      if ("failed" in answer) return answer.failed;
      if (json)
        boundary.stdout(
          `${jsonWithoutCredentials({ version: 1, check: Schema.encodeSync(CheckWire)(answer.ok) })}\n`,
        );
      else print(renderCheck(answer.ok));
      return 0;
    }
    case "Disconnect": {
      const before = await call(StatusWire, "GET");
      if ("failed" in before) return before.failed;
      if (!before.ok.connected) {
        printStatus(before.ok, ["This organization has no Boat key · nothing to remove"]);
        return 0;
      }
      const answer = await call(StatusWire, "DELETE");
      if ("failed" in answer) return answer.failed;
      printStatus(answer.ok, [
        "✓ removed the organization's Boat key · Sealant deletes the images it built in that Boat account",
      ]);
      return 0;
    }
  }
};
