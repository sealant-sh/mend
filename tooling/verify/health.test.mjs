import assert from "node:assert/strict";
import test from "node:test";

import { health, readAnswer, VANTAGES } from "./health.mjs";

const URL = "https://box.example.invalid";
const ENDPOINT = "https://sessions.example.invalid:8443";
const body = (version = "0.37.0-next.1.preview.1") =>
  JSON.stringify({
    status: "ok",
    version,
    sessionChannel: { mode: "network", endpoint: ENDPOINT },
  });

const answering = (version) => async () => ({ status: 200, text: async () => body(version) });

// A box whose host and containers see the network as `seen` says: url → { s, b } or { e }.
const box = (seen) => (script) => {
  if (script.includes("APP_URL")) {
    return {
      code: 0,
      stdout: `APP_URL=${URL}\nIMAGE=ghcr.io/sealant-sh/mend:x\nNODE=node\n`,
      stderr: "",
    };
  }
  const urls = JSON.parse(/for \(const u of (\[.*?\])\)/.exec(script)[1]);
  const from = script.startsWith("docker run") ? "workspace" : "host";
  return {
    code: 0,
    stdout: urls.map((u) => JSON.stringify({ u, ...seen[from](u) })).join("\n"),
    stderr: "",
  };
};

const statuses = (result) => Object.fromEntries(result.steps.map((step) => [step.id, step.status]));

test("each vantage says what it saw: healthy here, unresolvable from the box itself", async () => {
  const result = await health({
    from: VANTAGES,
    ssh: box({
      host: () => ({ e: "ENOTFOUND" }),
      workspace: (u) =>
        u.startsWith(ENDPOINT) ? { s: 401, b: "unauthorized" } : { e: "ENOTFOUND" },
    }),
    fetchImpl: answering(),
  });
  assert.deepEqual(statuses(result), {
    local: "passed",
    host: "failed",
    workspace: "failed",
    "workspace-session-endpoint": "passed",
  });
  assert.equal(result.server.appUrl, URL, "the URL is the server's own APP_URL");
  assert.match(result.steps.find((step) => step.id === "host").detail, /ENOTFOUND/);
});

test("an answer that is not Mend's health, or another version, is not a pass", async () => {
  assert.equal(readAnswer(200, "<html>").error, "the answer is not Mend's health JSON");
  const html = await health({
    url: URL,
    from: ["local"],
    ssh: null,
    fetchImpl: async () => ({ status: 200, text: async () => "<html>gateway</html>" }),
  });
  assert.equal(html.steps[0].status, "failed");
  const older = await health({
    url: URL,
    from: ["local"],
    ssh: null,
    expectVersion: "0.37.0-next.2",
    fetchImpl: answering("0.37.0-next.1"),
  });
  assert.equal(older.steps[0].status, "failed");
  assert.match(older.steps[0].detail, /expected 0\.37\.0-next\.2/);
});

test("without the box, its vantages are blocked, not failed, and say how to name it", async () => {
  const result = await health({ url: URL, from: VANTAGES, ssh: null, fetchImpl: answering() });
  assert.deepEqual(statuses(result), {
    local: "passed",
    host: "blocked_by_prerequisite",
    workspace: "blocked_by_prerequisite",
  });
  assert.match(result.next[0], /MEND_VERIFY_BOX_SSH/);
  const noUrl = await health({ from: ["local"], ssh: null, fetchImpl: answering() });
  assert.equal(noUrl.steps[0].status, "blocked_by_prerequisite");
});
