import { Schema } from "effect";

import type { CredentialProvider } from "./connected-credential.ts";
import { CREDENTIAL_PROVIDER_LABELS } from "./default-login.ts";

/** Which kind of login a turn, a session or an account spends (ADR 0018). */
export const LoginClass = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("subscription") }),
  Schema.Struct({
    kind: Schema.Literal("api-key"),
    suffix: Schema.String,
    endpointHost: Schema.optional(Schema.String),
  }),
]);
export type LoginClass = typeof LoginClass.Type;

/**
 * Whether the person reading the words added this login. An endpoint's host is shown only to them
 * (ADR 0018 decision 11).
 */
export type LoginReader = "added-it" | "someone-else";

export const loginWords = (
  provider: CredentialProvider,
  login: LoginClass,
  reader: LoginReader,
): string => {
  const label = CREDENTIAL_PROVIDER_LABELS[provider];
  if (login.kind === "subscription") return `${label} · subscription`;
  const key = `${label} · API key ····${login.suffix} · billed per token`;
  return login.endpointHost === undefined || reader === "someone-else"
    ? key
    : `${key} · endpoint ${login.endpointHost}`;
};

/** The providers a person can connect an API key for. */
export type KeyProvider = "claude" | "codex";

/** Who issues and bills a provider's keys, and where a person caps or revokes one. */
const KEY_ISSUERS: Readonly<
  Record<KeyProvider, { readonly name: string; readonly console: string; readonly cap: string }>
> = {
  claude: {
    name: "Anthropic",
    console: "the Anthropic Console",
    cap: "Set a spend limit on the key's workspace in the Anthropic Console",
  },
  codex: {
    name: "OpenAI",
    console: "the OpenAI platform",
    cap: "Set a budget on the key's project in the OpenAI platform",
  },
};

/** The recommendation every key form carries (spec risk 2): a key has no plan limit. */
export const keySpendWords = (provider: KeyProvider): string =>
  `A key is billed per token and has no plan limit. ${KEY_ISSUERS[provider].cap}.`;

/** What disconnecting a key does not do (spec risk 1): Mend cannot revoke it. */
export const keyDisconnectWords = (provider: KeyProvider): string =>
  `The key stays valid at ${KEY_ISSUERS[provider].name} until you revoke it in ${KEY_ISSUERS[provider].console}.`;

/** A key the provider answered with a 401, as observed (ADR 0018 decision 7). */
export const keyRefusedWords = (provider: KeyProvider): string =>
  `refused by ${KEY_ISSUERS[provider].name}`;

/** What a key form's optional endpoint is for (ADR 0018, decision 11). */
export const keyEndpointWords = (provider: KeyProvider): string =>
  `Send this login's requests to a compatible endpoint, such as a company gateway. Leave it empty for ${KEY_ISSUERS[provider].name}'s API.`;

/** The key field's words once an endpoint is filled in: any value without spaces is accepted. */
export const ENDPOINT_KEY_WORDS = "If the endpoint takes no key, enter any value.";
