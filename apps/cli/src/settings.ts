import { MessageSettings } from "@mend/domain/workbench";
import { Schema } from "effect";

import { usageOf } from "./help.ts";
import { MendRequestError } from "./server-request.ts";
import { isFlag, jsonWithoutCredentials, redactCredentials } from "./shared.ts";

const ROUTE = "/me/message-settings";
const SEND_STEERS = "send-steers";
const SEND_STEERS_LABEL = "Send steers the running turn";

type Switch = "on" | "off";

type SettingsRequest =
  | { readonly _tag: "List" }
  | { readonly _tag: "Show" }
  | { readonly _tag: "Set"; readonly value: Switch }
  | { readonly _tag: "Invalid"; readonly message: string };

const requestOf = (words: ReadonlyArray<string>): SettingsRequest => {
  const [name, value, ...extra] = words;
  if (words.some(isFlag) || extra.length > 0)
    return { _tag: "Invalid", message: usageOf("settings") };
  if (name === undefined) return { _tag: "List" };
  if (name !== SEND_STEERS)
    return { _tag: "Invalid", message: `unknown setting · ${usageOf("settings")}` };
  if (value === undefined) return { _tag: "Show" };
  if (value === "on" || value === "off") return { _tag: "Set", value };
  return { _tag: "Invalid", message: `${SEND_STEERS} takes on or off · ${usageOf("settings")}` };
};

const parseSettingsArgs = (
  args: ReadonlyArray<string>,
): { readonly asked: SettingsRequest; readonly json: boolean } => ({
  asked: requestOf(args.filter((word) => word !== "--json")),
  json: args.includes("--json"),
});

const switchOf = (settings: MessageSettings): Switch =>
  settings.sendSteersRunningTurn ? "on" : "off";

const settingOf = (settings: MessageSettings) => ({
  name: SEND_STEERS,
  value: switchOf(settings),
  label: SEND_STEERS_LABEL,
});

/** Why a call failed, for code that branches on it: the server's tag when it sent one. */
const tagOf = (error: unknown): string => {
  if (!(error instanceof MendRequestError)) return "SettingsUnreadable";
  if (error.refused?.tag) return error.refused.tag;
  if (error.status === 401) return "Unauthorized";
  return error.kind === "http" ? "SettingsRefused" : "SettingsNoAnswer";
};

export interface SettingsServer {
  readonly get: (route: string) => Promise<unknown>;
  readonly put: (
    route: string,
    body: { readonly sendSteersRunningTurn: boolean },
  ) => Promise<unknown>;
}

export interface SettingsBoundary {
  /** The server the CLI's config names; throws when the config cannot be read. */
  readonly connect: () => SettingsServer;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** `mend settings [send-steers [on|off]] [--json]`: show or set the person's own settings. */
export const settingsCommand = async (
  args: ReadonlyArray<string>,
  boundary: SettingsBoundary,
): Promise<0 | 1> => {
  const { asked, json } = parseSettingsArgs(args);
  const fail = (tag: string, message: string): 1 => {
    if (json)
      boundary.stdout(`${jsonWithoutCredentials({ version: 1, error: { tag, message } })}\n`);
    else boundary.stderr(`mend: ${redactCredentials(message)}\n`);
    return 1;
  };
  if (asked._tag === "Invalid") return fail("InvalidSettingsArguments", asked.message);
  let server: SettingsServer;
  try {
    server = boundary.connect();
  } catch (error) {
    return fail("CliConfigUnreadable", error instanceof Error ? error.message : String(error));
  }
  let raw: unknown;
  try {
    raw =
      asked._tag === "Set"
        ? await server.put(ROUTE, { sendSteersRunningTurn: asked.value === "on" })
        : await server.get(ROUTE);
  } catch (error) {
    return fail(tagOf(error), error instanceof Error ? error.message : String(error));
  }
  const decoded = Schema.decodeUnknownResult(MessageSettings)(raw);
  if (decoded._tag === "Failure")
    return fail("SettingsUnreadable", "this CLI could not read the server's settings");
  const settings = decoded.success;
  if (json)
    boundary.stdout(
      `${jsonWithoutCredentials(
        asked._tag === "List"
          ? { version: 1, settings: [settingOf(settings)] }
          : { version: 1, setting: settingOf(settings) },
      )}\n`,
    );
  else
    boundary.stdout(
      asked._tag === "List"
        ? `${SEND_STEERS}   ${switchOf(settings).padEnd(5)}${SEND_STEERS_LABEL}\n`
        : `${switchOf(settings)}\n`,
    );
  return 0;
};
