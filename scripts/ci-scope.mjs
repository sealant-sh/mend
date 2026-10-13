import { execFileSync } from "node:child_process";

// Conservatively gate only the extra mobile-web and packaging jobs. Turbo, PostgreSQL and S3
// contracts still run for every change. Unknown paths and unavailable history run both extras.
const full = { mobile: true, packaging: true };
const args = process.argv.slice(2);
let scope = full;
let reason = "full run requested";
if (args.length === 2 && args.every((sha) => /^[a-f0-9]{40,64}$/i.test(sha))) {
  try {
    const changed = execFileSync(
      "git",
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        `${args[0]}...${args[1]}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const paths = changed.split("\0").filter(Boolean);
    scope = paths.length === 0 ? full : { mobile: false, packaging: false };
    for (const path of paths) {
      // All package changes are deliberately included, including future transitive dependencies.
      // Manifest changes can alter that graph or shared tooling even in otherwise unrelated apps.
      if (
        !path.includes("/") ||
        path.endsWith("/package.json") ||
        path.startsWith("packages/") ||
        path.startsWith("tooling/") ||
        path.startsWith(".github/") ||
        path.startsWith(".claude/") ||
        path.startsWith(".agents/") ||
        path.startsWith("scripts/")
      ) {
        scope = full;
        break;
      }
      if (path.startsWith("apps/mobile/")) {
        scope.mobile = true;
        scope.packaging = true;
      } else if (
        /^(apps\/(api|cli|desktop|t3-gateway|vscode|web|docs|marketing)|deploy)\//.test(path)
      ) {
        scope.packaging = true;
      } else if (!path.startsWith("docs/")) {
        scope = full;
        break;
      }
    }
    reason = `${paths.length} changed paths compared with merge base`;
  } catch {
    scope = full;
    reason = "Git comparison unavailable; running both extras";
  }
} else if (!(args.length === 1 && args[0] === "--all")) {
  reason = "Missing or invalid commit IDs; running both extras";
}
console.error(reason);
console.log(`mobile=${scope.mobile}\npackaging=${scope.packaging}`);
