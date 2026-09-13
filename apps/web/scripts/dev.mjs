// The one-command dev loop: fills in env from the root .env, makes sure the
// dev Postgres is up, then runs the vite dev server (the app) and the Effect
// server (API + auth + dispatcher) side by side; either one dying takes both
// down.
import { spawn, spawnSync } from "node:child_process";
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

// Without a Sealant target the server boots fine but every session launch
// dies against the SDK's localhost:8080 default — say so before it happens.
if (!process.env.SEALANT_BASE_URL) {
  console.warn(
    "[dev] SEALANT_BASE_URL is not set — session launches and inference will fail.\n" +
      "[dev] Copy .env.example to .env at the repo root (see DEVELOPMENT.md §Environment).",
  );
}

// The dev Postgres (compose.dev.yaml), idempotent and healthcheck-gated. A
// custom DATABASE_URL means the operator brought their own database — leave
// Docker alone in that case.
const databaseUrl = process.env.DATABASE_URL ?? "postgres://mend:mend@localhost:5434/mend";
if (databaseUrl.includes("localhost:5434")) {
  const compose = spawnSync(
    "docker",
    ["compose", "-f", path.join(repoRoot, "compose.dev.yaml"), "up", "-d", "--wait"],
    { stdio: "inherit" },
  );
  if (compose.status !== 0) {
    console.warn(
      "[dev] could not start the dev Postgres — continuing, but the server will fail if the database is unreachable",
    );
  } else if (process.env.MEND_SESSION_STORE === "captured") {
    // The capture store's dev bucket (ADR-0002): lay the single Garage node out and create the
    // `mend` bucket + key once; idempotent, so every dev loop may run it.
    const init = spawnSync("sh", [path.join(repoRoot, "deploy", "dev", "garage-init.sh")], {
      stdio: "inherit",
    });
    if (init.status !== 0) {
      console.warn("[dev] garage-init failed — the capture store has no bucket to write to");
    }
  }
}

// --strictPort: a taken 3105 means another dev loop is already running —
// fail loudly (taking the server down with us) instead of hopping ports
// while the API server crash-waits on 3101 behind it.
const children = [
  spawn("pnpm", ["exec", "vite", "dev", "--strictPort"], { stdio: "inherit" }),
  spawn("pnpm", ["--filter", "@mend/api-server", "exec", "tsx", "watch", "src/main.ts"], {
    stdio: "inherit",
    cwd: repoRoot,
  }),
  // /trpc is a Start server route — vite dev serves it; no third process.
];

const stop = (code) => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code ?? 0);
};

for (const child of children) child.on("exit", (code) => stop(code));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
