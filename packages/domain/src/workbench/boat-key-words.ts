import {
  type BoatKeyNotObserved,
  type BoatKeyReport,
  missingBoatKeyPermissions,
} from "./boat-key.ts";
import { billsFact, canBillFact, walletWarnings, type WalletReader } from "./boat-wallet-words.ts";

/**
 * What Mend says about a Boat key's report (SLNT-791): one row per fact Sealant observed, or did
 * not, and the sentences that say what to do. The Boat page and `mend boat` both read these, so
 * they say the same thing. Pure, so every state renders from a fixture.
 */

type Observed<F> = Extract<F, { readonly observed: true }>;

/** From this many days before a key expires, Mend warns. */
export const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

const NOT_OBSERVED_REASON: Record<BoatKeyNotObserved["reason"], string> = {
  refused: "Boat refused to show this to the key",
  "no-answer": "Boat did not answer",
  "not-listed": "Boat's key list did not include this key",
  unreadable: "Boat's answer could not be read",
};

/** `not observed · Boat refused to show this to the key (403 forbidden: …)`. */
export const notObservedWords = (fact: BoatKeyNotObserved): string => {
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

/** Boat's reason as a clause: its own closing period goes, so a sentence can follow. */
const clause = (words: string | null): string | null =>
  words === null ? null : words.trim().replace(/[.\s]+$/, "");

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

export const expiryState = (expiry: Observed<BoatKeyReport["expiry"]>, now: Date): ExpiryState => {
  const at = expiry.expiresAt;
  if (expiry.expired || (at !== null && at.getTime() <= now.getTime())) {
    return { kind: "expired", at };
  }
  if (at === null) return { kind: "never" };
  const days = Math.ceil((at.getTime() - now.getTime()) / DAY_MS);
  return days <= EXPIRY_WARNING_DAYS ? { kind: "soon", at, days } : { kind: "later", at, days };
};

/** How a fact's value reads: fine (null), worth a look, needing a person, or not observed. */
export type BoatKeyTone = "wait" | "bad" | "off";

/** One row of what Mend observed: a fact, its value, and a tone when the value needs a person. */
export interface BoatKeyFact {
  readonly label: string;
  readonly value: string;
  readonly tone: BoatKeyTone | null;
}

const row = (label: string, value: string, tone: BoatKeyTone | null = null): BoatKeyFact => ({
  label,
  value,
  tone,
});

/**
 * Boat refuses a Boat organization's key its own key list, so Sealant cannot read that key's
 * permissions or expiry from it (sealant#635). Only the full check, which proves the key by starting
 * a VM (SLNT-784, `boatAccounts.prove`), can stand in for the permissions.
 */
const unreadableFromOrganizationKey = (
  report: BoatKeyReport,
  fact: BoatKeyReport["permissions"] | BoatKeyReport["expiry"] | BoatKeyNotObserved,
): boolean =>
  !fact.observed &&
  fact.reason === "refused" &&
  report.keyKind.observed &&
  report.keyKind.kind === "organization";

const ORGANIZATION_KEY_UNREADABLE = "not readable from a Boat organization's key";

const unobserved = (label: string, fact: BoatKeyNotObserved): BoatKeyFact =>
  row(label, notObservedWords(fact), "off");

/** A permissions or expiry row Boat did not show: an organization's key never can. */
const unobservedOfKey = (
  report: BoatKeyReport,
  label: string,
  fact: BoatKeyNotObserved,
): BoatKeyFact =>
  unreadableFromOrganizationKey(report, fact)
    ? row(label, `not observed · ${ORGANIZATION_KEY_UNREADABLE}`, "off")
    : unobserved(label, fact);

const identityRow = (report: BoatKeyReport): BoatKeyFact => {
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

const startRow = (report: BoatKeyReport): BoatKeyFact => {
  const { start } = report;
  if (!start.observed) return unobserved("Starts a VM", start);
  const running = `${start.runningVms} of ${start.allowedVms} VMs running`;
  if (start.canStart) return row("Starts a VM", `yes · ${running}`);
  const why = clause(start.blockedReason) ?? start.billingStatus ?? "Boat gave no reason";
  return row("Starts a VM", `no · ${why} · ${running}`, "bad");
};

const snapshotsRow = (report: BoatKeyReport): BoatKeyFact => {
  const { snapshots } = report;
  if (!snapshots.observed) return unobserved("Saved snapshots", snapshots);
  return row(
    "Saved snapshots",
    `${snapshots.used} of ${snapshots.included} included slots used`,
    snapshots.used >= snapshots.included ? "wait" : null,
  );
};

/** What the key lacks: what sealant judged missing, and what it lacks of sealant's and Mend's lists. */
const missingOf = (
  report: BoatKeyReport,
  permissions: Observed<BoatKeyReport["permissions"]>,
): ReadonlyArray<string> => [
  ...new Set([
    ...permissions.missing,
    ...missingBoatKeyPermissions(permissions.held, report.requiredPermissions),
  ]),
];

const permissionsRow = (report: BoatKeyReport): BoatKeyFact => {
  const { permissions } = report;
  if (!permissions.observed) return unobservedOfKey(report, "Permissions", permissions);
  const missing = missingOf(report, permissions);
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

const expiryRow = (report: BoatKeyReport, now: Date): BoatKeyFact => {
  const { expiry } = report;
  if (!expiry.observed) return unobservedOfKey(report, "Expires", expiry);
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

/** Every fact the report holds, in the order Mend lists them. */
export const boatKeyFacts = (
  report: BoatKeyReport,
  now: Date,
  reader: WalletReader = "other",
): ReadonlyArray<BoatKeyFact> => [
  identityRow(report),
  billsFact(report, reader, unobserved),
  ...[canBillFact(report, reader, unobserved)].filter((fact) => fact !== null),
  startRow(report),
  snapshotsRow(report),
  permissionsRow(report),
  expiryRow(report, now),
];

/** A sentence about the key: `bad` and `wait` need a person; `note` says what Mend cannot see. */
export interface BoatKeyWarning {
  readonly tone: "wait" | "bad" | "note";
  readonly text: string;
}

/** The permission sealant reads a key's wallet with (sealant#641). */
const ACCOUNT_READ = "account.read";

/**
 * A key connected before sealant needed `account.read`, and made without it: sealant cannot see
 * which wallet it bills, so it starts nothing new with it, and its running sessions go on. Boat
 * adds no permission to an existing key, so the one remedy is a new key.
 */
const lacksAccountRead = (replace: string): BoatKeyWarning => ({
  tone: "bad",
  text: `This key lacks account.read, so sealant cannot see which Boat wallet it bills: no new Boat session starts with it, and the ones running keep running. Boat adds no permission to an existing key. ${replace}`,
});

/**
 * What needs a person, as sentences that say what to do. `replace` is where the reader makes a new
 * key: the page's Replace key, or the CLI's command. Facts that were not observed warn nothing
 * here, their rows already say so, apart from what an organization's key cannot show.
 */
export const boatKeyWarnings = (
  report: BoatKeyReport,
  now: Date,
  replace: string,
  reader: WalletReader = "other",
): ReadonlyArray<BoatKeyWarning> => {
  const warnings: Array<BoatKeyWarning> = [...walletWarnings(report, reader)];
  const { expiry, permissions, start, identity, snapshots } = report;
  if (expiry.observed) {
    const state = expiryState(expiry, now);
    if (state.kind === "expired") {
      warnings.push({
        tone: "bad",
        text: `This Boat key expired${state.at === null ? "" : ` on ${dayOf(state.at)}`}, so new Boat sessions cannot start with it. ${replace}`,
      });
    } else if (state.kind === "soon") {
      warnings.push({
        tone: "wait",
        text: `This Boat key expires on ${dayOf(state.at)}, in ${plural(state.days, "day", "days")}. After that, new Boat sessions cannot start with it. ${replace}`,
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
    const missing = missingOf(report, permissions);
    const others = missing.filter((permission) => permission !== ACCOUNT_READ);
    if (missing.includes(ACCOUNT_READ)) warnings.push(lacksAccountRead(replace));
    if (others.length > 0) {
      warnings.push({
        tone: "bad",
        text: `This key lacks ${list(others)}, which Mend needs to run sessions. ${replace}`,
      });
    }
    if (permissions.limitedToSandboxes) {
      warnings.push({
        tone: "bad",
        text: `This key is limited to some VMs or environments, so it cannot reach the VMs Mend starts. ${replace}`,
      });
    }
  }
  if (start.observed && !start.canStart) {
    const why = clause(start.blockedReason) ?? start.billingStatus;
    warnings.push({
      tone: "bad",
      text: `Boat will not start a VM in this wallet now${why === null ? "" : `: ${why}`}. New Boat sessions wait until that changes in Boat.`,
    });
  }
  if (snapshots.observed && snapshots.used >= snapshots.included) {
    warnings.push({
      tone: "wait",
      text: `Every included saved snapshot slot is used (${snapshots.used} of ${snapshots.included}). The image Mend saves for this account's sessions needs one; Boat charges for slots beyond the included ones.`,
    });
  }
  if (
    unreadableFromOrganizationKey(report, permissions) ||
    unreadableFromOrganizationKey(report, expiry)
  ) {
    const organization =
      report.organization ??
      (report.wallet.observed ? report.wallet.organizationName : null) ??
      "<your-boat-organization>";
    warnings.push({
      tone: "note",
      text: `Boat does not show a Boat organization's key its own permissions or expiry, so Mend cannot read them from this key. To see them, run boat --org ${organization} api-key list, or open the API Keys tab in Boat's dashboard. If the key lacks a permission or has expired, a Boat session that cannot start says so.`,
    });
  }
  return warnings;
};
