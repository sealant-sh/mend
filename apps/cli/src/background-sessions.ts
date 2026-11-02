import { MendRequestError } from "./server-request.ts";

/** A GET the CLI makes of its server; it throws as `request` does. */
export type ReadRoute = (route: string) => Promise<unknown>;

const backgroundOf = (value: unknown, path: ReadonlyArray<string>): boolean => {
  let at: unknown = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return true;
    at = Reflect.get(at, key);
  }
  return at !== false;
};

/** The server answered that it has no such route: a server from before the setting existed. */
const unsupported = (error: unknown): boolean =>
  error instanceof MendRequestError && error.kind === "http" && error.status === 404;

/**
 * Cascade for the launch lifecycle: per-launch flag → project stance → the person's own setting →
 * the organization's default → the instance's. The server resolves the last three
 * (`/me/automation`). Only a server that does not know that route (404) is asked the older
 * questions: the organization's defaults, else the instance's. Any other failure (a blip) stays
 * background, and `say` tells the person their own setting was not read: a network hiccup must
 * never flip launch semantics to foreground.
 */
export const resolveBackgroundSessions = async (
  stance: "inherit" | "on" | "off" | undefined,
  read: ReadRoute,
  say: (line: string) => void,
): Promise<boolean> => {
  if (stance === "on") return true;
  if (stance === "off") return false;
  try {
    return backgroundOf(await read("/me/automation"), ["effective", "backgroundSessions"]);
  } catch (error) {
    if (!unsupported(error)) {
      say("your background-sessions setting could not be read · running in the background");
      return true;
    }
  }
  try {
    return backgroundOf(await read("/organization/settings"), ["effective", "backgroundSessions"]);
  } catch {
    try {
      return backgroundOf(await read("/settings"), ["backgroundSessions"]);
    } catch {
      return true;
    }
  }
};
