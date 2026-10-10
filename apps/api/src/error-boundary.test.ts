import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiscardUnsavedRequest } from "@mend/api-contracts";
import {
  HOST_USER_NAMESPACE_SYSCTL_FILE,
  hostUserNamespacesFix,
  hostUserNamespacesRefusal,
  hostUserNamespacesRefusalParts,
} from "@mend/domain/host-user-namespaces";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { afterEach, describe, expect, it } from "vitest";

import { errorBoundary, redactErrorBody, redactKeepingHostFix } from "./error-boundary.ts";

/** MEND-11 (docs/adr/0004, "Errors and browser headers"): what error text may leave the API. */
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const STORE_PATH = "/var/lib/mend/store/prj_9f2/repo.git";
const USERNS_SETTING = "kernel.apparmor_restrict_unprivileged_userns = 0";

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
      // What a launch on a host that refuses user namespaces fails with (sessions engine).
      yield* router.add("GET", "/api/host-refusal", () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { _tag: "LaunchRefused", message: hostUserNamespacesRefusal(USERNS_SETTING) },
            { status: 409 },
          ),
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
  return (route: string) => handler(new Request(`http://api.internal${route}`));
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

  it("keeps the host refusal's command whole, so the line the CLI prints runs when pasted (RC 761)", async () => {
    const response = await serve("redacted")("/api/host-refusal");
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toEqual({
      _tag: "LaunchRefused",
      message: hostUserNamespacesRefusal(USERNS_SETTING),
    });
    const message =
      typeof body === "object" && body !== null && "message" in body ? String(body.message) : "";
    // The CLI prints a refused launch as `mend: <message>`; a person pastes the command out of it.
    const command = hostUserNamespacesRefusalParts(`mend: ${message}`)?.command ?? "";
    expect(command).toBe(hostUserNamespacesFix(USERNS_SETTING));
    expect(command).not.toContain("<path>");
    // Run it, with a sudo that records what it was asked instead of doing it.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mend-host-fix-"));
    disposers.push(async () => fs.rmSync(bin, { recursive: true, force: true }));
    const log = path.join(bin, "sudo.log");
    fs.writeFileSync(
      path.join(bin, "sudo"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1" = tee ] && cat > '${path.join(bin, "written")}'\nexit 0\n`,
      { mode: 0o755 },
    );
    execFileSync("sh", ["-c", command], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
      `tee ${HOST_USER_NAMESPACE_SYSCTL_FILE}`,
      "sysctl --system",
    ]);
    expect(fs.readFileSync(path.join(bin, "written"), "utf8")).toBe(`${USERNS_SETTING}\n`);
  });

  it("keeps only Mend's own command: any other in its place, and the words around it, are scrubbed", () => {
    const refusal = hostUserNamespacesRefusal(USERNS_SETTING);
    expect(redactKeepingHostFix(`${refusal} · saved at ${STORE_PATH}`)).toBe(
      `${refusal} · saved at <path>/repo.git`,
    );
    const tampered = refusal.replace(HOST_USER_NAMESPACE_SYSCTL_FILE, `${STORE_PATH}/x.conf`);
    expect(redactKeepingHostFix(tampered)).not.toContain(STORE_PATH);
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

describe("a request that does not decode (e2e run 6)", () => {
  const DiscardApi = HttpApi.make("discard").add(
    HttpApiGroup.make("sessions").add(
      HttpApiEndpoint.post("discardUnsaved", "/sessions/:id/discard-unsaved", {
        params: { id: Schema.String },
        payload: DiscardUnsavedRequest,
        success: Schema.String,
      }),
    ),
  );
  const serveApi = () => {
    const routes = HttpApiBuilder.group(DiscardApi, "sessions", (handlers) =>
      handlers.handle("discardUnsaved", () => Effect.succeed("discarded")),
    );
    const app = HttpApiBuilder.layer(DiscardApi).pipe(
      Layer.provide(routes),
      Layer.provide(errorBoundary({ mode: "redacted" })),
      Layer.provide(HttpServer.layerServices),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
    disposers.push(dispose);
    return (body: unknown) =>
      handler(
        new Request("http://api.internal/sessions/s-1/discard-unsaved", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
  };

  it("a discard without its confirmation is the client's 400, never a 500", async () => {
    const post = serveApi();
    const refused = await post({});
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      _tag: "BadRequest",
      message: "the request's payload is not what this route takes",
    });
    const confirmed = await post({ confirm: "discard unsaved" });
    expect(confirmed.status).toBe(200);
  });
});
