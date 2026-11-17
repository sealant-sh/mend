// The new app's dev loop: its vite server alone, on 3115, against the Mend API `pnpm dev` already
// runs on 3101 for the old app. It fills in env from the root .env the way the old loop does.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Root .env fills in whatever the shell didn't set — explicit env always wins.
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) {
    process.env[key] ??= value;
  }
}

const port = process.env.PORT ?? "3115";
const origin = `http://localhost:${port}`;

// The API refuses a signed-in call from an origin it was not told about, and the browser's calls
// carry this app's. The API reads the same root .env, so one line there covers both servers.
let allowed = [];
try {
  allowed = JSON.parse(process.env.MEND_ALLOWED_ORIGINS ?? "[]");
} catch {
  // Reported below as not listed.
}
if (!Array.isArray(allowed) || !allowed.includes(origin)) {
  console.warn(
    `[web] MEND_ALLOWED_ORIGINS does not list ${origin}, so the API will refuse this app's calls.\n` +
      `[web] Add it in the root .env, for example MEND_ALLOWED_ORIGINS='["${origin}"]', then restart pnpm dev.`,
  );
}

// --strictPort: a taken port means another dev loop of this app is already running.
const child = spawn("pnpm", ["exec", "vite", "dev", "--strictPort", "--port", port], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill("SIGTERM"));
