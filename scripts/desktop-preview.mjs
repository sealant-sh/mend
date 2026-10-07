// Local acceptance fixture only. Production desktop processes use Mend's public SDK Service path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = "mend-desktop-pilot-preview";
const command = process.argv[2] ?? "start";
const docker = (args) => {
  const result = spawnSync("docker", args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (command === "stop") {
  docker(["stop", name]);
  process.exit(0);
}
if (command !== "start") throw new Error("Use desktop-preview.mjs start or stop");
if (process.arch !== "x64") throw new Error("This desktop experiment supports x86_64 only");
if (process.argv.includes("--build"))
  docker([
    "build",
    "--platform",
    "linux/amd64",
    "-f",
    "deploy/desktop/Dockerfile",
    "-t",
    "mend-desktop:pilot-v4",
    ".",
  ]);
const existing = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
if (existing.status === 0) {
  if (existing.stdout.trim() !== "true") docker(["start", name]);
} else {
  const artifacts = join(homedir(), ".local/share/mend/desktop-preview");
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const credentials = [
    [join(homedir(), ".claude/.credentials.json"), "/home/node/.claude/.credentials.json"],
    [join(homedir(), ".codex/auth.json"), "/home/node/.codex/auth.json"],
  ]
    .filter(([path]) => existsSync(path))
    .flatMap(([path, target]) => ["--mount", `type=bind,src=${path},dst=${target},readonly`]);
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "dev.sealant.mend.fixture=desktop-pilot",
    "--user",
    "1000:1000",
    "-e",
    "HOME=/home/node",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--shm-size=512m",
    "--memory=3g",
    "--cpus=4",
    "-p",
    "127.0.0.1:6090:6090",
    "--tmpfs",
    "/home/node/.claude:uid=1000,gid=1000,mode=700",
    "--tmpfs",
    "/home/node/.codex:uid=1000,gid=1000,mode=700",
    "--mount",
    `type=bind,src=${artifacts},dst=/home/node/.mend/desktop`,
    "--mount",
    `type=bind,src=${join(root, "deploy/desktop")},dst=/opt/mend-desktop,readonly`,
    ...credentials,
    "mend-desktop:pilot-v4",
  ]);
}
console.log("Desktop fixture: http://127.0.0.1:6090/state");
console.log("Web: MEND_DESKTOP_PREVIEW_URL=http://127.0.0.1:6090 pnpm --filter @mend/web dev");
console.log("Open http://localhost:3105/desktop-experiment");
