import { Brand } from "effect";

import { sha256Hex } from "@/lib/sha256";

export type PairingKey = Brand.Branded<string, "PairingKey">;
const PairingKey = Brand.nominal<PairingKey>();

export const serverUrlOf = (typed: string): string => typed.trim().replace(/\/+$/, "");

export const pairingKeyOf = (connection: {
  readonly url: string;
  readonly token: string;
}): PairingKey =>
  PairingKey(sha256Hex(`${serverUrlOf(connection.url)}\n${connection.token.trim()}`));
