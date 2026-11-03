import { TRPCClientError } from "@trpc/client";

/**
 * The contract tag the web tier put beside a refusal's words (`data.tag`, server/routers/trpc.ts),
 * for a page that branches on which refusal it was. Null for a transport failure or anything that
 * did not come from the API. Never shown: the message is already in words.
 */
export const refusalTagOf = (cause: unknown): string | null => {
  if (!(cause instanceof TRPCClientError)) return null;
  const data: unknown = cause.data;
  return typeof data === "object" && data !== null && "tag" in data && typeof data.tag === "string"
    ? data.tag
    : null;
};

/** A failure as a person reads it: its words, or `fallback` when it has none. */
export const failureWords = (cause: unknown, fallback: string): string => {
  const raw = (
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : ""
  ).trim();
  return raw === "" ? fallback : raw;
};
