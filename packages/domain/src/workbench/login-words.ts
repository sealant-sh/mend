import { Schema } from "effect";

import type { CredentialProvider } from "./connected-credential.ts";
import { CREDENTIAL_PROVIDER_LABELS } from "./default-login.ts";

/** Which kind of login a turn, a session or an account spends (ADR 0018). */
export const LoginClass = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("subscription") }),
  Schema.Struct({
    kind: Schema.Literal("api-key"),
    suffix: Schema.String,
    endpointHost: Schema.optionalKey(Schema.String),
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
