import {
  ACCESS_KEY_EXPIRY_DAYS_MAX,
  ACCESS_KEY_NAME_MAX,
  AccessKeyView,
  CreatedAccessKey,
} from "@mend/api-contracts";
import { Schema } from "effect";

import { usageOf } from "./help.ts";
import type { ApiCall } from "./pair.ts";
import { MendRequestError } from "./server-request.ts";
import { isFlag, jsonWithoutCredentials, redactCredentials } from "./shared.ts";

/**
 * `mend access-keys`: the person's access keys (docs/adr/0023-access-keys.md), for their own
 * automation to call Mend's API as them. The server refuses all of this to a CLI that is itself
 * running on an access key (`AccessKeyRefused`); the command prints its words and exits 1.
 */

const ROUTE = "/me/access-keys";
const DEFAULT_EXPIRY_DAYS = 90;

type AccessKeysRequest =
  | { readonly _tag: "List" }
  | { readonly _tag: "Create"; readonly name: string; readonly expiresInDays: number | null }
  | { readonly _tag: "Revoke"; readonly id: string }
  | { readonly _tag: "Invalid"; readonly message: string };

/** `30d`, `1y` or `never` as the days the server is asked for; null when it is none of them. */
export const parseExpiry = (value: string): { readonly days: number | null } | null => {
  if (value === "never") return { days: null };
  if (value === "1y") return { days: 365 };
  const match = /^(\d+)d$/.exec(value);
  const days = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
  return days >= 1 && days <= ACCESS_KEY_EXPIRY_DAYS_MAX ? { days } : null;
};

const requestOf = (args: ReadonlyArray<string>): AccessKeysRequest => {
  const words: Array<string> = [];
  let expires: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--expires") {
      const next = args[index + 1];
      if (next === undefined || isFlag(next))
        return {
          _tag: "Invalid",
          message: `--expires needs a value · ${usageOf("access-keys create")}`,
        };
      expires = next;
      index += 1;
    } else if (!isFlag(arg)) words.push(arg);
  }
  const [verb, subject, ...extra] = words;
  switch (verb) {
    case undefined:
    case "list":
      return subject === undefined && expires === null
        ? { _tag: "List" }
        : { _tag: "Invalid", message: usageOf("access-keys list") };
    case "create": {
      const name = subject?.trim() ?? "";
      if (name === "" || extra.length > 0)
        return { _tag: "Invalid", message: usageOf("access-keys create") };
      if (name.length > ACCESS_KEY_NAME_MAX)
        return {
          _tag: "Invalid",
          message: `a name is at most ${ACCESS_KEY_NAME_MAX} characters · ${usageOf("access-keys create")}`,
        };
      const expiry = expires === null ? { days: DEFAULT_EXPIRY_DAYS } : parseExpiry(expires);
      if (expiry === null)
        return {
          _tag: "Invalid",
          message: `--expires takes 30d, 90d, 1y, never or 1d to ${ACCESS_KEY_EXPIRY_DAYS_MAX}d, not "${expires}"`,
        };
      return { _tag: "Create", name, expiresInDays: expiry.days };
    }
    case "revoke":
      return subject === undefined || extra.length > 0 || expires !== null
        ? { _tag: "Invalid", message: usageOf("access-keys revoke") }
        : { _tag: "Revoke", id: subject };
    default:
      return { _tag: "Invalid", message: `unknown subcommand ${verb} · mend help access-keys` };
  }
};

const day = (iso: string): string => iso.slice(0, 10);

const expiryWords = (expiresAt: string | null, now: number): string => {
  if (expiresAt === null) return "no expiry";
  return Date.parse(expiresAt) <= now ? "expired" : day(expiresAt);
};

export const renderAccessKeys = (
  keys: ReadonlyArray<AccessKeyView>,
  now: number,
): ReadonlyArray<string> => {
  if (keys.length === 0) return ["no access keys · create one with mend access-keys create <name>"];
  const rows = [
    ["ID", "NAME", "CREATED", "LAST USED", "EXPIRES"],
    ...keys.map((key) => [
      key.id,
      key.name,
      day(key.createdAt),
      key.lastUsedAt === null ? "never" : day(key.lastUsedAt),
      expiryWords(key.expiresAt, now),
    ]),
  ];
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
      )
      .join("  "),
  );
};

export const renderCreated = (
  created: CreatedAccessKey,
  serverUrl: string,
): ReadonlyArray<string> => [
  `✓ created access key ${created.key.name} (${created.key.id}) · ${
    created.key.expiresAt === null ? "no expiry" : `expires ${day(created.key.expiresAt)}`
  }`,
  "",
  created.secret,
  "",
  "Mend keeps only its hash, so this is the only time the key is shown.",
  "Send it as a header, Authorization: Bearer <key>, for example:",
  `  curl -H "Authorization: Bearer $MEND_ACCESS_KEY" ${serverUrl.replace(/\/+$/, "")}/api/projects`,
];

const tagOf = (error: unknown): string => {
  if (!(error instanceof MendRequestError)) return "AccessKeysUnreadable";
  if (error.refused?.tag) return error.refused.tag;
  if (error.status === 401) return "Unauthorized";
  return error.kind === "http" ? "AccessKeysRefused" : "AccessKeysNoAnswer";
};

export interface AccessKeysBoundary {
  /** The server the CLI's config names; throws when the config cannot be read. */
  readonly connect: () => { readonly url: string; readonly api: ApiCall };
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now: () => number;
}

/** `mend access-keys [list|create <name>|revoke <id>] [--json]`. Exit 1 on any failure. */
export const accessKeysCommand = async (
  args: ReadonlyArray<string>,
  boundary: AccessKeysBoundary,
): Promise<0 | 1> => {
  const json = args.includes("--json");
  const asked = requestOf(args);
  const fail = (tag: string, message: string): 1 => {
    if (json)
      boundary.stdout(`${jsonWithoutCredentials({ version: 1, error: { tag, message } })}\n`);
    else boundary.stderr(`mend: ${redactCredentials(message)}\n`);
    return 1;
  };
  const print = (lines: ReadonlyArray<string>) =>
    boundary.stdout(lines.map((line) => `${redactCredentials(line)}\n`).join(""));
  if (asked._tag === "Invalid") return fail("InvalidAccessKeysArguments", asked.message);
  let server: { readonly url: string; readonly api: ApiCall };
  try {
    server = boundary.connect();
  } catch (error) {
    return fail("CliConfigUnreadable", error instanceof Error ? error.message : String(error));
  }
  const call = async <A>(
    schema: Schema.Decoder<A>,
    method: "GET" | "POST" | "DELETE",
    route: string,
    body?: unknown,
  ): Promise<{ readonly ok: A } | { readonly failed: 1 }> => {
    let raw: unknown;
    try {
      raw = await server.api<unknown>(method, route, body);
    } catch (error) {
      return { failed: fail(tagOf(error), error instanceof Error ? error.message : String(error)) };
    }
    const decoded = Schema.decodeUnknownResult(schema)(raw);
    return decoded._tag === "Failure"
      ? { failed: fail("AccessKeysUnreadable", "this CLI could not read the server's answer") }
      : { ok: decoded.success };
  };
  switch (asked._tag) {
    case "List": {
      const answer = await call(Schema.Array(AccessKeyView), "GET", ROUTE);
      if ("failed" in answer) return answer.failed;
      if (json) boundary.stdout(`${jsonWithoutCredentials({ version: 1, keys: answer.ok })}\n`);
      else print(renderAccessKeys(answer.ok, boundary.now()));
      return 0;
    }
    case "Create": {
      const answer = await call(CreatedAccessKey, "POST", ROUTE, {
        name: asked.name,
        expiresInDays: asked.expiresInDays,
      });
      if ("failed" in answer) return answer.failed;
      if (json)
        boundary.stdout(
          `${jsonWithoutCredentials({ version: 1, key: answer.ok.key, secret: answer.ok.secret })}\n`,
        );
      else print(renderCreated(answer.ok, server.url));
      return 0;
    }
    case "Revoke": {
      const answer = await call(
        AccessKeyView,
        "DELETE",
        `${ROUTE}/${encodeURIComponent(asked.id)}`,
      );
      if ("failed" in answer) return answer.failed;
      if (json) boundary.stdout(`${jsonWithoutCredentials({ version: 1, key: answer.ok })}\n`);
      else
        print([
          `✓ revoked access key ${answer.ok.name} (${answer.ok.id}) · the next request with it is refused`,
        ]);
      return 0;
    }
  }
};
