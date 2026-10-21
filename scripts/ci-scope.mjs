import { execFileSync } from "node:child_process";

// Conservatively gate only the extra mobile-web, packaging and store-image-git jobs. Turbo,
// PostgreSQL and S3 contracts still run for every change. Unknown paths and unavailable history
// run every extra. A merge group (--merge-group BASE HEAD) also prints graph=affected|full for its
// Turbo lanes.
const full = { mobile: true, packaging: true, store: true };
const sha = /^[a-f0-9]{40,64}$/i;

const changedPaths = (base, head) =>
  execFileSync(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      `${base}...${head}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .split("\0")
    .filter(Boolean);

// A package's tests and their helpers: its test/ directory, or a *.test.* / *.spec.* source
// file. The mobile and packaging lanes may skip them because each deletes exactly these files
// before any lane step (scripts/remove-package-tests.mjs), so a lane that needs one fails;
// scripts/test-only-imports.test.mjs is an earlier, partial warning.
export const testOnly = (path) =>
  !path.includes("\n") &&
  !path.endsWith("/package.json") &&
  /^packages\/[^/]+\/(test\/|(.+\/)?[^/]+\.(test|spec)\.[cm]?[jt]sx?$)/.test(path);

const extras = (paths) => {
  if (paths.length === 0) return full;
  const scope = { mobile: false, packaging: false, store: false };
  for (const path of paths) {
    if (path.includes("\n")) return full;
    // store-image-git runs the store's tests, so their own changes select it.
    if (path.startsWith("packages/store/")) scope.store = true;
    if (testOnly(path)) continue;
    // Manifest changes can alter the package graph or shared tooling even in unrelated apps.
    if (
      !path.includes("/") ||
      path.endsWith("/package.json") ||
      path.startsWith("tooling/") ||
      path.startsWith(".github/") ||
      path.startsWith(".claude/") ||
      path.startsWith(".agents/") ||
      path.startsWith("scripts/")
    ) {
      return full;
    }
    if (path.startsWith("packages/")) {
      // Every package change runs both lanes, future transitive dependencies included.
      scope.mobile = true;
      scope.packaging = true;
      // @mend/domain is the one workspace package the store imports at run time.
      if (path.startsWith("packages/domain/")) scope.store = true;
    } else if (path.startsWith("apps/mobile/")) {
      scope.mobile = true;
      scope.packaging = true;
    } else if (
      /^(apps\/(api|cli|desktop|t3-gateway|vscode|web|docs|marketing)|deploy)\//.test(path)
    ) {
      scope.packaging = true;
    } else if (!path.startsWith("docs/")) {
      return full;
    }
  }
  return scope;
};

/**
 * Whether a merge group may run only what its pull requests affect. Turbo follows the package
 * graph from changed files; anything it cannot attribute to one workspace package runs the full
 * graph: a root file, any turbo.json, the workflows, and every path outside apps|packages|tooling
 * except changesets, which only versioning reads, and root docs/, which no Turbo task reads
 * (format:check, its one reader, runs on every event) (docs/operations/merge-queue.md).
 */
export const queueGraph = (paths) =>
  paths.length > 0 &&
  paths.every(
    (path) =>
      path.startsWith(".changeset/") ||
      path.startsWith("docs/") ||
      (/^(apps|packages|tooling)\/[^/]+\//.test(path) && !path.endsWith("turbo.json")),
  )
    ? "affected"
    : "full";

const main = () => {
  const args = process.argv.slice(2);
  const queue = args[0] === "--merge-group";
  const ids = queue ? args.slice(1) : args;
  let scope = full;
  let graph = "full";
  let reason = "full run requested";
  if (ids.length === 2 && ids.every((id) => sha.test(id))) {
    try {
      const paths = changedPaths(ids[0], ids[1]);
      scope = extras(paths);
      graph = queueGraph(paths);
      reason = `${paths.length} changed paths compared with merge base`;
    } catch {
      scope = full;
      graph = "full";
      reason = "Git comparison unavailable; running every extra";
    }
  } else if (!(args.length === 1 && args[0] === "--all")) {
    reason = "Missing or invalid commit IDs; running every extra";
  }
  console.error(queue ? `${reason}; Turbo graph: ${graph}` : reason);
  console.log(`mobile=${scope.mobile}\npackaging=${scope.packaging}\nstore=${scope.store}`);
  if (queue) console.log(`graph=${graph}`);
};

if (import.meta.main) main();
