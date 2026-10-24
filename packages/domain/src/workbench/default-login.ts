import type { CredentialProvider } from "./connected-credential.ts";

/** The fields of a connected account this choice reads, whichever surface decoded it. */
export interface ProviderAccount {
  readonly provider: string;
  readonly isDefault: boolean;
  readonly status: string;
}

export type LoginChoice<A extends ProviderAccount> =
  | { readonly _tag: "chosen"; readonly account: A }
  /** Accounts for the provider exist, and none is the default: sessions have no login to use. */
  | { readonly _tag: "unchosen"; readonly accounts: readonly [A, ...Array<A>] }
  | { readonly _tag: "none" };

/**
 * Which of a person's connected accounts their sessions use for one provider: the one Core marks
 * as the person's chosen default (`isDefault`), never one picked by name or by list order.
 */
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

const PROVIDER_LABELS: Readonly<Record<CredentialProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
  github: "GitHub",
};

export const noLoginChosenWords = (provider: CredentialProvider): string =>
  `No ${PROVIDER_LABELS[provider]} login chosen`;
