import { HANDED_LINK_PAGE_PATHS } from "./handed-links.ts";

/**
 * Paths whose next segment is a secret: the link pages in the path form issued before 0.37, a
 * CLI sign-in's user code, a released phone's push token, and Better Auth's reset link. The edge
 * redacts that segment in its log, and an API route may name a secret in its path only there.
 */
export const SECRET_SEGMENT_PREFIXES: ReadonlyArray<string> = [
  ...HANDED_LINK_PAGE_PATHS,
  "/api/me/cli-auth",
  "/api/devices",
  "/api/auth/reset-password",
];
