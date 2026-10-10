import { PublicOrigin } from "@mend/network";
import { Option, Schema } from "effect";

import { failureLogLine, failureWords } from "./failure-words";
import type { MendConfig } from "./live";
import type { PairPayload } from "./pairing-code";
import { CODE_LENGTH, normalizeBaseUrl, normalizeCode } from "./pairing-code";

/** The account that authorized this pairing. */
export interface PairedUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** A claim saves credentials only after the complete response is accepted. */
export type PairOutcome =
  | { readonly state: "paired"; readonly config: MendConfig; readonly user: PairedUser }
  | { readonly state: "refused"; readonly reason: string };

/** Device facts sent with a claim, supplied by the native entrypoint. */
export interface PairingDevice {
  readonly name: string;
  readonly platform: "ios" | "android" | "web" | "other";
}

/** The device's existing config persistence boundary. */
export interface PairingConfigStore {
  saveConfig(config: MendConfig): Promise<void>;
}

/** Claim a short-lived code and persist the server-selected connection. */
export interface PairingClient {
  claim(payload: PairPayload, device: PairingDevice): Promise<PairOutcome>;
}

const readString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

interface PairResponse {
  readonly url: PublicOrigin;
  readonly token: string;
  readonly deviceName: string | null;
  readonly user: PairedUser;
}

const parseOrigin = Schema.decodeUnknownOption(PublicOrigin);

const parsePairResponse = (value: unknown): PairResponse | null => {
  if (typeof value !== "object" || value === null) return null;
  const url = parseOrigin("url" in value ? value.url : undefined);
  if (Option.isNone(url)) return null;
  const token = "token" in value ? readString(value.token) : null;
  if (token === null) return null;
  const device = "device" in value && typeof value.device === "object" ? value.device : null;
  const deviceName = device !== null && "name" in device ? readString(device.name) : null;
  const user = "user" in value && typeof value.user === "object" ? value.user : null;
  if (user === null) return null;
  const id = "id" in user ? readString(user.id) : null;
  const name = "name" in user ? readString(user.name) : null;
  const email = "email" in user ? readString(user.email) : null;
  if (id === null) return null;
  return {
    url: url.value,
    token,
    deviceName,
    user: { id, name: name ?? "", email: email ?? "" },
  };
};

/** HTTP pairing without Expo imports; native storage is supplied at composition. */
export class HttpPairingClient implements PairingClient {
  /** Use the same store as the authenticated API client. */
  constructor(private readonly store: PairingConfigStore) {}

  /** The arrival URL is used only for the claim, never as the saved bearer destination. */
  async claim(payload: PairPayload, device: PairingDevice): Promise<PairOutcome> {
    const base = normalizeBaseUrl(payload.url);
    const code = normalizeCode(payload.code);
    if (base === "")
      return { state: "refused", reason: "enter the server URL shown on the machine" };
    if (code.length !== CODE_LENGTH) {
      return { state: "refused", reason: `the code is ${CODE_LENGTH} characters` };
    }
    let response: Response;
    try {
      response = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: device.name, platform: device.platform }),
      });
    } catch {
      return {
        state: "refused",
        reason: `${base} unreachable — check the URL, port, firewall, same network`,
      };
    }
    if (response.status === 404) {
      return { state: "refused", reason: "code not found — check it against the machine" };
    }
    if (response.status === 410) {
      return { state: "refused", reason: "code expired — generate a new one on the machine" };
    }
    if (response.status === 429) {
      return { state: "refused", reason: "too many attempts — wait a minute, then try again" };
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      console.warn(failureLogLine("POST /api/pair", response.status, body));
      return { state: "refused", reason: failureWords(response.status, body).words };
    }
    const body = parsePairResponse(await response.json().catch(() => null));
    if (body === null) return { state: "refused", reason: "server answered an unreadable body" };
    const config: MendConfig = {
      url: body.url,
      token: body.token,
      deviceName: body.deviceName ?? device.name,
      pairedAt: new Date().toISOString(),
    };
    await this.store.saveConfig(config);
    return { state: "paired", config, user: body.user };
  }
}
