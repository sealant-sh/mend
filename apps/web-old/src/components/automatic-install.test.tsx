import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AutomaticInstallView } from "./automatic-install.tsx";

const noop = () => {};
const card = (
  overrides: Partial<Parameters<typeof AutomaticInstallView>[0]> = {},
): { readonly markup: string; readonly text: string } => {
  const markup = renderToStaticMarkup(
    <AutomaticInstallView
      installEnabled
      installCommand={null}
      captured
      detection={undefined}
      draft=""
      busy={false}
      error={null}
      onEnabled={noop}
      onDraft={noop}
      onSave={noop}
      {...overrides}
    />,
  );
  return { markup, text: markup.replaceAll(/<[^>]+>/g, "").replaceAll("&#x27;", "'") };
};
const lit = (markup: string) =>
  [...markup.matchAll(/aria-pressed="true"[^>]*>(on|off)</g)].map((match) => match[1]);

describe("Dependencies card: the automatic install switch", () => {
  it("says the command is detected at launch until the detection arrives", () => {
    const { markup, text } = card();
    expect(lit(markup)).toEqual(["on"]);
    expect(text).toContain("detected from the lockfile at launch");
    expect(markup).toContain('placeholder="custom command (optional)"');
  });

  it("names the detected command and the lockfile that decided it", () => {
    const { text } = card({
      detection: {
        ref: "origin/main",
        read: true,
        command: "pnpm install --frozen-lockfile",
        from: "pnpm-lock.yaml",
      },
    });
    expect(text).toContain(
      "detected · pnpm install --frozen-lockfile · from pnpm-lock.yaml on origin/main",
    );
  });

  it("tells a tree with no lockfile apart from a tree that was not read", () => {
    const none = card({ detection: { ref: "origin/main", read: true, command: null, from: null } });
    expect(none.text).toContain("no lockfile recognised on origin/main · detected again at launch");
    const unread = card({ detection: { ref: "main", read: false, command: null, from: null } });
    expect(unread.text).toContain("not read · detected from the lockfile at launch");
    expect(unread.text).not.toContain("no lockfile recognised");
  });

  it("shows a saved custom command in place of the detected one", () => {
    const { text, markup } = card({
      installCommand: "make deps",
      draft: "make deps",
      detection: { ref: "origin/main", read: true, command: "npm ci", from: "package-lock.json" },
    });
    expect(text).toContain("runs · make deps · custom");
    expect(text).not.toContain("npm ci");
    expect(markup).toContain('value="make deps"');
  });

  it("off: no install runs, the custom command is kept, and no field is offered", () => {
    const { text, markup } = card({ installEnabled: false, installCommand: "make deps" });
    expect(lit(markup)).toEqual(["off"]);
    expect(text).toContain("off · no install runs, in sessions or for the shared cache");
    expect(text).toContain("custom command kept");
    expect(markup).not.toContain("custom command (optional)");
  });

  it("says an agent can install by hand, and never promises an install in co-located mode", () => {
    expect(card().text).toContain("an agent can install by hand");
    const colocated = card({ captured: false }).text;
    expect(colocated).toContain("Capture mode only");
    expect(colocated).toContain("Mend runs no install");
    expect(colocated).not.toContain("Mend installs dependencies before the agent starts");
  });
});
