import { vi } from "vitest";

type Implementation = (...args: ReadonlyArray<unknown>) => unknown;

/**
 * Start's compiler keeps one side of `createIsomorphicFn` in each bundle. Tests run the source
 * without it, so pick the side the way the bundles do: the browser's in a test with a window,
 * the server's without one.
 */
vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  createIsomorphicFn: () => {
    const sides: { server?: Implementation; client?: Implementation } = {};
    const run = (...args: ReadonlyArray<unknown>) =>
      (typeof window === "undefined" ? sides.server : sides.client)?.(...args);
    const fn = Object.assign(run, {
      server: (implementation: Implementation) => {
        sides.server = implementation;
        return fn;
      },
      client: (implementation: Implementation) => {
        sides.client = implementation;
        return fn;
      },
    });
    return fn;
  },
}));
