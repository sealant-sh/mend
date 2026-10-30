// @vitest-environment jsdom
import { RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRouter } from "#/router";

interface Sent {
  readonly url: string;
  readonly body: string;
  readonly pathnameWhenSent: string;
}

// Before the app's modules load: better-auth's createAuthClient keeps the fetch it finds then.
const sent = vi.hoisted(() => {
  const requests: Sent[] = [];
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("fetch", (input: unknown, init?: { readonly body?: unknown }) => {
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      body: typeof init?.body === "string" ? init.body : "",
      pathnameWhenSent: window.location.pathname,
    });
    return Promise.resolve(Response.json({ message: "not answered" }, { status: 500 }));
  });
  return requests;
});

const PASSWORD = "a long enough password";

let root: Root;
let host: HTMLDivElement;

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 100)));

const open = async (href: string) => {
  window.history.replaceState(null, "", href);
  const router = getRouter();
  await act(async () => root.render(<RouterProvider router={router} />));
  await settle();
  return router;
};

const text = () => host.textContent ?? "";

const go = async (navigate: () => unknown) => {
  await act(async () => {
    await navigate();
  });
  await settle();
};

const field = (id: string): HTMLInputElement => {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no field #${id}`);
  return element;
};

const type = (id: string, value: string) => {
  const input = field(id);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};

const resetTokensSent = () =>
  sent
    .filter((request) => request.url.includes("/api/auth/reset-password"))
    .map((request): unknown => JSON.parse(request.body))
    .map((body) => (typeof body === "object" && body !== null ? Reflect.get(body, "token") : null));

const tokenTheResetSends = async (): Promise<unknown> => {
  const before = resetTokensSent().length;
  await act(async () => {
    type("reset-password", PASSWORD);
    type("reset-confirm", PASSWORD);
  });
  await act(async () => button("Set password").click());
  await vi.waitFor(() => expect(resetTokensSent().length).toBe(before + 1));
  return resetTokensSent().at(-1);
};

const carriedInUrls = () => sent.filter((request) => request.url.includes("SYN_"));
const bodiesCarrying = (secret: string) => sent.filter((request) => request.body.includes(secret));

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  sent.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("an invitation link", () => {
  it("previews the invitation with its token in a request body", async () => {
    await open("/join#SYN_INVITATION");
    await vi.waitFor(() => expect(bodiesCarrying("SYN_INVITATION")).not.toEqual([]));
    expect(carriedInUrls()).toEqual([]);
  });

  it.each(["/join", "/join#", "/join#%E0%A4%A"])(
    "sends nothing when the fragment is missing or malformed (%s)",
    async (href) => {
      await open(href);
      expect(text()).toContain("This link is not an invitation");
      expect(sent).toEqual([]);
    },
  );

  it("previews the new invitation when the fragment changes in place", async () => {
    const router = await open("/join#SYN_INVITATION_A");
    await go(() => router.navigate({ href: "/join#SYN_INVITATION_B" }));
    await vi.waitFor(() => expect(bodiesCarrying("SYN_INVITATION_B")).not.toEqual([]));
  });
});

describe("a Slack link", () => {
  it("previews the link with its code in a request body", async () => {
    await open("/slack/link#msl_SYN_SLACK_CODE");
    await vi.waitFor(() => expect(bodiesCarrying("msl_SYN_SLACK_CODE")).not.toEqual([]));
    expect(carriedInUrls()).toEqual([]);
  });

  it("sends nothing when the fragment is missing", async () => {
    await open("/slack/link");
    expect(text()).toContain("This link does not work");
    expect(sent).toEqual([]);
  });

  it("previews the new code when the fragment changes in place", async () => {
    const router = await open("/slack/link#msl_SYN_SLACK_A");
    await go(() => router.navigate({ href: "/slack/link#msl_SYN_SLACK_B" }));
    await vi.waitFor(() => expect(bodiesCarrying("msl_SYN_SLACK_B")).not.toEqual([]));
  });
});

describe("a password reset link", () => {
  it("offers the form for a link that carries its token, and posts that token", async () => {
    await open("/reset#SYN_RESET_A");
    expect(text()).toContain("Set a new password");
    expect(sent).toEqual([]);
    expect(await tokenTheResetSends()).toBe("SYN_RESET_A");
    expect(carriedInUrls()).toEqual([]);
  });

  it("says the link is incomplete, and offers no form, when the fragment is missing", async () => {
    await open("/reset");
    expect(text()).toContain("This link is not complete");
    expect(text()).not.toContain("Set password");
    expect(sent).toEqual([]);
  });

  it("posts the new token, with an empty form, after the router changes the fragment", async () => {
    const router = await open("/reset#SYN_RESET_A");
    await act(async () => type("reset-password", PASSWORD));
    await go(() => router.navigate({ href: "/reset#SYN_RESET_B" }));
    expect(field("reset-password").value).toBe("");
    expect(await tokenTheResetSends()).toBe("SYN_RESET_B");
  });

  it("posts the new token after the address bar changes the fragment", async () => {
    await open("/reset#SYN_RESET_A");
    await go(() => {
      window.location.hash = "SYN_RESET_B";
    });
    expect(await tokenTheResetSends()).toBe("SYN_RESET_B");
  });

  it("offers no form once the fragment is gone", async () => {
    const router = await open("/reset#SYN_RESET_A");
    await go(() => router.navigate({ href: "/reset" }));
    expect(text()).toContain("This link is not complete");
    expect(text()).not.toContain("Set password");
  });

  it("offers the form once a missing fragment arrives", async () => {
    const router = await open("/reset");
    await go(() => router.navigate({ href: "/reset#SYN_RESET_A" }));
    expect(await tokenTheResetSends()).toBe("SYN_RESET_A");
  });

  it("posts the token of the entry Back and Forward land on", async () => {
    const router = await open("/reset#SYN_RESET_A");
    await go(() => router.navigate({ href: "/reset#SYN_RESET_B" }));
    await go(() => window.history.back());
    await vi.waitFor(() => expect(window.location.hash).toBe("#SYN_RESET_A"));
    await settle();
    expect(await tokenTheResetSends()).toBe("SYN_RESET_A");
    await go(() => window.history.forward());
    await vi.waitFor(() => expect(window.location.hash).toBe("#SYN_RESET_B"));
    await settle();
    expect(await tokenTheResetSends()).toBe("SYN_RESET_B");
  });
});

describe("a link issued before the fragment", () => {
  it.each([
    ["/join/SYN_TOKEN_JOIN", "/join", "#SYN_TOKEN_JOIN"],
    ["/reset/SYN_TOKEN_RESET", "/reset", "#SYN_TOKEN_RESET"],
    ["/slack/link/msl_SYN_TOKEN_SLACK", "/slack/link", "#msl_SYN_TOKEN_SLACK"],
  ])(
    "%s replaces its history entry with the fragment form before anything is fetched",
    async (legacy, pathname, hash) => {
      window.history.replaceState(null, "", "/");
      const entries = window.history.length;
      await open(legacy);
      expect(window.location.pathname).toBe(pathname);
      expect(window.location.hash).toBe(hash);
      expect(window.history.length).toBe(entries);
      expect(sent.filter((request) => request.pathnameWhenSent !== pathname)).toEqual([]);
      expect(carriedInUrls()).toEqual([]);
    },
  );
});
