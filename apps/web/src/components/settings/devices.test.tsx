// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { DevicesSettings } from "./devices.tsx";
import { byText, click, renderWithTrpc, settle, type Answer } from "./sessions-test-trpc.tsx";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

const TOKEN = "mend_dev_8c1f0e6b2a9d4f73";

const server = (path: string): Answer => {
  switch (path) {
    case "devices.list":
      return {
        data: [
          {
            id: "d1",
            name: "Pixel 9",
            platform: "android",
            createdAt: "2026-10-30T10:00:00.000Z",
            lastUsedAt: null,
          },
        ],
      };
    case "devices.createPairing":
      return {
        data: {
          code: "K7Q4MD2X",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          urls: ["https://alpha.mend.run", "http://10.0.0.40:3105"],
        },
      };
    case "devices.create":
      return {
        data: {
          token: TOKEN,
          urls: ["https://alpha.mend.run"],
          device: {
            id: "d2",
            name: "App Review iPhone",
            platform: "other",
            createdAt: "2026-11-02T10:00:00.000Z",
            lastUsedAt: null,
          },
        },
      };
    default:
      return { refuse: `unexpected ${path}` };
  }
};

describe("Settings · Devices", () => {
  it("lists devices with a named Revoke for each", async () => {
    root = await renderWithTrpc(<DevicesSettings />, server);
    expect(document.body.textContent).toContain("Pixel 9");
    expect(byText("button", "Revoke Pixel 9")).toBeTruthy();
  });

  it("pairs a phone in a dialog and forgets the code when it closes", async () => {
    root = await renderWithTrpc(<DevicesSettings />, server);
    await click(byText("button", "Pair a phone"));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("K7Q4-MD2X");
    expect(dialog?.textContent).toMatch(/Expires in \d:\d\d/);
    expect(byText('[role="group"]', "Address the phone uses").textContent).toContain(
      "10.0.0.40:3105",
    );
    await click(byText("button", "Done"));
    await settle();
    expect(document.body.textContent).not.toContain("K7Q4-MD2X");
  });

  it("shows a token minted by hand once, and never after the dialog closes", async () => {
    root = await renderWithTrpc(<DevicesSettings />, server);
    await click(byText("button", "Mint a token by hand"));
    await click(byText("button", "Mint"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(TOKEN);
    await click(byText("button", "Done"));
    await settle();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });
});
