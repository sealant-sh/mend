import { cleanStores } from "nanostores";
import { afterAll } from "vitest";

/**
 * The auth client's session store and the tab's event stream let go of the window a second after
 * their last subscriber leaves (nanostores' unmount delay, `LINGER_MS`). A test file usually ends
 * sooner, and Vitest removes jsdom's globals before the worker exits, so a late release would throw
 * `window is not defined` into the run. Release both while the window is still there.
 */
afterAll(async () => {
  if (typeof window === "undefined") return;
  const [{ authClient }, { closeTabStream }] = await Promise.all([
    import("#/lib/auth-client"),
    import("#/lib/workbench-events"),
  ]);
  cleanStores(authClient.$store.atoms.session);
  closeTabStream();
});
