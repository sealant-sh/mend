import { createAuthClient } from "better-auth/react";

// Same origin, default base path /api/auth — the server entry mounts
// better-auth there, and the dev proxy keeps vite on the same origin.
export const authClient = createAuthClient();
