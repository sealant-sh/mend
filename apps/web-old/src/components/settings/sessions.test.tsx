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

/** The person's own switches as they stand before the test changes any. */
const OWN = {
  backgroundSessions: true,
  autoTour: true,
  autoSuggest: false,
  autoName: true,
  autoLand: false,
};

/** The person's switches as the server answers them: their own, and the same as effective. */
const automation = (own: typeof OWN) => ({ own, effective: own });

/**
 * An account in no organization, on an instance whose saves go through or are refused. `saved`
 * holds what each save sent.
 */
const server = (refuseSave: boolean, saved: Array<[string, unknown]> = []) => {
  let stored = { sendSteersRunningTurn: true };
  let own = { ...OWN };
  let defaults: unknown = { harness: null, byHarness: {} };
  return (path: string, input: unknown): Answer => {
    switch (path) {
      case "organization.current":
      case "organization.settings":
        return { refuse: "not in an organization" };
      case "platform.automation":
        return { data: automation(own) };
      case "platform.setAutomation":
        saved.push([path, input]);
        if (refuseSave) return { refuse: "the store is read-only" };
        own = { ...own, ...Object(input) };
        return { data: automation(own) };
      case "platform.sessionDefaults":
        return { data: defaults };
      case "platform.setSessionDefaults":
        saved.push([path, input]);
        if (refuseSave) return { refuse: "the store is read-only" };
        defaults = input;
        return { data: defaults };
      case "platform.messageSettings":
        return { data: stored };
      case "platform.setMessageSettings":
        if (refuseSave) return { refuse: "the store is read-only" };
        stored = {
          sendSteersRunningTurn: Reflect.get(Object(input), "sendSteersRunningTurn") === true,
        };
        return { data: stored };
      case "platform.settleSettings":
        return { data: { stopSessionOnSettle: false } };
      case "harnesses.models":
        // No model list: the Agent choice then offers every agent.
        return { refuse: "no model list" };
      default:
        return { refuse: `unexpected ${path}` };
    }
  };
};

/** The switch a row labels with `label`. */
const switchNamed = (label: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[role="switch"]')].find(
    (element) =>
      document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent === label,
  );
  if (found === undefined) throw new Error(`no switch named ${label}`);
  return found;
};
const steers = () => switchNamed("Send steers the running turn");
const background = () => switchNamed("Run sessions in the background");
const pressed = (group: HTMLElement) =>
  [...group.querySelectorAll<HTMLElement>("button")]
    .find((button) => button.getAttribute("aria-pressed") === "true")
    ?.textContent?.trim();
const option = (group: HTMLElement, text: string) => {
  const found = [...group.querySelectorAll<HTMLElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  if (found === undefined) throw new Error(`no ${text} option`);
  return found;
};

describe("Settings · Sessions", () => {
  it("shows the person's own background switch, with no Inherit", async () => {
    root = await renderWithTrpc(<SessionsSettings />, server(false));
    expect(background().getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).not.toContain("Inherit");
  });

  it("saves the person's own Off and keeps it showing", async () => {
    const saved: Array<[string, unknown]> = [];
    root = await renderWithTrpc(<SessionsSettings />, server(false, saved));
    await click(background());
    expect(background().getAttribute("aria-checked")).toBe("false");
    expect(saved).toEqual([["platform.setAutomation", { ...OWN, backgroundSessions: false }]]);
  });

  it("puts the background switch back and says why when the server refuses it", async () => {
    root = await renderWithTrpc(<SessionsSettings />, server(true));
    await click(background());
    expect(background().getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "the store is read-only",
    );
  });

  it("saves the default agent on the server", async () => {
    const saved: Array<[string, unknown]> = [];
    root = await renderWithTrpc(<SessionsSettings />, server(false, saved));
    await click(option(byText('[role="group"]', "Agent"), "Codex"));
    expect(pressed(byText('[role="group"]', "Agent"))).toBe("Codex");
    expect(saved).toEqual([["platform.setSessionDefaults", { harness: "codex", byHarness: {} }]]);
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
