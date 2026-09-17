import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { errorBoundary, redactErrorBody } from "./error-boundary.ts";

/** MEND-11 (docs/adr/0004, "Errors and browser headers"): what error text may leave the API. */
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const STORE_PATH = "/var/lib/mend/store/prj_9f2/repo.git";

const serve = (mode: "redacted" | "verbose") => {
  const routes = HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add("GET", "/api/declared", () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { _tag: "StoreFailure", message: `fatal: not a git repository: ${STORE_PATH}` },
            { status: 422 },
          ),
        ),
      );
      yield* router.add("GET", "/api/own-words", () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { _tag: "StoreFailure", message: "Legacy bench sessions are review-only." },
            { status: 422 },
          ),
        ),
      );
      yield* router.add("GET", "/api/upstream", () =>
        Effect.succeed(
          HttpServerResponse.text("connect ECONNREFUSED http://sealant-api.sealant.svc:4000/v1", {
            status: 502,
          }),
        ),
      );
      yield* router.add("GET", "/api/defect", () =>
        Effect.die(new Error(`EACCES: permission denied, open '${STORE_PATH}/config'`)),
      );
      yield* router.add("GET", "/api/undeclared", () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ stack: `Error\n    at ${STORE_PATH}` }, { status: 500 }),
        ),
      );
      yield* router.add("GET", "/api/ok", () =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ message: `kept: ${STORE_PATH}` })),
      );
    }),
  );
  const app = Layer.mergeAll(routes, errorBoundary({ mode })).pipe(
    Layer.provide(HttpServer.layerServices),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  disposers.push(dispose);
  return (path: string) => handler(new Request(`http://api.internal${path}`));
};

describe("the error boundary", () => {
  it("keeps a declared error's tag and sentence, and removes the server's paths from it", async () => {
    const response = await serve("redacted")("/api/declared");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      _tag: "StoreFailure",
      message: "fatal: not a git repository: <path>/repo.git",
    });
  });

  it("leaves Mend's own words exactly as written", async () => {
    const response = await serve("redacted")("/api/own-words");
    expect(await response.json()).toEqual({
      _tag: "StoreFailure",
      message: "Legacy bench sessions are review-only.",
    });
  });

  it("scrubs a plain-text upstream failure", async () => {
    const response = await serve("redacted")("/api/upstream");
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("connect ECONNREFUSED http://<internal>/v1");
  });

  it("answers a defect with a reference and none of its detail", async () => {
    const response = await serve("redacted")("/api/defect");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("EACCES");
    expect(text).not.toContain("/var/lib");
    const body: unknown = JSON.parse(text);
    expect(body).toMatchObject({ _tag: "InternalError" });
    expect(body).toHaveProperty("reference", expect.stringMatching(/^[0-9a-f]{16}$/));
  });

  it("replaces a 5xx body nobody declared", async () => {
    const response = await serve("redacted")("/api/undeclared");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("/var/lib");
    expect(JSON.parse(text)).toMatchObject({ _tag: "InternalError" });
  });

  it("does not touch a successful response, or a route that does not exist", async () => {
    const api = serve("redacted");
    expect(await (await api("/api/ok")).json()).toEqual({ message: `kept: ${STORE_PATH}` });
    expect((await api("/api/nowhere")).status).toBe(404);
  });

  it("passes detail through under MEND_ERROR_DETAIL=verbose, except a defect's", async () => {
    const api = serve("verbose");
    expect(await (await api("/api/declared")).json()).toMatchObject({
      message: `fatal: not a git repository: ${STORE_PATH}`,
    });
    // A defect has no body written for anyone: it is a reference in either mode.
    expect(await (await api("/api/defect")).json()).toMatchObject({ _tag: "InternalError" });
  });

  it("scrubs detail fields at any depth and nothing else", () => {
    expect(
      redactErrorBody({
        _tag: "X",
        id: STORE_PATH,
        message: `at ${STORE_PATH}`,
        causes: [{ stderr: `in ${STORE_PATH}`, code: 128 }],
      }),
    ).toEqual({
      _tag: "X",
      id: STORE_PATH,
      message: "at <path>/repo.git",
      causes: [{ stderr: "in <path>/repo.git", code: 128 }],
    });
  });
});
