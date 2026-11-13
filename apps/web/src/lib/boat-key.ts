import { boatKeyCreateCommand, missingBoatKeyPermissions } from "@mend/domain/workbench";

import type { Tone } from "#/components/kit/status";

import type { BoatKeyReportDto } from "./api.ts";
import { clockTime } from "./session-view.ts";

/**
 * What the Boat key page says about a key's report (SLNT-791): one row per fact Sealant observed,
 * or did not, and the warnings that say what to do. Pure, so every state renders from a fixture.
 */

type NotObserved = Extract<BoatKeyReportDto["identity"], { readonly observed: false }>;
type Observed<F> = Extract<F, { readonly observed: true }>;

/** From this many days before a key expires, the page warns. */
export const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

const NOT_OBSERVED_REASON: Record<NotObserved["reason"], string> = {
  refused: "Boat refused to show this to the key",
  "no-answer": "Boat did not answer",
  "not-listed": "Boat's key list did not include this key",
  unreadable: "Boat's answer could not be read",
};

/** `not observed · Boat refused to show this to the key (403 forbidden: …)`. */
export const notObservedWords = (fact: NotObserved): string => {
  const boat = fact.boat;
  const said =
    boat === null
      ? []
      : [
          [boat.status, boat.code].filter((part) => part !== null).join(" "),
          boat.message ?? "",
        ].filter((part) => part !== "");
  return `not observed · ${NOT_OBSERVED_REASON[fact.reason]}${said.length === 0 ? "" : ` (${said.join(": ")})`}`;
};

/** `Nov 8, 2026`, local. */
export const dayOf = (at: Date): string =>
  at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** `14:02` today, `Nov 8, 2026 14:02` on another day. */
export const observedAt = (at: Date, now: Date): string =>
  at.toDateString() === now.toDateString() ? clockTime(at) : `${dayOf(at)} ${clockTime(at)}`;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const list = (words: ReadonlyArray<string>): string =>
  words.length <= 1
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

export type ExpiryState =
  | { readonly kind: "never" }
  | { readonly kind: "later"; readonly at: Date; readonly days: number }
  | { readonly kind: "soon"; readonly at: Date; readonly days: number }
  | { readonly kind: "expired"; readonly at: Date | null };

export const expiryState = (
  expiry: Observed<BoatKeyReportDto["expiry"]>,
  now: Date,
): ExpiryState => {
  const at = expiry.expiresAt;
  if (expiry.expired || (at !== null && at.getTime() <= now.getTime())) {
    return { kind: "expired", at };
  }
  if (at === null) return { kind: "never" };
  const days = Math.ceil((at.getTime() - now.getTime()) / DAY_MS);
  return days <= EXPIRY_WARNING_DAYS ? { kind: "soon", at, days } : { kind: "later", at, days };
};

/** One row of what Mend observed: a fact, its value, and a tone when the value needs a person. */
export interface BoatKeyFact {
  readonly label: string;
  readonly value: string;
  readonly tone: Tone | null;
}

const row = (label: string, value: string, tone: Tone | null = null): BoatKeyFact => ({
  label,
  value,
  tone,
});

const unobserved = (label: string, fact: NotObserved): BoatKeyFact =>
  row(label, notObservedWords(fact), "off");

const identityRow = (report: BoatKeyReportDto): BoatKeyFact => {
  const { identity, keyKind } = report;
  if (!identity.observed) return unobserved("Key of", identity);
  const name = [
    identity.displayName,
    identity.login === null ? null : `@${identity.login}`,
    identity.serviceAccount === true ? "service account" : null,
  ].filter((part) => part !== null);
  const kind = keyKind.observed
    ? keyKind.kind === "organization"
      ? "a Boat organization's key"
      : "a personal key"
    : null;
  const status =
    identity.accountStatus === "active" || identity.accountStatus === "unknown"
      ? null
      : `Boat account ${identity.accountStatus}`;
  const value = [
    name.length === 0 ? (identity.accountId ?? "an unnamed Boat account") : name.join(" "),
    kind,
    status,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return row("Key of", value, status === null ? null : "bad");
};

const walletRow = (report: BoatKeyReportDto): BoatKeyFact => {
  const { wallet } = report;
  if (!wallet.observed) return unobserved("Bills", wallet);
  if (wallet.kind === "personal") return row("Bills", "a personal wallet");
  const name = wallet.organizationName ?? wallet.organizationId ?? "a Boat organization";
  return row(
    "Bills",
    `the Boat organization ${name}${wallet.role === null ? "" : ` · the key's role there: ${wallet.role}`}`,
  );
};

const startRow = (report: BoatKeyReportDto): BoatKeyFact => {
  const { start } = report;
  if (!start.observed) return unobserved("Starts a VM", start);
  const running = `${start.runningVms} of ${start.allowedVms} VMs running`;
  if (start.canStart) return row("Starts a VM", `yes · ${running}`);
  const why = start.blockedReason ?? start.billingStatus ?? "Boat gave no reason";
  return row("Starts a VM", `no · ${why} · ${running}`, "bad");
};

const snapshotsRow = (report: BoatKeyReportDto): BoatKeyFact => {
  const { snapshots } = report;
  if (!snapshots.observed) return unobserved("Saved snapshots", snapshots);
  return row(
    "Saved snapshots",
    `${snapshots.used} of ${snapshots.included} included slots used`,
    snapshots.used >= snapshots.included ? "wait" : null,
  );
};

const permissionsRow = (report: BoatKeyReportDto): BoatKeyFact => {
  const { permissions } = report;
  if (!permissions.observed) return unobserved("Permissions", permissions);
  const missing = missingBoatKeyPermissions(permissions.held);
  const held = permissions.held.includes("*")
    ? "every permission (*)"
    : plural(permissions.held.length, "permission", "permissions");
  const parts = [
    held,
    missing.length === 0 ? "none Mend needs missing" : `missing ${missing.join(", ")}`,
    permissions.limitedToSandboxes ? "limited to some VMs" : null,
  ].filter((part) => part !== null);
  return row(
    "Permissions",
    parts.join(" · "),
    missing.length > 0 || permissions.limitedToSandboxes ? "bad" : null,
  );
};

const expiryRow = (report: BoatKeyReportDto, now: Date): BoatKeyFact => {
  const { expiry } = report;
  if (!expiry.observed) return unobserved("Expires", expiry);
  const state = expiryState(expiry, now);
  switch (state.kind) {
    case "never":
      return row("Expires", "never");
    case "later":
      return row("Expires", `${dayOf(state.at)} · in ${plural(state.days, "day", "days")}`);
    case "soon":
      return row("Expires", `${dayOf(state.at)} · in ${plural(state.days, "day", "days")}`, "wait");
    case "expired":
      return row("Expires", state.at === null ? "expired" : `expired ${dayOf(state.at)}`, "bad");
  }
};

/** Every fact the report holds, in the order the page lists them. */
export const boatKeyFacts = (report: BoatKeyReportDto, now: Date): ReadonlyArray<BoatKeyFact> => [
  identityRow(report),
  walletRow(report),
  startRow(report),
  snapshotsRow(report),
  permissionsRow(report),
  expiryRow(report, now),
];

const REPLACE = "Create a new key with the command under Replace key, then replace this one.";

/**
 * What needs a person, as sentences that say what to do. Facts that were not observed warn
 * nothing here: their rows already say so.
 */
export const boatKeyWarnings = (
  report: BoatKeyReportDto,
  now: Date,
): ReadonlyArray<{ readonly tone: "wait" | "bad"; readonly text: string }> => {
  const warnings: Array<{ readonly tone: "wait" | "bad"; readonly text: string }> = [];
  const { expiry, permissions, start, identity, snapshots } = report;
  if (expiry.observed) {
    const state = expiryState(expiry, now);
    if (state.kind === "expired") {
      warnings.push({
        tone: "bad",
        text: `This Boat key expired${state.at === null ? "" : ` on ${dayOf(state.at)}`}, so new Boat sessions cannot start with it. ${REPLACE}`,
      });
    } else if (state.kind === "soon") {
      warnings.push({
        tone: "wait",
        text: `This Boat key expires on ${dayOf(state.at)}, in ${plural(state.days, "day", "days")}. After that, new Boat sessions cannot start with it. ${REPLACE}`,
      });
    }
  }
  if (
    identity.observed &&
    (identity.accountStatus === "suspended" || identity.accountStatus === "closed")
  ) {
    warnings.push({
      tone: "bad",
      text: `Boat reports the key's account as ${identity.accountStatus}, so new Boat sessions cannot start in it. Sort it out in Boat, or replace the key with one from another account.`,
    });
  }
  if (permissions.observed) {
    const missing = missingBoatKeyPermissions(permissions.held);
    if (missing.length > 0) {
      warnings.push({
        tone: "bad",
        text: `This key lacks ${list(missing)}, which Sealant needs to run sessions. ${REPLACE}`,
      });
    }
    if (permissions.limitedToSandboxes) {
      warnings.push({
        tone: "bad",
        text: `This key is limited to some VMs or environments, so it cannot reach the VMs Sealant creates. ${REPLACE}`,
      });
    }
  }
  if (start.observed && !start.canStart) {
    const why = start.blockedReason ?? start.billingStatus;
    warnings.push({
      tone: "bad",
      text: `Boat will not start a VM in this wallet now${why === null ? "" : `: ${why}`}. New Boat sessions wait until that changes in Boat.`,
    });
  }
  if (snapshots.observed && snapshots.used >= snapshots.included) {
    warnings.push({
      tone: "wait",
      text: `Every included saved snapshot slot is used (${snapshots.used} of ${snapshots.included}). The image Sealant saves for this account's sessions needs one; Boat charges for slots beyond the included ones.`,
    });
  }
  return warnings;
};

/** The two forms of the create-key command: for a Boat organization, and for a personal account. */
export const BOAT_KEY_COMMANDS = [
  {
    key: "organization",
    caption: "For a Boat organization",
    command: boatKeyCreateCommand("<your-boat-organization>"),
  },
  { key: "personal", caption: "For a personal account", command: boatKeyCreateCommand(null) },
] as const;
