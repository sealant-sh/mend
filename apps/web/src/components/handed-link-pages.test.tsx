// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createTRPCClient } from "@trpc/client";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trpcLinks, TRPCProvider } from "#/lib/trpc";

import type { AppRouter } from "../server/routers/index.ts";
import { JoinPage } from "./join-page.tsx";
import { ResetPage } from "./reset-page.tsx";
import { SlackLinkPage } from "./slack-link-page.tsx";

interface Sent {
  readonly url: string;
  readonly body: string;
}

let sent: Sent[];
let root: Root;
let host: HTMLDivElement;

const recordingFetch = (input: unknown, init?: { readonly body?: unknown }): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  sent.push({ url, body: typeof init?.body === "string" ? init.body : "" });
  return Promise.resolve(Response.json({ message: "not answered" }, { status: 500 }));
};

const visit = async (href: string, Page: () => ReactNode) => {
  window.history.replaceState(null, "", href);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({
    links: trpcLinks("http://localhost:3000/trpc", recordingFetch),
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory(),
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <RouterProvider router={router} />
        </TRPCProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  return host.textContent ?? "";
};

const carriedInUrls = () => sent.filter((request) => request.url.includes("SYN_"));
const carriedInBodies = () => sent.filter((request) => request.body.includes("SYN_"));
const someBodyCarries = () => vi.waitFor(() => expect(carriedInBodies()).not.toEqual([]));

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  sent = [];
  vi.stubGlobal("fetch", recordingFetch);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("an invitation link", () => {
  it("previews the invitation with its token in a request body", async () => {
    await visit("/join#SYN_INVITATION", JoinPage);
    await someBodyCarries();
    expect(carriedInUrls()).toEqual([]);
  });

  it.each(["/join", "/join#", "/join#%E0%A4%A"])(
    "sends nothing when the fragment is missing or malformed (%s)",
    async (href) => {
      expect(await visit(href, JoinPage)).toContain("This link is not an invitation");
      expect(sent).toEqual([]);
    },
  );
});

describe("a Slack link", () => {
  it("previews the link with its code in a request body", async () => {
    await visit("/slack/link#msl_SYN_SLACK_CODE", SlackLinkPage);
    await someBodyCarries();
    expect(carriedInUrls()).toEqual([]);
  });

  it("sends nothing when the fragment is missing", async () => {
    expect(await visit("/slack/link", SlackLinkPage)).toContain("This link does not work");
    expect(sent).toEqual([]);
  });
});

describe("a password reset link", () => {
  it("offers the form for a link that carries its token", async () => {
    expect(await visit("/reset#SYN_RESET", ResetPage)).toContain("Set a new password");
    expect(sent).toEqual([]);
  });

  it("says the link is incomplete, and offers no form, when the fragment is missing", async () => {
    const text = await visit("/reset", ResetPage);
    expect(text).toContain("This link is not complete");
    expect(text).not.toContain("Set password");
    expect(sent).toEqual([]);
  });
});
