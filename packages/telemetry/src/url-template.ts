/**
 * A request's path as a trace names it (SLNT-1375): each ID in it named for what it is, so
 * `GET /v1/sessions/sess_dce91a8f/output` reads `GET /v1/sessions/:sessionId/output` wherever the
 * call came from. No dependencies: the browser's Sentry client uses it too.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `sess_dce1…`, `ws_01J9…`, `run_…`: an ID with its type in front. */
const PREFIXED_ID = /^[a-z]{1,12}_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}$/;
const NUMBER = /^\d+$/;
const HEX = /^[0-9a-f]{12,}$/i;
/** A ULID, a nanoid, a random token: long, and with a digit in it. */
const OPAQUE = /^(?=[^/]*\d)[A-Za-z0-9_-]{16,}$/;

const isIdSegment = (segment: string): boolean =>
  UUID.test(segment) ||
  PREFIXED_ID.test(segment) ||
  NUMBER.test(segment) ||
  HEX.test(segment) ||
  OPAQUE.test(segment) ||
  segment.includes("%") ||
  segment.includes("@");

/** `sessions` → `sessionId`, `harness-layouts` → `harnessLayoutId`; else `id`. */
const parameterFor = (previous: string | undefined): string => {
  if (previous === undefined || previous.startsWith(":") || !/^[a-z][a-z-_]*$/i.test(previous))
    return "id";
  const words = previous.split(/[-_]/).filter((word) => word !== "");
  const last = words.at(-1) ?? "";
  const singular = last.endsWith("ies")
    ? `${last.slice(0, -3)}y`
    : /(?:sses|xes|ches|shes)$/.test(last)
      ? last.slice(0, -2)
      : /[^s]s$/.test(last)
        ? last.slice(0, -1)
        : last;
  const camel = [...words.slice(0, -1), singular]
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`,
    )
    .join("");
  return `${camel}Id`;
};

/** A request path with each ID in it named for what it is: `/v1/sessions/:sessionId/output`. */
export const templatePath = (path: string): string => {
  const segments = path.split("/");
  const templated: Array<string> = [];
  for (const segment of segments) {
    templated.push(
      segment !== "" && isIdSegment(segment) ? `:${parameterFor(templated.at(-1))}` : segment,
    );
  }
  const joined = templated.join("/");
  return joined === "" ? "/" : joined;
};

/** The path of `url`, absolute or not, without its query or fragment. */
export const pathOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith("/") ? (url.split(/[?#]/)[0] ?? url) : undefined;
  }
};
