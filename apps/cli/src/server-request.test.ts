import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
  mayStillBeWorking,
  MendRequestError,
  noAnswerMessage,
  noAnswerOf,
} from "./server-request.ts";

/** What fetch really throws, from a server that does `behave` to the request. */
const fetchError = async (behave: "refuse" | "drop" | "hang"): Promise<unknown> => {
  if (behave === "refuse") {
    // A port nothing listens on: bind one, close it, then call it.
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    probe.close();
    await once(probe, "close");
    return fetch(`http://127.0.0.1:${address.port}/`).then(
      () => null,
      (error: unknown) => error,
    );
  }
  const server = createServer((request) => {
    if (behave === "drop") request.socket.destroy();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    return await fetch(
      `http://127.0.0.1:${address.port}/`,
      behave === "hang" ? { signal: AbortSignal.timeout(100) } : {},
    ).then(
      () => null,
      (error: unknown) => error,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
};

describe("noAnswerOf", () => {
  it("calls only a connection that never opened unreachable", async () => {
    expect(noAnswerOf(await fetchError("refuse"))).toBe("unreachable");
    expect(noAnswerOf(await fetchError("drop"))).toBe("dropped");
    expect(noAnswerOf(await fetchError("hang"))).toBe("timeout");
    // undici's own five-minute limit on a held request.
    const headersTimeout = new TypeError("fetch failed", {
      cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    });
    expect(noAnswerOf(headersTimeout)).toBe("timeout");
  });
});

describe("noAnswerMessage", () => {
  it("never says a server that took the request cannot be reached", () => {
    expect(noAnswerMessage("unreachable", "https://mend.test", "GET /projects", 10)).toBe(
      "cannot reach the Mend server at https://mend.test — is it running?",
    );
    const timeout = noAnswerMessage("timeout", "https://mend.test", "POST /x", 300_000);
    expect(timeout).toContain("after 5 min");
    expect(timeout).not.toContain("cannot reach");
    expect(noAnswerMessage("dropped", "https://mend.test", "POST /x", 5)).not.toContain(
      "cannot reach",
    );
  });
});

describe("mayStillBeWorking", () => {
  it("is a timeout, a cut connection or an edge giving up — never a refusal or an unreachable server", () => {
    expect(mayStillBeWorking(new MendRequestError("timeout", "t"))).toBe(true);
    expect(mayStillBeWorking(new MendRequestError("dropped", "d"))).toBe(true);
    expect(mayStillBeWorking(new MendRequestError("http", "gateway", 524))).toBe(true);
    expect(mayStillBeWorking(new MendRequestError("http", "refused", 409))).toBe(false);
    expect(mayStillBeWorking(new MendRequestError("unreachable", "u"))).toBe(false);
    expect(mayStillBeWorking(new Error("other"))).toBe(false);
  });
});
