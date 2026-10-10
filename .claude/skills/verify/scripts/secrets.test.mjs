import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadSecrets } from "./secrets.mjs";

const privateDir = () => mkdtempSync(join(tmpdir(), "verify-secrets-"));

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
