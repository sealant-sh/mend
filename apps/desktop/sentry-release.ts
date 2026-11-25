import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The Sentry release a desktop build reports under, and its main-process source maps are uploaded
 * under (SLNT-1357): `SENTRY_RELEASE` when the build is given one, else
 * `mend-desktop@<version>+<commit>`. The app's version stays 0.0.0 between releases, so the commit
 * is what tells two builds apart.
 */
export const desktopRelease = (): string => {
  const given = process.env["SENTRY_RELEASE"]?.trim() ?? "";
  if (given !== "") return given;
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  );
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? String(manifest.version)
      : "0.0.0";
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
    }).trim();
  } catch {
    // Built outside a checkout: the release still names the version.
  }
  return `mend-desktop@${version}+${commit}`;
};
