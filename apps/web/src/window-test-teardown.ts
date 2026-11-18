import { cleanStores } from "nanostores";
import { afterAll } from "vitest";

/**
 * The auth client's session store lets go of the window a second after its last subscriber leaves
 * (nanostores' unmount delay). A test file usually ends sooner, and Vitest removes jsdom's globals
 * before the worker exits, so a late release would throw `window is not defined` into the run.
 * Release it while the window is still there.
 */
afterAll(async () => {
  if (typeof window === "undefined") return;
  const { authClient } = await import("#/lib/auth-client");
  cleanStores(authClient.$store.atoms.session);
});
