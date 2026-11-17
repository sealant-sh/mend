import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readCoverages, touches } from "./formal-coverage.mjs";

// Conservatively gate only the extra mobile-web, packaging, store-image-git, formal, docker-suites,
// preview-acceptance and vscode-e2e jobs. Turbo,
// PostgreSQL and S3 contracts still run for every change. Unknown paths and unavailable history
// run every extra.
export const full = {
  mobile: true,
  packaging: true,
  store: true,
  formal: true,
  docker: true,
  preview: true,
  vscode: true,
};
// The formal lane runs a model when a change reaches what its docs/formal/<area>/COVERAGE names.
const coverages = readCoverages(fileURLToPath(new URL("../", import.meta.url)));
const sha = /^[a-f0-9]{40,64}$/i;
// The code the Docker-engine suites drive (scripts/docker-suites.mjs), and the suites themselves.
const dockerSuites = [
  /^apps\/cli\/src\/server-(docker-volumes|runtime|setup|store)\.ts$/,
  /^apps\/cli\/src\/server-(docker-protocol|postgres-bootstrap)\.test\.ts$/,
  /^packages\/sessions\/src\/(rollback-files|pickup-tickets|workspace-files|session-channel)\.ts$/,
  /^packages\/sessions\/test\/(rollback-mounted-layout\.test|rollback-restore-crash\.property\.test|pickup-channel|support\/rollback-files)\.ts$/,
];
// The preview gateway, its edges, and the acceptance suite that drives them in real browsers.
const previewAcceptance = [
  /^apps\/api\/src\/preview-[^/]+\.ts$/,
  /^apps\/api\/test\/(preview-[^/]+|support\/preview-[^/]+|fixtures\/preview\/.+)$/,
  /^apps\/api\/vitest\.preview\.config\.ts$/,
  /^apps\/cli\/src\/server-edge\.ts$/,
  /^apps\/cli\/test-fixtures\/packaged-edge\.ts$/,
  /^deploy\/docker\/Caddyfile$/,
];
// The VS Code extension, which the real-host acceptance (scripts/vscode-remote-acceptance.mjs)
// drives in a real VS Code over Remote-SSH. The scripts themselves select every extra.
const vscodeAcceptance = /^apps\/vscode\//;

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

export const extras = (paths) => {
  if (paths.length === 0) return full;
  const scope = {
    mobile: false,
    packaging: false,
    store: false,
    formal: false,
    docker: false,
    preview: false,
    vscode: false,
  };
  for (const path of paths) {
    if (path.includes("\n")) return full;
    if (coverages.some((coverage) => touches(coverage, path))) scope.formal = true;
    // store-image-git runs the store's tests, so their own changes select it.
    if (path.startsWith("packages/store/")) scope.store = true;
    if (dockerSuites.some((pattern) => pattern.test(path))) scope.docker = true;
    if (previewAcceptance.some((pattern) => pattern.test(path))) scope.preview = true;
    if (vscodeAcceptance.test(path)) scope.vscode = true;
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
      /^(apps\/(api|cli|desktop|t3-gateway|vscode|web-old|docs|marketing)|deploy)\//.test(path)
    ) {
      scope.packaging = true;
    } else if (!path.startsWith("docs/")) {
      return full;
    }
  }
  return scope;
};

const main = () => {
  const args = process.argv.slice(2);
  let scope = full;
  let reason = "full run requested";
  if (args.length === 2 && args.every((id) => sha.test(id))) {
    try {
      const paths = changedPaths(args[0], args[1]);
      scope = extras(paths);
      reason = `${paths.length} changed paths compared with merge base`;
    } catch {
      scope = full;
      reason = "Git comparison unavailable; running every extra";
    }
  } else if (!(args.length === 1 && args[0] === "--all")) {
    reason = "Missing or invalid commit IDs; running every extra";
  }
  console.error(reason);
  console.log(
    `mobile=${scope.mobile}\npackaging=${scope.packaging}\nstore=${scope.store}\nformal=${scope.formal}\ndocker=${scope.docker}\npreview=${scope.preview}\nvscode=${scope.vscode}`,
  );
};

if (import.meta.main) main();
