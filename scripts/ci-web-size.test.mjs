import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { measure, overBudget, pageFiles } from "./ci-web-size.mjs";

/** A build's output as TanStack Start and nitro lay it out, with the files given. */
const build = (t, routes, files) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-web-size-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "server"));
  mkdirSync(path.join(dir, "public/assets"), { recursive: true });
  writeFileSync(
    path.join(dir, "server/_tanstack-start-manifest_v-abc.mjs"),
    `export const tsrStartManifest = () => (${JSON.stringify({ routes })});\n`,
  );
  for (const [name, { raw, gz }] of Object.entries(files)) {
    writeFileSync(path.join(dir, "public/assets", name), "x".repeat(raw));
    if (gz !== undefined)
      writeFileSync(path.join(dir, "public/assets", `${name}.gz`), "x".repeat(gz));
  }
  return dir;
};

const ROUTES = {
  __root__: { preloads: ["/assets/index-a.js", "/assets/shared-b.js"] },
  "/login": { preloads: ["/assets/login-c.js", "/assets/shared-b.js"] },
  "/_inbox": { preloads: ["/assets/inbox-d.js"] },
  "/_inbox/": { preloads: [] },
  "/_inbox/sessions/$sessionId": { preloads: ["/assets/session-e.js"] },
};

test("a page loads its matched routes' scripts once each, and the stylesheet", () => {
  assert.deepEqual(pageFiles(ROUTES, ["__root__", "/login"], ["/assets/styles-f.css"]), [
    "/assets/index-a.js",
    "/assets/shared-b.js",
    "/assets/login-c.js",
    "/assets/styles-f.css",
  ]);
  assert.throws(() => pageFiles(ROUTES, ["/gone"], []), /no route \/gone/);
});

test("it measures the entry chunk and each page from the build's own files", async (t) => {
  const dir = build(t, ROUTES, {
    "index-a.js": { raw: 1000, gz: 300 },
    "shared-b.js": { raw: 200, gz: 50 },
    "login-c.js": { raw: 100, gz: 40 },
    "inbox-d.js": { raw: 400, gz: 90 },
    "session-e.js": { raw: 500, gz: 100 },
    "styles-f.css": { raw: 80, gz: 20 },
    "lazy-view-g.js": { raw: 9000, gz: 3000 },
  });
  const measured = await measure(dir);
  assert.deepEqual(measured.entry, {
    file: "/assets/index-a.js",
    raw: 1000,
    gzip: 300,
  });
  assert.deepEqual(measured.pages["sign-in"], {
    files: 4,
    raw: 1380,
    gzip: 410,
  });
  // A view's chunk no route preloads is not on any page's first load.
  assert.deepEqual(measured.pages.inbox, { files: 4, raw: 1680, gzip: 460 });
  assert.deepEqual(measured.pages.session, { files: 5, raw: 2180, gzip: 560 });
});

test("a file without a .gz copy is gzipped to count it", async (t) => {
  const dir = build(
    t,
    { ...ROUTES, __root__: { preloads: ["/assets/index-a.js"] } },
    {
      "index-a.js": { raw: 1000 },
      "shared-b.js": { raw: 1, gz: 1 },
      "login-c.js": { raw: 1, gz: 1 },
      "inbox-d.js": { raw: 1, gz: 1 },
      "session-e.js": { raw: 1, gz: 1 },
    },
  );
  const { entry } = await measure(dir);
  assert.equal(entry.raw, 1000);
  assert.ok(entry.gzip > 0 && entry.gzip < 100, `${entry.gzip}`);
});

test("it names every budget a build passes, and nothing within them", () => {
  const measured = {
    entry: { file: "/assets/index-a.js", raw: 1000, gzip: 300 },
    pages: { "sign-in": { files: 4, raw: 1380, gzip: 410 } },
  };
  assert.deepEqual(
    overBudget(measured, {
      entry: { raw: 1000, gzip: 300 },
      pages: { "sign-in": { raw: 1380 } },
    }),
    [],
  );
  assert.deepEqual(
    overBudget(measured, {
      entry: { raw: 999 },
      pages: { "sign-in": { gzip: 400, files: 3 }, settings: { raw: 1 } },
    }),
    [
      "The entry chunk is 1.0 KB, over its budget of 1.0 KB.",
      "The sign-in page's first load (gzip) is 0.4 KB, over its budget of 0.4 KB.",
      "The sign-in page's first load is 4 files, over its budget of 3.",
      'The budget names a page "settings" this script doesn\'t measure.',
    ],
  );
});

test("the committed budget names only what the script measures", () => {
  const budget = JSON.parse(
    readFileSync(new URL("../apps/web/size-budget.json", import.meta.url), "utf8"),
  );
  assert.ok(budget.entry.raw > 0 && budget.entry.gzip > 0);
  assert.ok(budget.pages["sign-in"].raw > 0 && budget.pages["sign-in"].gzip > 0);
  const nothing = { file: "", raw: 0, gzip: 0 };
  const zero = { files: 0, raw: 0, gzip: 0 };
  assert.deepEqual(
    overBudget(
      {
        entry: nothing,
        pages: { "sign-in": zero, inbox: zero, session: zero },
      },
      budget,
    ),
    [],
  );
});
