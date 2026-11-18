import { queryOptions } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/react";

// Same origin, default base path /api/auth — the server entry mounts
// better-auth there, and the dev proxy keeps vite on the same origin.
export const authClient = createAuthClient();

/**
 * The signed-in account's name, from Better Auth's session (the setup steps show it under
 * Account). Empty when nobody is signed in; a session that can't be read is the page's error.
 */
export const accountNameOptions = () =>
  queryOptions({
    queryKey: ["auth", "account-name"],
    queryFn: async (): Promise<string> => {
      const session = await authClient.getSession();
      if (session.error !== null) {
        throw new Error(session.error.message ?? "Mend couldn't tell who is signed in.");
      }
      return session.data?.user.name ?? "";
    },
    staleTime: 60_000,
  });
