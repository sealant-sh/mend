// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  awaitDeviceApproval,
  groupCode,
  normalizeServerUrl,
  openDeviceRequest,
  parseOpenedRequest,
  parsePollAnswer,
  type DeviceLoginDeps,
  type OpenedRequest,
} from "./device-login";

const approved = {
  status: "approved",
  token: "mdt_secret",
  user: { id: "u1", name: "Yiannis", email: "y@example.com" },
  device: { id: "dev-1", name: "box · desktop" },
};

const opened: OpenedRequest = {
  deviceCode: "device-secret",
  code: "abcd2345",
  verifyPath: "/authorize?code=ABCD2345",
  expiresAt: "2026-09-24T03:10:00.000Z",
  intervalSeconds: 2,
};

/** A fake server: each POST takes the next scripted answer; the log records what was sent. */
const scripted = (
  answers: ReadonlyArray<{ readonly status: number; readonly body: unknown } | "unreachable">,
) => {
  const sent: Array<{ readonly url: string; readonly body: unknown }> = [];
  let index = 0;
  let clock = Date.parse("2026-09-24T03:00:00.000Z");
  const deps: DeviceLoginDeps = {
    fetch: async (input, init) => {
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      sent.push({ url: String(input), body });
      const answer = answers[index] ?? { status: 200, body: { status: "pending" } };
      index += 1;
      if (answer === "unreachable") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    name: "box · desktop",
  };
  return { deps, sent };
};

describe("parsing the server's answers", () => {
  it("reads an opened request and refuses an off-shape one", () => {
    expect(parseOpenedRequest(opened)).toEqual(opened);
    expect(parseOpenedRequest({ ...opened, intervalSeconds: "2" })).toBeNull();
    expect(parseOpenedRequest("<html>")).toBeNull();
  });

  it("reads pending and approved polls", () => {
    expect(parsePollAnswer({ status: "pending" })).toEqual({ status: "pending" });
    expect(parsePollAnswer(approved)).toEqual(approved);
    expect(parsePollAnswer({ ...approved, device: { id: 1 } })).toBeNull();
    expect(parsePollAnswer({ status: "granted" })).toBeNull();
  });
});

describe("the server URL", () => {
  it("normalizes as mend login does", () => {
    expect(normalizeServerUrl("alpha.mend.run:443/")).toBe("http://alpha.mend.run:443");
    expect(normalizeServerUrl(" https://alpha.mend.run/ ")).toBe("https://alpha.mend.run");
    expect(normalizeServerUrl("https://host/mend/")).toBe("https://host/mend");
    expect(normalizeServerUrl("ftp://host")).toBeNull();
    expect(normalizeServerUrl("")).toBeNull();
  });

  it("groups the code for the eye", () => {
    expect(groupCode("abcd2345")).toBe("ABCD-2345");
    expect(groupCode("ab")).toBe("AB");
  });
});

describe("openDeviceRequest", () => {
  it("names the device and hands back the approve page, not the device code", async () => {
    const { deps, sent } = scripted([{ status: 200, body: opened }]);
    const result = await openDeviceRequest("https://alpha.mend.run/", deps);
    expect(sent).toEqual([
      { url: "https://alpha.mend.run/api/cli/auth", body: { name: "box · desktop" } },
    ]);
    expect(result).toEqual({
      ok: true,
      request: opened,
      view: {
        url: "https://alpha.mend.run",
        code: "ABCD-2345",
        authorizeUrl: "https://alpha.mend.run/authorize?code=ABCD2345",
        expiresAt: opened.expiresAt,
      },
    });
  });

  it("says what went wrong", async () => {
    expect(await openDeviceRequest("https://x", scripted(["unreachable"]).deps)).toEqual({
      ok: false,
      reason: "cannot reach the Mend server at https://x — is it running?",
    });
    expect(
      await openDeviceRequest("https://x", scripted([{ status: 200, body: "<html>" }]).deps),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("did not answer like a Mend server"),
    });
    expect(
      await openDeviceRequest(
        "https://x",
        scripted([{ status: 429, body: { retryAfterSeconds: 7 } }]).deps,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("7s") });
  });
});

describe("awaitDeviceApproval", () => {
  it("polls through pending and a dropped request until approved", async () => {
    const { deps, sent } = scripted([
      { status: 200, body: { status: "pending" } },
      "unreachable",
      { status: 200, body: approved },
    ]);
    const result = await awaitDeviceApproval("https://x", opened, deps, () => false);
    expect(result).toEqual({
      ok: true,
      url: "https://x",
      token: "mdt_secret",
      deviceId: "dev-1",
      deviceName: "box · desktop",
      email: "y@example.com",
    });
    expect(sent.map((entry) => entry.body)).toEqual([
      { deviceCode: "device-secret" },
      { deviceCode: "device-secret" },
      { deviceCode: "device-secret" },
    ]);
  });

  it("stops on a denial, a spent request, and a cancel", async () => {
    expect(
      await awaitDeviceApproval(
        "https://x",
        opened,
        scripted([{ status: 403, body: {} }]).deps,
        () => false,
      ),
    ).toEqual({ ok: false, reason: "denied in the browser; nothing was granted" });
    expect(
      await awaitDeviceApproval(
        "https://x",
        opened,
        scripted([{ status: 410, body: {} }]).deps,
        () => false,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("no longer open") });
    const { deps, sent } = scripted([]);
    expect(await awaitDeviceApproval("https://x", opened, deps, () => true)).toEqual({
      ok: false,
      reason: "cancelled; nothing was granted",
    });
    expect(sent).toEqual([]);
  });

  it("revokes an approval that lands on the poll a cancel interrupted", async () => {
    let cancel = false;
    const { deps, sent } = scripted([
      { status: 200, body: approved },
      { status: 200, body: {} },
    ]);
    const wrapped: DeviceLoginDeps = {
      ...deps,
      fetch: async (input, init) => {
        const answer = await deps.fetch(input, init);
        cancel = true;
        return answer;
      },
    };
    expect(await awaitDeviceApproval("https://x", opened, wrapped, () => cancel)).toEqual({
      ok: false,
      reason: "cancelled; the approval that arrived meanwhile was revoked",
    });
    expect(sent.map((entry) => entry.url)).toEqual([
      "https://x/api/cli/auth/token",
      "https://x/api/me/devices/dev-1",
    ]);
  });

  it("gives up at the request's expiry", async () => {
    const { deps } = scripted([]);
    const result = await awaitDeviceApproval("https://x", opened, deps, () => false);
    expect(result).toEqual({
      ok: false,
      reason: "the authorize request expired before anyone approved it",
    });
  });
});
