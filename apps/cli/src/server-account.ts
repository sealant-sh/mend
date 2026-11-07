import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { responseRefusal } from "./command-result.ts";
import { loginIdentity, type AccountReceipt } from "./login-json.ts";

export interface FirstAccountReceipt extends AccountReceipt {
  readonly signedIn: true;
  readonly webSetupUrl: string;
  readonly expiresAt: string;
}

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) throw new Error("Invalid setup response");
  return { ...value };
};

const text = (value: unknown): string => {
  if (typeof value !== "string" || value === "") throw new Error("Invalid setup response");
  return value;
};

export const createFirstAccount = async (input: {
  readonly url: string;
  readonly email: string;
  readonly name: string;
  readonly configDir: string;
  readonly timeoutMs: number;
}): Promise<FirstAccountReceipt | null> => {
  const signal = AbortSignal.timeout(input.timeoutMs);
  const instance = await fetch(`${input.url}/api/instance`, { signal });
  if (!instance.ok) throw await responseRefusal(instance, "GET /instance");
  if (object(await instance.json())["users"] !== "none") return null;
  const post = async (route: string, body: unknown, token?: string) => {
    const response = await fetch(`${input.url}/api${route}`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await responseRefusal(response, `POST ${route}`);
    return object(await response.json());
  };
  // The password is never returned, logged or persisted. The person sets theirs through recovery.
  const registered = await post("/auth/sign-up/email", {
    email: input.email,
    name: input.name,
    password: randomBytes(48).toString("base64url"),
  });
  const session = text(registered["token"]);
  const user = object(registered["user"]);
  const account = { id: text(user["id"]), email: text(user["email"]), name: text(user["name"]) };
  const organization = await loginIdentity(input.url, session, signal);
  const device = await post("/me/devices", { name: os.hostname(), platform: "other" }, session);
  const token = text(device["token"]);
  const deviceId = text(object(device["device"])["id"]);
  fs.mkdirSync(input.configDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(input.configDir, "cli.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ url: input.url, token, deviceId }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(configPath, 0o600);
  const reset = await post("/operator/password-resets", { email: input.email }, token);
  const resetPath = text(reset["path"]);
  if (!resetPath.startsWith("/reset#")) throw new Error("Invalid recovery path");
  return {
    account,
    organization,
    signedIn: true,
    webSetupUrl: `${input.url}${resetPath}`,
    expiresAt: text(reset["expiresAt"]),
  };
};
