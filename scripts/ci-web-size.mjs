import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * What a person's browser downloads before the new web app (`apps/web`) draws a page, read from
 * its production build: the route manifest TanStack Start writes for the server lists, for every
 * route, the scripts the server render tells the browser to load (`preloads`); a page loads its
 * matched routes' lists, root first, plus the app's stylesheet. The entry chunk is the root's
 * first preload. Sizes are the files as built and the `.gz` copies nitro serves beside them.
 *
 * `node scripts/ci-web-size.mjs` prints the sizes and fails when one passes its budget in
 * `apps/web/size-budget.json`. CI runs it in the `static` job after the build, so it measures the
 * build that job already made; a pull request that doesn't affect `@mend/web` has no build and
 * skips it.
 */

export const PAGES = {
  "sign-in": ["__root__", "/login"],
  inbox: ["__root__", "/_inbox", "/_inbox/"],
  session: ["__root__", "/_inbox", "/_inbox/sessions/$sessionId"],
};

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;

/** The files one page loads first, in the manifest's order, without repeats. */
export const pageFiles = (routes, routeIds, stylesheets) => {
  const files = new Set();
  for (const id of routeIds) {
    const route = routes[id];
    if (route === undefined) throw new Error(`The route manifest has no route ${id}.`);
    for (const file of route.preloads ?? []) files.add(file);
  }
  for (const file of stylesheets) files.add(file);
  return [...files];
};

/** Raw and gzip sizes of a file under `public`, gzip from nitro's `.gz` copy when there is one. */
const sizeOf = (publicDir) => (file) => {
  const local = path.join(publicDir, file);
  const raw = statSync(local).size;
  const gz = existsSync(`${local}.gz`)
    ? statSync(`${local}.gz`).size
    : gzipSync(readFileSync(local), { level: 9 }).length;
  return { file, raw, gzip: gz };
};

export const total = (sizes) => ({
  files: sizes.length,
  raw: sizes.reduce((sum, size) => sum + size.raw, 0),
  gzip: sizes.reduce((sum, size) => sum + size.gzip, 0),
});

/** Every budget a measurement passes, as one sentence each; empty when it is within all of them. */
export const overBudget = (measured, budget) => {
  const over = [];
  const check = (what, value, limit) => {
    if (limit !== undefined && value > limit)
      over.push(`${what} is ${kb(value)}, over its budget of ${kb(limit)}.`);
  };
  check("The entry chunk", measured.entry.raw, budget.entry?.raw);
  check("The entry chunk (gzip)", measured.entry.gzip, budget.entry?.gzip);
  for (const [page, limits] of Object.entries(budget.pages ?? {})) {
    const first = measured.pages[page];
    if (first === undefined) {
      over.push(`The budget names a page "${page}" this script doesn't measure.`);
      continue;
    }
    check(`The ${page} page's first load`, first.raw, limits.raw);
    check(`The ${page} page's first load (gzip)`, first.gzip, limits.gzip);
    if (limits.files !== undefined && first.files > limits.files)
      over.push(
        `The ${page} page's first load is ${first.files} files, over its budget of ${limits.files}.`,
      );
  }
  return over;
};

const manifestRoutes = async (outputDir) => {
  const serverDir = path.join(outputDir, "server");
  const name = readdirSync(serverDir).find((file) =>
    /^_tanstack-start-manifest_v-.*\.mjs$/.test(file),
  );
  if (name === undefined) throw new Error(`No route manifest in ${serverDir}.`);
  const { tsrStartManifest } = await import(pathToFileURL(path.join(serverDir, name)).href);
  return tsrStartManifest().routes;
};

export const measure = async (outputDir) => {
  const publicDir = path.join(outputDir, "public");
  const routes = await manifestRoutes(outputDir);
  const stylesheets = readdirSync(path.join(publicDir, "assets"))
    .filter((file) => /^styles-.*\.css$/.test(file))
    .map((file) => `/assets/${file}`);
  const size = sizeOf(publicDir);
  const entryFile = routes.__root__?.preloads?.[0];
  if (entryFile === undefined) throw new Error("The root route preloads nothing.");
  const pages = Object.fromEntries(
    Object.entries(PAGES).map(([page, ids]) => [
      page,
      total(pageFiles(routes, ids, stylesheets).map(size)),
    ]),
  );
  return { entry: size(entryFile), pages };
};

const main = async () => {
  const root = path.resolve(import.meta.dirname, "..");
  // `--output <dir>` measures another build the same way (the old app's, for a comparison).
  const at = process.argv.indexOf("--output");
  const outputDir =
    at === -1 ? path.join(root, "apps/web/.output") : path.resolve(process.argv[at + 1] ?? "");
  if (!existsSync(outputDir)) {
    console.log("apps/web has no build here (this change doesn't affect it): nothing to measure.");
    return;
  }
  const budget = JSON.parse(readFileSync(path.join(root, "apps/web/size-budget.json"), "utf8"));
  const measured = await measure(outputDir);
  console.log(
    `entry chunk ${measured.entry.file}: ${kb(measured.entry.raw)}, ${kb(measured.entry.gzip)} gzip`,
  );
  for (const [page, first] of Object.entries(measured.pages))
    console.log(
      `${page} first load: ${first.files} files, ${kb(first.raw)}, ${kb(first.gzip)} gzip`,
    );
  if (process.argv.includes("--json")) console.log(JSON.stringify(measured));
  const over = overBudget(measured, budget);
  if (over.length === 0) return;
  for (const sentence of over) console.log(`::error::${sentence}`);
  console.log(
    "If the growth is on purpose, raise the number in apps/web/size-budget.json in the same pull request and say why in its body.",
  );
  process.exitCode = 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
