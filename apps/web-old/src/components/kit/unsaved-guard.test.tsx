// @vitest-environment jsdom
import {
  Link,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SaveBar } from "./save-bar";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
};

/** What `find` answers once it answers anything, waiting up to 200 ticks of 10 ms. */
const appeared = async <A,>(find: () => A | undefined): Promise<A | undefined> => {
  for (let tick = 0; tick < 200 && find() === undefined; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return find();
};

/**
 * The guard's dialog once it shows. Its code loads the first time it opens (`ModalDialog`), so the
 * first test to open it waits for that import, however long a loaded machine takes.
 */
const openedDialog = () => appeared(() => document.querySelector('[role="dialog"]') ?? undefined);

/** A button in the dialog: the save bar has a Discard of its own. */
const button = (name: string) => {
  const found = [...document.querySelectorAll('[role="dialog"] button')].find(
    (element) => element.textContent?.trim() === name,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${name} in the dialog`);
  return found;
};

const link = () => {
  const found = document.querySelector<HTMLAnchorElement>('a[href="/settings/account"]');
  if (found === null) throw new Error("no link");
  return found;
};

/** Two pages: a form with an unsaved draft, and somewhere else to go. */
const world = async (dirty: boolean) => {
  const rootRoute = createRootRoute({ component: Outlet });
  const form = createRoute({
    getParentRoute: () => rootRoute,
    path: "/form",
    component: () => (
      <>
        <Link to="/settings/account">Members</Link>
        <SaveBar
          dirty={dirty}
          summary="1 unsaved change"
          saveLabel="Save workspace"
          pending={false}
          error={null}
          onDiscard={() => undefined}
          onSave={() => undefined}
        />
      </>
    ),
  });
  const elsewhere = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/account",
    component: () => <p>elsewhere</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([form, elsewhere]),
    history: createMemoryHistory({ initialEntries: ["/form"] }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<RouterProvider router={router} />));
  await settle();
  return router;
};

describe("leaving a settings form with an unsaved draft", () => {
  it("asks first; Keep editing stays on the form", async () => {
    const router = await world(true);
    await act(async () => link().click());
    expect((await openedDialog())?.textContent).toContain(
      "1 unsaved change. Leaving drops the draft.",
    );
    await act(async () => button("Keep editing").click());
    await settle();
    expect(router.state.location.pathname).toBe("/form");
    expect(document.body.textContent).toContain("Save workspace");
  });

  it("leaves on Discard", async () => {
    const router = await world(true);
    await act(async () => link().click());
    await openedDialog();
    await act(async () => button("Discard").click());
    await settle();
    expect(router.state.location.pathname).toBe("/settings/account");
  });

  it("does not ask when nothing is unsaved", async () => {
    const router = await world(false);
    await act(async () => link().click());
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(router.state.location.pathname).toBe("/settings/account");
  });
});
