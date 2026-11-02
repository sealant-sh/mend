// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { byText, click, renderWithTrpc, type Answer } from "./sessions-test-trpc.tsx";
import { SessionsSettings } from "./sessions.tsx";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

const INSTANCE = {
  backgroundSessions: true,
  autoTour: true,
  autoSuggest: false,
  autoName: true,
  autoLand: false,
};

/** An account in no organization, on an instance whose message setting saves or refuses. */
const server = (refuseSave: boolean) => {
  let stored = { sendSteersRunningTurn: true };
  return (path: string, input: unknown): Answer => {
    switch (path) {
      case "organization.current":
      case "organization.settings":
        return { refuse: "not in an organization" };
      case "settings.get":
        return { data: INSTANCE };
      case "platform.messageSettings":
        return { data: stored };
      case "platform.setMessageSettings":
        if (refuseSave) return { refuse: "the store is read-only" };
        stored = {
          sendSteersRunningTurn: Reflect.get(Object(input), "sendSteersRunningTurn") === true,
        };
        return { data: stored };
      case "harnesses.models":
        return { data: [] };
      default:
        return { refuse: `unexpected ${path}` };
    }
  };
};

const steers = () => byText('[role="switch"]', /.*/);

describe("Settings · Sessions", () => {
  it("reads background sessions from the instance, with where it comes from", async () => {
    root = await renderWithTrpc(<SessionsSettings />, server(false));
    expect(
      byText("[aria-label]", /Run sessions in the background: on\. From the instance default/),
    ).toBeTruthy();
  });

  it("puts the switch back and says why when the server refuses", async () => {
    root = await renderWithTrpc(<SessionsSettings />, server(true));
    expect(steers().getAttribute("aria-checked")).toBe("true");
    await click(steers());
    expect(steers().getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "the store is read-only",
    );
  });

  it("keeps the switch where it was put when the server saves", async () => {
    root = await renderWithTrpc(<SessionsSettings />, server(false));
    await click(steers());
    expect(steers().getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
