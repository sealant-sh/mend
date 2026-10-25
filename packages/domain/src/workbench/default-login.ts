import type { CredentialProvider } from "./connected-credential.ts";

export interface ProviderAccount {
  readonly provider: string;
  readonly isDefault: boolean;
  readonly status: string;
}

export type LoginChoice<A extends ProviderAccount> =
  | { readonly _tag: "chosen"; readonly account: A }
  | { readonly _tag: "unchosen"; readonly accounts: readonly [A, ...Array<A>] }
  | { readonly _tag: "none" };

export const loginChoiceOf = <A extends ProviderAccount>(
  accounts: ReadonlyArray<A>,
  provider: string,
): LoginChoice<A> => {
  const held = accounts.filter(
    (account) => account.provider === provider && account.status !== "archived",
  );
  const chosen = held.find((account) => account.isDefault);
  if (chosen !== undefined) return { _tag: "chosen", account: chosen };
  const [first, ...rest] = held;
  return first === undefined ? { _tag: "none" } : { _tag: "unchosen", accounts: [first, ...rest] };
};

/**
 * Whether an account is its person's chosen default, as a Mend server or Core that predates the
 * flag reports it: without `isDefault`, the default is the account named `default`.
 */
export const isChosenDefault = (account: {
  readonly name: string;
  readonly isDefault?: boolean | undefined;
}): boolean => account.isDefault ?? account.name === "default";

export const isCredentialProvider = (value: string): value is CredentialProvider =>
  value === "claude" || value === "codex" || value === "github";

export const CREDENTIAL_PROVIDER_LABELS: Readonly<Record<CredentialProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
  github: "GitHub",
};

export interface UnchosenLoginSummary {
  readonly words: string;
  readonly count: number;
  readonly wordsAndSessionUse: string;
  readonly remedy: string;
  readonly firstCommand: string;
}

export const unchosenLoginSummary = (
  provider: CredentialProvider,
  heldUnchosen: number,
): UnchosenLoginSummary => {
  const label = CREDENTIAL_PROVIDER_LABELS[provider];
  const words = `No ${label} login chosen`;
  const wordsAndSessionUse = `${words}: Mend holds ${heldUnchosen} of yours, and sessions use only the chosen one.`;
  if (heldUnchosen === 1) {
    const firstCommand = `mend connect ${provider}`;
    return {
      words,
      count: heldUnchosen,
      wordsAndSessionUse,
      firstCommand,
      remedy: `Connect ${label} again to choose it: run ${firstCommand}, or Connect in Settings → Connected accounts.`,
    };
  }
  const firstCommand = `mend connect ${provider} --remove <name>`;
  return {
    words,
    count: heldUnchosen,
    wordsAndSessionUse,
    firstCommand,
    remedy: `Remove the others with ${firstCommand}, or Disconnect them in Settings → Connected accounts, then connect the one left again to choose it.`,
  };
};
