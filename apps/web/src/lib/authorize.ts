import type { CliAuthClient } from "@mend/api-contracts";
import { TRPCClientError } from "@trpc/client";

/**
 * The pure parts of the authorize page (`routes/authorize.tsx`): `mend login`, the desktop app and
 * VS Code open an authorize request and send the person to `/authorize?code=<code>`, where the
 * signed-in account approves or denies it. Kept free of React so each is a plain function to test.
 */

/** The account that is signed in in this browser, the one that approves. */
export interface Account {
  readonly name: string;
  readonly email: string;
}

/** One request as the page reads it (the API's `CliAuthRequestView`). */
export interface AuthorizeRequest {
  readonly code: string;
  /** What the client calls the machine: the CLI sends its host name. */
  readonly name: string;
  /** Null or absent from a client that doesn't say which it is. */
  readonly client?: CliAuthClient | null | undefined;
  readonly expiresAt: string;
  /** Seconds left by the server's clock when it answered; absent from an older server. */
  readonly expiresIn?: number | undefined;
}

/**
 * What the page shows once it has read the browser's session and the request: the request, a code
 * that can't be used (expired, decided, unknown or missing), sign-in first, or a server that didn't
 * answer.
 */
export type AuthorizeState =
  | {
      readonly kind: "request";
      readonly account: Account;
      readonly request: AuthorizeRequest;
      /** When the server answered, by this browser's clock: `expiresIn` counts from here. */
      readonly answeredAt: number;
    }
  | { readonly kind: "unusable" }
  | { readonly kind: "sign-in" }
  | { readonly kind: "unreachable" };

/** What a failed lookup, approve or deny means for the page. */
export type Failure = "unusable" | "sign-in" | "unreachable";

/**
 * The API answers 404 for a code it never made and 410 for one that is spent (expired, decided or
 * collected); the tRPC bridge passes those on as NOT_FOUND and BAD_REQUEST. A 401 means the session
 * ended. Anything else, a network failure included, is the server not answering: it says nothing
 * about the code.
 */
export const failureOf = (error: unknown): Failure => {
  if (!(error instanceof TRPCClientError)) return "unreachable";
  const code: unknown = error.data?.code;
  if (code === "NOT_FOUND" || code === "BAD_REQUEST") return "unusable";
  if (code === "UNAUTHORIZED") return "sign-in";
  return "unreachable";
};

/**
 * Reads the page's state: no code is unusable at once; then who is signed in (a session read that
 * fails is the server not answering), then the request itself.
 */
export const readAuthorize = async (
  code: string,
  read: {
    /** The browser's session: the account, or null when nobody is signed in. Throws when it can't tell. */
    readonly account: () => Promise<Account | null>;
    readonly request: (code: string) => Promise<AuthorizeRequest>;
    readonly now: () => number;
  },
): Promise<AuthorizeState> => {
  if (code.trim() === "") return { kind: "unusable" };
  let account: Account | null;
  try {
    account = await read.account();
  } catch {
    return { kind: "unreachable" };
  }
  if (account === null) return { kind: "sign-in" };
  try {
    const request = await read.request(code);
    return { kind: "request", account, request, answeredAt: read.now() };
  } catch (error) {
    return { kind: failureOf(error) };
  }
};

/** "ABCDEFGH" → "ABCD-EFGH", whether it arrived grouped, bare or typed in lower case. */
export const groupCode = (code: string): string => {
  const bare = code.replace(/[^0-9a-z]/gi, "").toUpperCase();
  return bare.length <= 4 ? bare : `${bare.slice(0, 4)}-${bare.slice(4)}`;
};

/**
 * When the request runs out, in words. Counted from when the server answered, by its `expiresIn`,
 * so a browser whose clock disagrees with the server's still reads it right; an older server sends
 * only `expiresAt`, read against this clock. Whole minutes left, rounded down.
 */
export const expiryWords = (
  request: Pick<AuthorizeRequest, "expiresAt" | "expiresIn">,
  answeredAt: number,
  now: number,
): string => {
  const leftMs =
    request.expiresIn === undefined
      ? Date.parse(request.expiresAt) - now
      : request.expiresIn * 1000 - (now - answeredAt);
  const minutes = Math.floor(Math.max(0, leftMs) / 60_000);
  if (minutes === 0) return "It expires in less than a minute.";
  return minutes === 1 ? "It expires in 1 minute." : `It expires in ${minutes} minutes.`;
};

/** Which client asked, as the page names it. A client that doesn't say is `other`. */
export type Asker = "terminal" | "vscode" | "app" | "other";

export const askerOf = (client: CliAuthClient | null | undefined): Asker => {
  switch (client) {
    case "cli":
      return "terminal";
    case "vscode":
      return "vscode";
    case "desktop":
      return "app";
    case null:
    case undefined:
      return "other";
  }
};
