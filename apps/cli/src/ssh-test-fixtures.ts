import { spawn } from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The CLI from source, as a person runs it, against a fake Mend server; shared by the ssh suites. */
export const runMend = async (home: string, url: string, args: ReadonlyArray<string>) => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(new URL("./main.ts", import.meta.url)), ...args],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        // Reuse compilation across this fixture's CLI processes; HOME cleanup removes the cache.
        NODE_COMPILE_CACHE: path.join(home, ".compile-cache"),
        MEND_URL: url,
        MEND_TOKEN: "test-token",
        SSH_AUTH_SOCK: "",
        SSH_ASKPASS_REQUIRE: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
};

export const runSshCommand = (home: string, url: string, args: ReadonlyArray<string>) =>
  runMend(home, url, ["ssh", ...args]);
