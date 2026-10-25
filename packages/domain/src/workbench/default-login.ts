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

const PROVIDER_LABELS: Readonly<Record<CredentialProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
  github: "GitHub",
};

/** What every surface says about a person who holds accounts for a provider and chose none. */
export interface UnchosenLoginSummary {
  readonly words: string;
  readonly count: number;
  /** The words, with what sessions do about it. */
  readonly reason: string;
  readonly remedy: string;
  /** The remedy's first command. */
  readonly command: string;
}

/** `count`: how many accounts of the provider the person holds, none of them chosen. */
export const unchosenLoginSummary = (
  provider: CredentialProvider,
  count: number,
): UnchosenLoginSummary => {
  const label = PROVIDER_LABELS[provider];
  const words = `No ${label} login chosen`;
  const reason = `${words}: Mend holds ${count} of yours, and sessions use only the chosen one.`;
  if (count === 1) {
    const command = `mend connect ${provider}`;
    return {
      words,
      count,
      reason,
      command,
      remedy: `Connect ${label} again to choose it: run ${command}, or Connect in Settings → Connected accounts.`,
    };
  }
  const command = `mend connect ${provider} --remove <name>`;
  return {
    words,
    count,
    reason,
    command,
    remedy: `Remove the others with ${command}, or Disconnect them in Settings → Connected accounts, then connect the one left again to choose it.`,
  };
};
