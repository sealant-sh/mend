import type { MendConnection } from "./config.js";
import { MendApiError, requestMend } from "./mend-http.js";
import type { SessionProcess } from "./types.js";

/**
 * The terminal data plane's addressing and frames (apps/api/src/routes/tty.ts), kept apart from the
 * VS Code terminal that uses them.
 */

/** What the terminal attaches to: one process's PTY, or the session's current agent. */
export type TtyAddress = { readonly process: string } | { readonly session: string };

/** Processes with a PTY of Mend's: an agent in a terminal, or a shell. */
const PTY_KINDS: ReadonlySet<string> = new Set(["agent-pty", "shell"]);

const LIVE: ReadonlySet<string> = new Set(["starting", "running"]);

/** The live processes a terminal can attach to, newest first. */
export const attachableProcesses = (
  processes: ReadonlyArray<SessionProcess>,
): ReadonlyArray<SessionProcess> =>
  processes
    .filter(
      (process) =>
        PTY_KINDS.has(process.kind) && process.exitedAt === null && LIVE.has(process.status),
    )
    .toReversed();

/** The `ws:`/`wss:` URL of the terminal, with its addressing and replay point, without a credential. */
export const ttyUrl = (serverUrl: string, address: TtyAddress, ticket: string): URL => {
  const url = new URL(`${serverUrl.replace(/\/$/, "")}/api/tty`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if ("process" in address) url.searchParams.set("process", address.process);
  else url.searchParams.set("session", address.session);
  url.searchParams.set("from", "0");
  url.searchParams.set("ticket", ticket);
  return url;
};

/** `POST /api/upgrade-tickets` for this terminal. A server before tickets is refused, never sent the token. */
export const mintTtyTicket = async (
  connection: MendConnection,
  address: TtyAddress,
): Promise<string> => {
  const minted = await requestMend(connection, "/upgrade-tickets", {
    method: "POST",
    body: JSON.stringify({ target: "tty", ...address }),
  }).catch((error: unknown) => {
    if (error instanceof MendApiError && error.status === 404) {
      throw new MendApiError(
        "This Mend server does not issue terminal tickets. Upgrade it to open terminals here.",
        404,
      );
    }
    throw error;
  });
  const ticket =
    typeof minted === "object" && minted !== null ? Reflect.get(minted, "ticket") : undefined;
  if (typeof ticket !== "string") throw new Error("Mend answered the ticket without one.");
  return ticket;
};

/** One text control frame from the server; anything else is ignored. */
export const isEndFrame = (data: string): boolean => {
  try {
    const frame: unknown = JSON.parse(data);
    return typeof frame === "object" && frame !== null && Reflect.get(frame, "t") === "end";
  } catch {
    return false;
  }
};

export const resizeFrame = (columns: number, rows: number): string =>
  JSON.stringify({ t: "resize", cols: columns, rows });
