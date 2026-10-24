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

const PROVIDER_LABELS: Readonly<Record<CredentialProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
  github: "GitHub",
};

export const noLoginChosenWords = (provider: CredentialProvider): string =>
  `No ${PROVIDER_LABELS[provider]} login chosen`;
