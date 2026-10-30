// @vitest-environment jsdom
import { createTRPCClient } from "@trpc/client";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "../server/routers/index.ts";
import { loginWalkUrl, trpcLinks } from "./trpc.ts";

/** Which procedures each request carried, by the paths in its URL; nothing is answered. */
const requests = async (ask: (client: ReturnType<typeof makeClient>) => Promise<unknown>[]) => {
  const paths: string[][] = [];
  const client = makeClient((input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    paths.push(decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(","));
    return Promise.reject(new Error("not answered"));
  });
  await Promise.allSettled(ask(client));
  return paths;
};

const makeClient = (fetch: Parameters<typeof trpcLinks>[1]) =>
  createTRPCClient<AppRouter>({ links: trpcLinks("http://localhost:3105/trpc", fetch) });

describe("how the page's reads go out", () => {
  it("sends sessions.recipes on its own, so the viewer never waits behind the workspace", async () => {
    const paths = await requests((client) => [
      client.organization.current.query(),
      client.sessions.recipes.query({ id: "session-1" }),
      client.organization.members.query(),
    ]);
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual(["sessions.recipes"]);
    expect(paths).toContainEqual(["organization.current", "organization.members"]);
  });
});

describe("where a read's input travels", () => {
  it("in the request body, so an invitation's token never reaches a URL", async () => {
    const sent: Array<{ readonly url: string; readonly method: string; readonly body: string }> =
      [];
    const client = makeClient((input, init) => {
      sent.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Promise.reject(new Error("not answered"));
    });
    await Promise.allSettled([
      client.organization.invitationPreview.query({ token: "SYN_INVITATION" }),
      client.sessions.recipes.query({ id: "SYN_SESSION" }),
    ]);
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.method, request.url).toBe("POST");
      expect(request.url).not.toContain("SYN_");
    }
    expect(sent.map((request) => request.body).join("\n")).toContain("SYN_INVITATION");
  });
});

describe("the walk to sign-in from a handed-over link", () => {
  it("carries where the page was in the fragment, never in the query", () => {
    window.history.replaceState(null, "", "/slack/link#msl_SYN_SLACK_CODE");
    const url = new URL(loginWalkUrl(), window.location.origin);
    expect(url.pathname).toBe("/login");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("next")).toBe(
      "/slack/link#msl_SYN_SLACK_CODE",
    );
  });
});
