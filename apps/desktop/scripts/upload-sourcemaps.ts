// Uploads the main process's source maps from the last `pnpm build` to Sentry's mend-desktop
// project, under the release that build reports (sentry-release.ts), so its stack traces read as
// source. Run it from the same checkout, after the build and before the commit moves:
//   SENTRY_AUTH_TOKEN=… SENTRY_URL=https://sentry.mend.run SENTRY_ORG=sealant \
//     node scripts/upload-sourcemaps.ts
// Without the three variables it says so and uploads nothing. The maps never ship: the build
// writes them hidden and electron-builder.config.ts leaves them out of the package.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { desktopRelease } from "../sentry-release.ts";

const missing = ["SENTRY_AUTH_TOKEN", "SENTRY_URL", "SENTRY_ORG"].filter(
  (name) => (process.env[name] ?? "") === "",
);
if (missing.length > 0) {
  console.log(`Not uploading the desktop source maps: ${missing.join(", ")} not set.`);
  process.exit(0);
}
const main = fileURLToPath(new URL("../out/main/", import.meta.url));
if (!existsSync(main)) {
  console.error("No out/main: run `pnpm build` first.");
  process.exit(1);
}
const release = desktopRelease();
const sentry = (...args: string[]): void => {
  const result = spawnSync("npx", ["--yes", "@sentry/cli@3.8.2", ...args], {
    stdio: "inherit",
    env: { ...process.env, SENTRY_PROJECT: "mend-desktop" },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
sentry("releases", "new", release);
sentry("sourcemaps", "upload", "--release", release, "--url-prefix", "app:///out/main", main);
sentry("releases", "finalize", release);
console.log(`Uploaded the desktop source maps under ${release}.`);
