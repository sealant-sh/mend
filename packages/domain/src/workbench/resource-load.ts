import { Redacted, Schema } from "effect";

import { ResourceLoadId } from "../ids.ts";

/** A load replaces one database. Terminal phases release its exclusive target. */
export const ResourceLoadPhase = Schema.Literals([
  "receiving",
  "pulling",
  "restoring",
  "installing",
  "saving",
  "done",
  "failed",
]);
export type ResourceLoadPhase = typeof ResourceLoadPhase.Type;

/** Legal forward transitions; recovery also uses observations of the database names. */
export const loadCanAdvance = (from: ResourceLoadPhase, to: ResourceLoadPhase): boolean => {
  if (from === "done" || from === "failed") return false;
  if (to === "failed")
    return (
      from === "receiving" || from === "pulling" || from === "restoring" || from === "installing"
    );
  switch (from) {
    case "receiving":
    case "pulling":
      return to === "restoring";
    case "restoring":
      return to === "installing";
    case "installing":
      return to === "saving";
    case "saving":
      return to === "done";
  }
};
export const loadIsLive = (phase: ResourceLoadPhase): boolean =>
  phase !== "done" && phase !== "failed";

/** A source credential exists only in memory, and is unwrapped only at the dump process. */
export interface PullUrl {
  readonly connection: string;
  readonly password: Redacted.Redacted<string>;
  readonly label: string;
}

/** Reject libpq query credentials as well as multi-line passwords, which cannot use read -r. */
export const parsePullUrl = (
  raw: Redacted.Redacted<string>,
):
  | { readonly ok: true; readonly value: PullUrl }
  | { readonly ok: false; readonly message: string } => {
  try {
    const url = new URL(Redacted.value(raw));
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.hash) {
      return { ok: false, message: "use a postgres:// URL naming a host and database" };
    }
    for (const key of url.searchParams.keys()) {
      if (key !== "sslmode")
        return { ok: false, message: "only sslmode is accepted in a load URL's query" };
    }
    const password = decodeURIComponent(url.password);
    if (["\r", "\n", "\0"].some((char) => password.includes(char)))
      return { ok: false, message: "a load URL's password cannot contain a line break or NUL" };
    url.password = "";
    const connection = url.toString();
    if (
      password !== "" &&
      [password, encodeURIComponent(password)].some((secret) => connection.includes(secret))
    ) {
      return {
        ok: false,
        message: "the source address must not repeat its password outside the password field",
      };
    }
    const label = `${url.host}${url.pathname}`;
    return {
      ok: true,
      value: {
        connection,
        password: Redacted.make(password),
        label: scrubLoadMessage(label, password),
      },
    };
  } catch {
    return { ok: false, message: "use a postgres:// URL naming a host and database" };
  }
};

/** Scrubs a known credential, its URI encoding and URLs before any diagnostic leaves a process. */
export const scrubLoadMessage = (message: string, password = ""): string => {
  let safe = message;
  if (password !== "") {
    for (const secret of [password, encodeURIComponent(password)])
      safe = safe.split(secret).join("[redacted]");
  }
  return safe
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL]")
    .replace(/\p{Cc}/gu, " ");
};

/** Custom dumps start with PGDMP; everything else goes through psql. */
export const dumpFormat = (prefix: Uint8Array): "custom" | "plain" =>
  [80, 71, 68, 77, 80].every((byte, index) => prefix[index] === byte) ? "custom" : "plain";

export const ResourceLoadSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("upload"),
    label: Schema.String.check(Schema.isMaxLength(200)),
    bytesTotal: Schema.NullOr(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("pull"), url: Schema.RedactedFromValue(Schema.String) }),
]);
export type ResourceLoadSource = typeof ResourceLoadSource.Type;

/** No source URL or password is part of a persisted load or a response. */
export const ResourceLoadAnswer = Schema.Struct({
  id: ResourceLoadId,
  phase: ResourceLoadPhase,
  bytesDone: Schema.Number,
  bytesTotal: Schema.NullOr(Schema.Number),
  statusLine: Schema.String,
});
export type ResourceLoadAnswer = typeof ResourceLoadAnswer.Type;

/** Human byte counts without an invented percentage for an unknown total. */
export const loadBytes = (bytes: number): string => {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
};
