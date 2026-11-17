// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { AccessKeysSettings } from "./access-keys.tsx";
import {
  byText,
  cachedText,
  click,
  renderWithTrpc,
  settle,
  type Answer,
} from "./sessions-test-trpc.tsx";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

const SECRET = "mak_k9_Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA";
const DAY = 86_400_000;

const listed = () => [
  {
    id: "k1",
    name: "ci-bot",
    organizationId: "org",
    createdAt: "2026-10-30T10:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  },
  {
    id: "k2",
    name: "slack-bot",
    organizationId: "org",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() - DAY).toISOString(),
  },
];

interface Calls {
  readonly paths: Array<string>;
  readonly inputs: Array<unknown>;
}

const serverWith =
  (calls: Calls, create: Answer = { data: null }) =>
  (path: string, input: unknown): Answer => {
    calls.paths.push(path);
    calls.inputs.push(input);
    switch (path) {
      case "accessKeys.list":
        return { data: listed() };
      case "accessKeys.create":
        return "refuse" in create
          ? create
          : {
              data: {
                key: {
                  id: "k9",
                  name: "nightly",
                  organizationId: "org",
                  createdAt: new Date().toISOString(),
                  lastUsedAt: null,
                  expiresAt: null,
                },
                secret: SECRET,
              },
            };
      case "accessKeys.revoke":
        return { data: listed()[0] };
      default:
        return { refuse: `unexpected ${path}` };
    }
  };

const enter = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};

const nameInput = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  if (input === null) throw new Error("no name input in the dialog");
  return input;
};

describe("Settings · Access keys", () => {
  it("lists each key with when it was used and when it expires, and a named Revoke", async () => {
    root = await renderWithTrpc(<AccessKeysSettings />, serverWith({ paths: [], inputs: [] }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("ci-bot");
    expect(text).toContain("never");
    expect(text).toContain("no expiry");
    expect(text).toContain("3 hours ago");
    expect(text).toContain("expired");
    expect(text).not.toMatch(/API key|token/i);
    expect(byText("a", "Using an access key").getAttribute("href")).toBe(
      "https://docs.mend.run/guides/automation/",
    );
    expect(byText("button", "Revoke slack-bot")).toBeTruthy();
  });

  it("revokes after saying the next request is refused, then reads the list again", async () => {
    const calls: Calls = { paths: [], inputs: [] };
    root = await renderWithTrpc(<AccessKeysSettings />, serverWith(calls));
    await click(byText("button", "Revoke ci-bot"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "The next request with this key is refused.",
    );
    await click(byText('[role="dialog"] button', "Revoke"));
    expect(calls.inputs[calls.paths.indexOf("accessKeys.revoke")]).toEqual({ id: "k1" });
    expect(calls.paths.filter((path) => path === "accessKeys.list")).toHaveLength(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("creates a key with the picked expiry, shows its secret once, and forgets it on close", async () => {
    const calls: Calls = { paths: [], inputs: [] };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = await renderWithTrpc(<AccessKeysSettings />, serverWith(calls), queryClient);
    await click(byText("button", "Create an access key"));
    expect(byText('[role="dialog"] button', "Create").hasAttribute("disabled")).toBe(true);
    await enter(nameInput(), "  nightly  ");
    await click(byText("button", "No expiry"));
    await click(byText('[role="dialog"] button', "Create"));
    expect(calls.inputs[calls.paths.indexOf("accessKeys.create")]).toEqual({
      name: "nightly",
      expiresInDays: null,
    });
    const dialog = document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(dialog).toContain("Access key · shown once");
    expect(dialog).toContain(SECRET);
    expect(dialog).toContain(
      `curl -H "Authorization: Bearer $MEND_ACCESS_KEY" ${window.location.origin}/api/projects`,
    );
    await click(byText("button", "Done"));
    await settle();
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(cachedText(queryClient)).not.toContain(SECRET);
  });

  it("asks for 90 days unless another expiry is picked", async () => {
    const calls: Calls = { paths: [], inputs: [] };
    root = await renderWithTrpc(<AccessKeysSettings />, serverWith(calls));
    await click(byText("button", "Create an access key"));
    await enter(nameInput(), "deploys");
    await click(byText('[role="dialog"] button', "Create"));
    expect(calls.inputs[calls.paths.indexOf("accessKeys.create")]).toEqual({
      name: "deploys",
      expiresInDays: 90,
    });
  });

  it("says why a key was not created, in the server's words", async () => {
    const refusal = "You belong to no organization, so there is none for an access key to act in.";
    root = await renderWithTrpc(
      <AccessKeysSettings />,
      serverWith({ paths: [], inputs: [] }, { refuse: refusal }),
    );
    await click(byText("button", "Create an access key"));
    await enter(nameInput(), "ci-bot");
    await click(byText('[role="dialog"] button', "Create"));
    expect(byText('[role="alert"]', `Not created: ${refusal}`)).toBeTruthy();
  });
});
