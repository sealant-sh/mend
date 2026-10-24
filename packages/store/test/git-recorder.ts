import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A `git` first on `PATH` that writes each run's arguments to a log, then runs the real git: how
 * a test sees which git processes Mend started, and how many.
 */
export const recordGit = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-git-recorder-"));
  const log = path.join(dir, "runs.log");
  const realPath = process.env["PATH"] ?? "";
  let real = "git";
  for (const at of realPath.split(path.delimiter)) {
    const candidate = path.join(at, "git");
    if (at !== "" && fs.existsSync(candidate)) {
      real = fs.realpathSync(candidate);
      break;
    }
  }
  fs.writeFileSync(
    path.join(dir, "git"),
    ["#!/bin/sh", `printf '%s\\n' "$*" >> "${log}"`, `exec "${real}" "$@"`, ""].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(log, "");
  process.env["PATH"] = `${dir}${path.delimiter}${realPath}`;
  return {
    /** Every git run since the last `clear`, one argument line each. */
    runs: (): ReadonlyArray<string> => fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
    clear: () => fs.writeFileSync(log, ""),
    remove: () => {
      process.env["PATH"] = realPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};
