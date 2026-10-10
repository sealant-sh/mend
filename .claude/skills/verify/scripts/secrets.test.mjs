import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FAKE_FORMS, FAKES } from "./fakes.mjs";
import { loadSecrets, register } from "./secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const privateDir = () => mkdtempSync(join(tmpdir(), "verify-secrets-"));

/** A private directory and an evidence directory; `scan` runs the Cleanup scan over them. */
const run = (body) => {
  const root = mkdtempSync(join(tmpdir(), "verify-scan-"));
  const P = join(root, "private");
  const E = join(root, "evidence");
  mkdirSync(P, { mode: 0o700 });
  mkdirSync(E);
  const scan = (...extra) =>
    spawnSync(
      process.execPath,
      [join(here, "scan-evidence.mjs"), "--dir", E, "--secrets", P, ...extra],
      { encoding: "utf8" },
    );
  try {
    body({ P, E, scan });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** A Playwright storage state: one session cookie, and the page's localStorage items. */
const browserState = (cookie, items) =>
  JSON.stringify({
    cookies: [{ name: "better-auth.session_token", value: cookie, domain: "localhost", path: "/" }],
    origins: [
      {
        origin: "http://localhost:3345",
        localStorage: Object.entries(items).map(([name, value]) => ({ name, value })),
      },
    ],
  });

const PROJECT_ID = "157afbc2-6d1e-4b7a-9c3f-2a8e5d0b1c94";
const PROJECT = "st-verify-1010-1939-1a81-b3";
const COOKIE = "Hq7Zp2Lx9Vb4Nm8Kt3Rw6Ys1.Fj5Gd0Ce";

test("a broken link under the private directory is skipped, not fatal", () => {
  const dir = privateDir();
  try {
    writeFileSync(join(dir, "account.json"), JSON.stringify({ token: "tok_0123456789abcdef" }));
    symlinkSync(join(dir, "gone"), join(dir, "SingletonCookie"));
    const secrets = loadSecrets(dir);
    assert.ok(secrets.has("tok_0123456789abcdef"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a browser state's bare UUID is not a secret; its cookie is", () => {
  const dir = privateDir();
  try {
    const id = "685dd0cd-41ef-484a-a4d8-f536d08bef89";
    writeFileSync(
      join(dir, "browser.json"),
      JSON.stringify({
        cookies: [{ name: "session", value: "cookie-value-0123456789" }],
        origins: [{ localStorage: [{ name: "mend.lastProject", value: id }] }],
      }),
    );
    const secrets = loadSecrets(dir);
    assert.ok(secrets.has("cookie-value-0123456789"));
    assert.ok(!secrets.has(id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// H5: the RC 754 drive's Cleanup deleted 101 files over a composer's saved project and a driver's
// fake Codex login. App state and ids are not secrets; credentials and the run's own values are.
test("a page's saved preferences and project id are not secrets: the scan keeps evidence that names them", () => {
  run(({ P, E, scan }) => {
    writeFileSync(
      join(P, "browser.json"),
      browserState(COOKIE, {
        "mend-composer-prefs": JSON.stringify({
          projectId: PROJECT_ID,
          project: PROJECT,
          harness: "codex",
          model: "gpt-6.1-sol",
          effort: "high",
        }),
        "mend-theme": "dark",
        "mend-worktrees-view": "list",
        "mend.lastProject": PROJECT_ID,
      }),
    );
    const secrets = loadSecrets(P);
    for (const value of [PROJECT_ID, PROJECT, "gpt-6.1-sol"])
      assert.ok(![...secrets.keys()].some((form) => form.includes(value)), `${value} registered`);
    assert.ok(secrets.has(COOKIE), "the session cookie is a secret");
    mkdirSync(join(E, "appearance", "web"), { recursive: true });
    writeFileSync(
      join(E, "appearance", "web", "01-light.aria.yml"),
      `- link "${PROJECT}":\n    - /url: /projects/${PROJECT_ID}/sessions\n`,
    );
    const result = scan("--delete-hits");
    assert.equal(result.status, 0, result.stdout);
    assert.ok(existsSync(join(E, "appearance", "web", "01-light.aria.yml")));
  });
});

test("the skill's fake logins are not hits, registered or not, as values or as shapes", () => {
  run(({ P, E, scan }) => {
    register(P, "codex-auth", FAKES.codexAuth);
    register(P, "github-fake", FAKES.github);
    register(P, "claude-fake", FAKES.claude);
    writeFileSync(join(P, "codex-auth.json"), FAKES.codexAuth);
    writeFileSync(join(E, "auth.json"), FAKES.codexAuth);
    writeFileSync(
      join(E, "connect.stdout"),
      [
        `pasted ${FAKES.github}`,
        `token ${FAKES.claude}`,
        "codex    connected · mend-verify-fake-account · since 2026-10-10",
        `{"access_token":"${JSON.parse(FAKES.codexAuth).tokens.access_token}"}`,
      ].join("\n"),
    );
    const result = scan();
    assert.equal(result.status, 0, result.stdout);
  });
  // Every form names itself a fake, so taking fakes out never takes out other text.
  for (const form of FAKE_FORMS) assert.match(form, /mendVerifyFake/);
});

test("the scan stays strict: cookies, stored tokens, snake_case logins and real shapes are hits", () => {
  run(({ P, E, scan }) => {
    const deviceToken = "mdt_Q7xZ2pL9vB4nM8kT3rW6yS1fJ5";
    const bareCookie = "0d6f3c1e-9a7b-4e2d-8c5f-1b3a9e7d2c40";
    const opaque = "q8Rt5Lm2Np7Xv4Zw9Ab3Cd6E";
    const named = "plain-words-but-a-token";
    writeFileSync(
      join(P, "browser.json"),
      browserState(bareCookie, {
        "mend-config": JSON.stringify({ url: "http://127.0.0.1:18305", token: deviceToken }),
        "mend-cache": opaque,
        "auth-token": named,
      }),
    );
    // A real-shaped Codex auth.json, kept under its own name: its snake_case tokens count.
    const access = "Xk4Rp8Lm2Qv7Nz3Wb9Tc5Yd1";
    const refresh = "rt_Hm6Jq2Zp8Kx4Vb9Lc3Nd7";
    writeFileSync(
      join(P, "codex-auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: { access_token: access, refresh_token: refresh, account_id: "acct-real-0001" },
      }),
    );
    const secrets = loadSecrets(P);
    for (const value of [deviceToken, bareCookie, opaque, named, access, refresh])
      assert.ok(secrets.has(value), `${value.slice(0, 6)}… is not registered`);
    assert.ok(!secrets.has("acct-real-0001"), "an account id is not a credential");
    const leaks = {
      "device.txt": `stored ${deviceToken}`,
      "cookie.txt": `cookie ${bareCookie}`,
      "opaque.txt": `cache ${opaque}`,
      "named.txt": `item ${named}`,
      "access.txt": `codex ${access}`,
      "refresh.txt": `codex ${refresh}`,
      // A GitHub token that is not the fake, beside the fake: the shape still finds it.
      "github.txt": `${FAKES.github} and ghp_R8kL2mN7qP4xZ9vB3tW6yH1jF5dS0aC8eG2`,
      // A fake changed by one character is not the fake.
      "near-fake.txt": FAKES.claude.replace("mendVerifyFake", "mendVerifyFakf"),
    };
    for (const [file, text] of Object.entries(leaks)) writeFileSync(join(E, file), text);
    const result = scan("--delete-hits");
    assert.equal(result.status, 1, result.stdout);
    for (const file of Object.keys(leaks)) {
      assert.match(
        result.stdout,
        new RegExp(`${file.replace(".", "\\.")} · `),
        `${file} not a hit`,
      );
      assert.ok(!existsSync(join(E, file)), `${file} was kept`);
    }
    for (const value of [deviceToken, opaque, access])
      assert.ok(!`${result.stdout}${result.stderr}`.includes(value), "the scan printed a value");
  });
});
