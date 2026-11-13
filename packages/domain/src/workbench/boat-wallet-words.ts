import type { BoatKeyHolder } from "./boat-failure-words.ts";
import type { BoatKeyFact, BoatKeyWarning } from "./boat-key-words.ts";
import type {
  BoatKeyNotObserved,
  BoatKeyReport,
  BoatUnreachable,
  BoatWallet,
  BoatWalletChoice,
} from "./boat-key.ts";

/**
 * Which Boat wallet a key bills, whether that is fixed, and which others it can bill (SLNT-821),
 * from sealant's report (`billing`, `wallet`, `wallets`). A personal key is pinned by sealant, at
 * connect, to the wallet it bills then, and can be pointed at another of its wallets later without
 * the key. A Boat organization's key bills that organization and nothing else. Pure, so the Boat
 * page, `mend boat` and the status lines say the same from a fixture.
 */

/** Who reads the words: the key's own person ("your personal Boat account"), or anyone else. */
export type WalletReader = "own" | "other";

const minuteOf = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The key's own personal Boat account, from where the reader stands. */
const personalOf = (report: BoatKeyReport, reader: WalletReader): string => {
  if (reader === "own") return "your personal Boat account";
  const login = report.identity.observed ? report.identity.login : null;
  return login === null
    ? "the personal Boat account of the key"
    : `the personal Boat account of @${login}`;
};

/** `the Boat organization acme-boat`, or the personal account's words. */
export const walletLabel = (
  report: BoatKeyReport,
  wallet: Pick<BoatWallet, "kind" | "organizationId" | "organizationName">,
  reader: WalletReader,
): string =>
  wallet.kind === "personal"
    ? personalOf(report, reader)
    : `the Boat organization ${wallet.organizationName ?? wallet.organizationId ?? "(unnamed)"}`;

const choiceLabel = (
  report: BoatKeyReport,
  choice: BoatWalletChoice,
  reader: WalletReader,
): string =>
  walletLabel(
    report,
    { kind: choice.kind, organizationId: choice.id, organizationName: choice.name },
    reader,
  );

const choicesOf = (report: BoatKeyReport): ReadonlyArray<BoatWalletChoice> | null =>
  report.wallets !== null && report.wallets.observed ? report.wallets.choices : null;

/** The wallet id a report shows the key billing: its pin, else what Boat answered. */
const billedId = (report: BoatKeyReport): string | null => {
  if (report.billing?.mode === "pinned") return report.billing.organization;
  if (!report.wallet.observed) return null;
  return report.wallet.kind === "personal" ? "personal" : report.wallet.organizationId;
};

/** The wallet the key bills, in words, or null when Boat did not show it. */
const billedLabel = (report: BoatKeyReport, reader: WalletReader): string | null => {
  const id = billedId(report);
  const choice = choicesOf(report)?.find((each) => each.id === id);
  if (choice !== undefined) return choiceLabel(report, choice, reader);
  if (report.wallet.observed) return walletLabel(report, report.wallet, reader);
  if (id === null) return null;
  return id === "personal"
    ? personalOf(report, reader)
    : walletLabel(
        report,
        { kind: "organization", organizationId: id, organizationName: null },
        reader,
      );
};

const isOrganizationKey = (report: BoatKeyReport): boolean =>
  report.billing?.mode === "key-organization" ||
  (report.keyKind.observed && report.keyKind.kind === "organization");

/** The "Bills" row: which wallet, and whether that is fixed. */
export const billsFact = (
  report: BoatKeyReport,
  reader: WalletReader,
  unobserved: (label: string, fact: BoatKeyNotObserved) => BoatKeyFact,
): BoatKeyFact => {
  const label = billedLabel(report, reader);
  if (label === null)
    return report.wallet.observed
      ? { label: "Bills", value: "not observed", tone: "off" }
      : unobserved("Bills", report.wallet);
  // The role in the wallet billed: from the listed wallet when the pin names one, so a wallet
  // fact Boat answered for another wallet never lends its role.
  const id = billedId(report);
  const choice = choicesOf(report)?.find((each) => each.id === id);
  const roleIn =
    choice !== undefined
      ? choice.kind === "organization"
        ? choice.role
        : null
      : report.wallet.observed && report.wallet.kind === "organization"
        ? report.wallet.role
        : null;
  const role = roleIn === null ? "" : ` · the key's role there: ${roleIn}`;
  const billing = report.billing;
  if (billing === null) return { label: "Bills", value: `${label}${role}`, tone: null };
  switch (billing.mode) {
    case "key-organization":
      return {
        label: "Bills",
        value: `${label}${role} · fixed: a Boat organization's key bills only its own organization`,
        tone: null,
      };
    case "pinned":
      return {
        label: "Bills",
        value: `${label}${role} · fixed: sealant names it on every request`,
        tone: null,
      };
    case "active-wallet":
      return {
        label: "Bills",
        value: `${label}${role} · not fixed: it follows the active wallet of the key's Boat account`,
        tone: billing.walletChanged === null ? "wait" : "bad",
      };
  }
};

/**
 * The "Can bill" row of a personal key: every wallet its Boat account can bill, the one active in
 * Boat now marked. Null for a Boat organization's key, and for a report from before sealant read
 * the list.
 */
export const canBillFact = (
  report: BoatKeyReport,
  reader: WalletReader,
  unobserved: (label: string, fact: BoatKeyNotObserved) => BoatKeyFact,
): BoatKeyFact | null => {
  if (report.wallets === null || isOrganizationKey(report)) return null;
  if (!report.wallets.observed) return unobserved("Can bill", report.wallets);
  const listed = report.wallets.choices.map(
    (choice) =>
      `${choiceLabel(report, choice, reader)}${choice.role === null || choice.kind === "personal" ? "" : ` (${choice.role})`}${choice.active ? " · active in Boat now" : ""}`,
  );
  return { label: "Can bill", value: listed.join("; "), tone: null };
};

/**
 * What needs saying about the wallet: a key sealant has not pinned yet bills the active wallet of
 * its Boat account, and when that moved, the bill moved with it.
 */
export const walletWarnings = (
  report: BoatKeyReport,
  reader: WalletReader,
): ReadonlyArray<BoatKeyWarning> => {
  const billing = report.billing;
  if (billing?.mode !== "active-wallet") return [];
  const pinned =
    "sealant pins a key it has not pinned yet to the wallet it bills, usually within a minute of an upgrade, and until then no new Boat session starts with it. A key without Boat's account.read permission is never pinned: replace it with one made with the command Mend shows.";
  const changed = billing.walletChanged;
  if (changed === null)
    return [
      {
        tone: "wait",
        text: `This key is not pinned to a wallet yet: it bills whichever wallet its Boat account has active in Boat. ${pinned}`,
      },
    ];
  const now = billedLabel(report, reader) ?? "another wallet";
  return [
    {
      tone: "bad",
      text: `The bill moved: this key billed ${walletLabel(report, changed.from, reader)} until the active wallet of its Boat account changed, observed ${minuteOf(changed.observedAt)}, and bills ${now} now. ${pinned}`,
    },
  ];
};

/** One wallet a person can choose for their key. */
export interface BoatWalletOption {
  /** What sealant's pin names: a Boat organization's id, or `personal`. */
  readonly id: string;
  readonly label: string;
  /** The key's role there, and whether Boat has it active now; null when neither. */
  readonly detail: string | null;
}

/** The wallets a personal key can be pointed at, with the one it bills now. */
export interface BoatWalletChoices {
  /** The id of the wallet the key bills now; null when Boat did not show it. */
  readonly current: string | null;
  readonly options: ReadonlyArray<BoatWalletOption>;
}

/**
 * The wallets to choose from, or null when there is nothing to choose: a Boat organization's key,
 * a key whose Boat account can bill one wallet only, or a report that does not list them.
 */
export const boatWalletChoices = (
  report: BoatKeyReport,
  reader: WalletReader,
): BoatWalletChoices | null => {
  const choices = choicesOf(report);
  if (choices === null || choices.length < 2 || isOrganizationKey(report)) return null;
  const billed = billedId(report);
  return {
    current: choices.some((choice) => choice.id === billed) ? billed : null,
    options: choices.map((choice) => {
      const detail = [
        choice.kind === "organization" && choice.role !== null ? `your role: ${choice.role}` : null,
        choice.active ? "active in Boat now" : null,
      ].filter((part) => part !== null);
      return {
        id: choice.id,
        label: choiceLabel(report, choice, reader),
        detail: detail.length === 0 ? null : detail.join(" · "),
      };
    }),
  };
};

/** The wallet a choice names, in words, for the sentence after it is made. */
export const walletOptionLabel = (choices: BoatWalletChoices, id: string): string =>
  choices.options.find((option) => option.id === id)?.label ?? id;

const list = (words: ReadonlyArray<string>): string =>
  words.length <= 1
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** Whether sealant names anything it cannot reach. */
export const hasUnreachable = (
  unreachable: BoatUnreachable | null,
): unreachable is BoatUnreachable =>
  unreachable !== null &&
  unreachable.savedImages.length + unreachable.runs.length + unreachable.builds.length > 0;

/** What sealant cannot reach, as the things a person can look for in Boat. */
export const unreachableThings = (unreachable: BoatUnreachable): ReadonlyArray<string> => [
  ...(unreachable.savedImages.length === 0
    ? []
    : [
        `${unreachable.savedImages.length === 1 ? "the saved image" : "the saved images"} ${list(unreachable.savedImages)} (Saved snapshots in Boat)`,
      ]),
  ...(unreachable.runs.length === 0
    ? []
    : [
        unreachable.runs.length === 1
          ? "the VM of an ended session"
          : `the VMs of ${unreachable.runs.length} ended sessions`,
      ]),
  ...(unreachable.builds.length === 0
    ? []
    : [
        unreachable.builds.length === 1
          ? "what an image build left"
          : `what ${unreachable.builds.length} image builds left`,
      ]),
];

const RECONNECT: Readonly<Record<BoatKeyHolder, string>> = {
  organization: "replace the organization's key with one whose Boat account can see them",
  person: "replace your key with one whose Boat account can see them",
  server: "give this server a key whose Boat account can see them",
};

/**
 * What the key's Boat account made before sealant recorded wallets and sealant now finds in no
 * wallet the key can bill, and what to do. sealant keeps it on record, never uses or removes it,
 * and waits on it for nothing.
 */
export const unreachableWords = (unreachable: BoatUnreachable, holder: BoatKeyHolder): string =>
  `sealant could not find ${list(unreachableThings(unreachable))} in any wallet this key can bill: they were made before sealant recorded wallets, and were since deleted in Boat or are in a Boat organization the key's account has left. sealant keeps them on record and never uses or removes them; while Boat still holds them they cost money or keep a saved snapshot slot. Remove them in Boat, or ${RECONNECT[holder]}.`;
