import { SealantApiError } from "@sealant/sdk";
import { describe, expect, it } from "vitest";

import { platformErrorCode, workspaceStopStateOf } from "./client.ts";

/**
 * The engine branches on the platform's STABLE codes (`workspace-docker-unsupported`,
 * `runtime-env-references-unsupported`). The SDK reports a typed contract error's TAG as its
 * `code` and keeps the decoded error as `cause`; the stable code must win, on every shape the
 * client can receive. The decoded contract error is modelled as what it is at runtime: a record
 * with `_tag`, `code` and `message`.
 */
describe("platformErrorCode", () => {
  const contractError = {
    _tag: "WorkspaceDockerServiceUnsupportedError",
    code: "workspace-docker-unsupported",
    message: "no Docker here",
  };

  it("prefers the body code over the SDK's tag code", () => {
    const sdkError = new SealantApiError("no Docker here", {
      code: contractError._tag,
      status: 422,
      cause: contractError,
    });
    expect(sdkError.code).toBe("WorkspaceDockerServiceUnsupportedError");
    expect(platformErrorCode(sdkError)).toBe("workspace-docker-unsupported");
  });

  it("reads the body code off a bare contract error (Effect-native operations)", () => {
    expect(platformErrorCode(contractError)).toBe("workspace-docker-unsupported");
  });

  it("falls back to the SDK code, then the tag, then UNKNOWN", () => {
    expect(platformErrorCode(new SealantApiError("boom", { code: "api_error", status: 500 }))).toBe(
      "api_error",
    );
    expect(platformErrorCode({ _tag: "SomethingElse", message: "x" })).toBe("SomethingElse");
    expect(platformErrorCode(new Error("plain"))).toBe("UNKNOWN");
  });
});

/**
 * A stop's answer (Core's `WorkspaceStopResult`): only `stopped` is a termination. SDK 0.37.2
 * resolves nothing, which is a stop asked and nothing more known.
 */
describe("workspaceStopStateOf", () => {
  it("reads the platform's four states and nothing else", () => {
    expect(workspaceStopStateOf({ state: "stopped" })).toBe("stopped");
    expect(workspaceStopStateOf({ state: "draining", drain: {} })).toBe("draining");
    expect(workspaceStopStateOf({ state: "kept" })).toBe("kept");
    expect(workspaceStopStateOf({ state: "requested" })).toBe("requested");
    expect(workspaceStopStateOf(undefined)).toBe("requested");
    expect(workspaceStopStateOf({ state: "gone" })).toBe("requested");
  });
});
