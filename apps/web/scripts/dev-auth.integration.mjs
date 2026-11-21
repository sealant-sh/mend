import assert from "node:assert/strict";
import { test } from "node:test";

// Run against `pnpm dev`: node --test apps/web/scripts/dev-auth.integration.mjs
// Empty bodies exercise the real auth routes without creating accounts or sessions.
const origin = (() => {
  try {
    return new URL(process.env.MEND_DEV_TEST_URL ?? "http://localhost:3105").origin;
  } catch {
    throw new Error("MEND_DEV_TEST_URL must be an absolute URL for the running dev server.");
  }
})();

for (const endpoint of ["sign-up/email", "sign-in/email"]) {
  test(`dev proxy forwards ${endpoint} to auth validation`, async () => {
    const response = await fetch(`${origin}/api/auth/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 400, "Expected auth validation, not the app's HTML 404");
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const result = await response.json();
    assert.equal(result.code, "VALIDATION_ERROR");
  });
}

test("dev proxy forwards anonymous session reads", async () => {
  const response = await fetch(`${origin}/api/auth/get-session`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(await response.json(), null);
});
