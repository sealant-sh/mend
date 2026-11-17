// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginDialog, type LoginTarget } from "./account-login-dialog.tsx";
import { AgentLoginsSection } from "./account.tsx";
import {
  byText,
  cachedText,
  click,
  renderWithTrpc,
  settle,
  type Answer,
} from "./sessions-test-trpc.tsx";

vi.hoisted(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

// The shape the Anthropic Console issues today, linked to a user.
const FAKE_KEY = "sk-ant-usr-fake-0000-a1b2";

const account = (fields: {
  readonly id: string;
  readonly provider?: "claude" | "codex" | "github";
  readonly isDefault: boolean;
  readonly status?: "active" | "invalid";
  readonly login?:
    | { readonly kind: "subscription" }
    | { readonly kind: "api-key"; readonly suffix: string; readonly endpointHost?: string };
  readonly metadata?: Record<string, unknown>;
}) => ({
  id: fields.id,
  provider: fields.provider ?? "claude",
  name: fields.id,
  kind: fields.login?.kind === "api-key" ? "api-key" : "oauth-token",
  status: fields.status ?? "active",
  metadata: fields.metadata ?? {},
  connectedAt: new Date("2026-11-08T00:00:00.000Z"),
  updatedAt: new Date("2026-11-08T00:00:00.000Z"),
  lastUsedAt: null,
  isDefault: fields.isDefault,
  ...(fields.login === undefined ? {} : { login: fields.login }),
});

const subscription = account({
  id: "subscription",
  isDefault: true,
  login: { kind: "subscription" },
  metadata: { email: "maria@example.com" },
});
const key = account({
  id: "api-key",
  isDefault: false,
  login: { kind: "api-key", suffix: "a1b2" },
});

const server =
  (
    identity: { readonly accounts: ReadonlyArray<unknown>; readonly apiKeys: boolean },
    sent: Array<unknown> = [],
  ) =>
  (path: string, input: unknown): Answer => {
    if (path === "platform.sealantIdentity")
      return { data: { sealantUserId: "su-maria", ...identity } };
    if (path === "platform.agentLogins") return { data: { selectedOnly: false } };
    if (path === "platform.connectAccount") {
      sent.push(input);
      return { data: key };
    }
    if (path === "platform.disconnectAccount") {
      sent.push(input);
      return { data: { ...key, status: "archived" } };
    }
    return { refuse: `no fake for ${path}` };
  };

const rowText = () =>
  [...document.querySelectorAll('[role="row"]')].map((row) => row.textContent ?? "");

/** The dialog as Settings holds it: closed once a login is saved. */
function Settings({
  target,
  apiKeys,
}: {
  readonly target: LoginTarget;
  readonly apiKeys: boolean;
}) {
  const [open, setOpen] = useState<LoginTarget | null>(target);
  return <LoginDialog target={open} apiKeys={apiKeys} onClose={() => setOpen(null)} />;
}

const openDialog = async (target: LoginTarget, apiKeys: boolean, sent: Array<unknown>) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = await renderWithTrpc(
    <Settings target={target} apiKeys={apiKeys} />,
    server({ accounts: [], apiKeys }, sent),
    queryClient,
  );
  for (let tick = 0; tick < 100 && document.querySelector('[role="dialog"]') === null; tick += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  return queryClient;
};

const typeKey = (value: string) => {
  const input = document.querySelector<HTMLInputElement>('input[type="password"]');
  if (input === null) throw new Error("no key field");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const save = () => byText("button", "Save login");

const endpointField = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="url"]');
  if (input === null) throw new Error("no endpoint field");
  return input;
};

const typeEndpoint = (value: string) => {
  const input = endpointField();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const leaveEndpoint = () =>
  act(() => {
    endpointField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

describe("the agent login rows", () => {
  it("shows a key beside a subscription in the words of ADR 0018, the default marked", async () => {
    root = await renderWithTrpc(
      <AgentLoginsSection />,
      server({ accounts: [subscription, key], apiKeys: true }),
    );
    const rows = rowText();
    expect(rows).toContainEqual(
      expect.stringContaining("Claude · subscription · maria@example.com · default"),
    );
    expect(rows).toContainEqual(
      expect.stringContaining("Claude · API key ····a1b2 · billed per token"),
    );
    expect(document.body.textContent).toContain("Your own subscriptions and API keys.");
  });

  it("shows a subscription alone as it always has, with a way to add a key", async () => {
    root = await renderWithTrpc(
      <AgentLoginsSection />,
      server({ accounts: [subscription], apiKeys: true }),
    );
    expect(rowText()).toContainEqual(expect.stringContaining("maria@example.com"));
    expect(rowText().join("\n")).not.toContain("subscription ·");
    expect(byText("button", "Add a Claude API key")).toBeDefined();
  });

  it("offers no key on a platform that cannot run sessions on one", async () => {
    root = await renderWithTrpc(
      <AgentLoginsSection />,
      server({ accounts: [subscription], apiKeys: false }),
    );
    expect(document.body.textContent).not.toContain("Add a Claude API key");
  });

  it("says a disconnected key stays valid at Anthropic until it is revoked there", async () => {
    const sent: Array<unknown> = [];
    root = await renderWithTrpc(
      <AgentLoginsSection />,
      server({ accounts: [subscription, key], apiKeys: true }, sent),
    );
    await click(byText("button", "More for your Claude API key"));
    // The menu's code loads as it first opens.
    for (
      let tick = 0;
      tick < 100 && document.querySelector('[role="menuitem"]') === null;
      tick += 1
    )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    await click(byText('[role="menuitem"]', "Disconnect your Claude API key"));
    expect(sent).toEqual([{ id: "api-key" }]);
    expect(document.body.textContent).toContain(
      "Disconnected your Claude API key ····a1b2. The key stays valid at Anthropic until you revoke it in the Anthropic Console.",
    );
  });

  it("names a key's endpoint host to the person who added it", async () => {
    root = await renderWithTrpc(
      <AgentLoginsSection />,
      server({
        accounts: [
          subscription,
          account({
            id: "api-key",
            isDefault: false,
            login: { kind: "api-key", suffix: "a1b2", endpointHost: "gateway.example.com" },
          }),
        ],
        apiKeys: true,
      }),
    );
    expect(rowText()).toContainEqual(
      expect.stringContaining(
        "Claude · API key ····a1b2 · billed per token · endpoint gateway.example.com",
      ),
    );
  });

  it("says a refused key was refused by its provider", async () => {
    root = await renderWithTrpc(
      <AgentLoginsSection />,
      server({
        accounts: [
          account({
            id: "api-key",
            provider: "codex",
            isDefault: true,
            status: "invalid",
            login: { kind: "api-key", suffix: "c3d4" },
          }),
        ],
        apiKeys: true,
      }),
    );
    expect(rowText()).toContainEqual(
      expect.stringContaining(
        "Codex · API key ····c3d4 · billed per token · refused by OpenAI · replace the key",
      ),
    );
  });
});

describe("the API key form", () => {
  const addKey: LoginTarget = {
    provider: "claude",
    replacing: null,
    login: "api-key",
    otherDefault: subscription,
  };

  it("sends the key as an API key, recommends a spend limit, and keeps the key out of every cache", async () => {
    const sent: Array<unknown> = [];
    const queryClient = await openDialog(addKey, true, sent);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Add a Claude API key",
    );
    expect(document.body.textContent).toContain(
      "Set a spend limit on the key's workspace in the Anthropic Console",
    );
    typeKey(FAKE_KEY);
    await click(save());
    await settle();
    expect(sent).toEqual([{ provider: "claude", secret: FAKE_KEY, login: "api-key" }]);
    expect(cachedText(queryClient)).not.toContain(FAKE_KEY);
  });

  it("makes the key the default only when the person chooses it", async () => {
    const sent: Array<unknown> = [];
    await openDialog(addKey, true, sent);
    typeKey(FAKE_KEY);
    expect(document.body.textContent).toContain("Use it as my default Claude login");
    const choice = document.querySelector<HTMLElement>('[role="switch"]');
    if (choice === null) throw new Error("no default choice");
    await click(choice);
    await click(save());
    await settle();
    expect(sent).toEqual([
      { provider: "claude", secret: FAKE_KEY, login: "api-key", makeDefault: true },
    ]);
  });

  it("asks nothing about the default for a first login", async () => {
    await openDialog(
      { provider: "codex", replacing: null, login: null, otherDefault: null },
      true,
      [],
    );
    expect(document.body.textContent).not.toContain("Use it as my default");
  });

  it("says so, and saves nothing, when the platform cannot run sessions on a key", async () => {
    const sent: Array<unknown> = [];
    await openDialog(addKey, false, sent);
    expect(document.body.textContent).toContain("does not run sessions on an API key yet");
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("sends a key to the endpoint the person names, as the platform will store it", async () => {
    const sent: Array<unknown> = [];
    await openDialog(addKey, true, sent);
    expect(document.body.textContent).toContain(
      "Send this login's requests to a compatible endpoint, such as a company gateway. Leave it empty for Anthropic's API.",
    );
    expect(document.body.textContent).not.toContain("If the endpoint takes no key");
    typeEndpoint("http://gateway.internal:8080/anthropic/");
    expect(document.body.textContent).toContain("If the endpoint takes no key, enter any value.");
    typeKey("placeholder");
    await click(save());
    await settle();
    expect(sent).toEqual([
      {
        provider: "claude",
        secret: "placeholder",
        login: "api-key",
        endpoint: "http://gateway.internal:8080/anthropic",
      },
    ]);
  });

  it("says why an endpoint would be refused once the person leaves the field, and saves nothing", async () => {
    const sent: Array<unknown> = [];
    await openDialog({ ...addKey, provider: "codex" }, true, sent);
    expect(document.body.textContent).toContain("Leave it empty for OpenAI's API.");
    typeKey(FAKE_KEY);
    typeEndpoint("gateway.example.com/v1");
    expect(document.body.textContent).not.toContain("The endpoint must be");
    leaveEndpoint();
    expect(document.body.textContent).toContain(
      "The endpoint must be an absolute http: or https: URL.",
    );
    expect(endpointField().getAttribute("aria-invalid")).toBe("true");
    expect(save().hasAttribute("disabled")).toBe(true);
    typeEndpoint("https://gateway.example.com/v1");
    await click(save());
    await settle();
    expect(sent).toEqual([
      {
        provider: "codex",
        secret: FAKE_KEY,
        login: "api-key",
        endpoint: "https://gateway.example.com/v1",
      },
    ]);
  });

  it("offers no endpoint beside a subscription", async () => {
    await openDialog(
      { provider: "claude", replacing: null, login: "subscription", otherDefault: null },
      true,
      [],
    );
    expect(document.querySelector('input[type="url"]')).toBeNull();
  });
});
