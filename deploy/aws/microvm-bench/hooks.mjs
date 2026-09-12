// Slice 0 bench worker for the Mend AWS MicroVM POC.
//
// Two HTTP servers:
//   :9000  Lambda MicroVM lifecycle hooks, POST /aws/lambda-microvms/runtime/v1/<hook>
//   :8080  the VM endpoint: GET /health, GET /results, POST /bench, POST /transfer
//
// A run payload of { "probe": true } skips the FSx mount; the R1 transfer bench
// runs that way and receives its presigned URLs over POST /transfer afterwards
// (they never appear in the run payload or the hook log).
//
// /run receives { microvmId, runHookPayload: "<json>" }. The payload names the
// FSx export to mount and, optionally, a bench to run right away:
//   { "fsx": { "dns": "fs-….fsx.eu-central-1.amazonaws.com", "path": "/fsx/mend" },
//     "mountPoint": "/mend", "bench": { "repo": "https://…", "runs": 3 } }
//
// The invariant from the plan: the VM is not READY until FSx is mounted and
// validated. A mount failure answers /run with 500, which fails the VM start.
// There is no fallback to local disk.

import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";

const run = promisify(execFile);
const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";
const HOOK_PORT = Number(process.env.HOOK_PORT ?? 9000);
const APP_PORT = Number(process.env.APP_PORT ?? 8080);
const MOUNT_OPTS =
  process.env.NFS_MOUNT_OPTS ?? "nfsvers=4.1,nconnect=8,rsize=1048576,wsize=1048576,timeo=600,hard";

const state = {
  microvmId: null,
  payload: null,
  mount: null, // { dns, path, mountPoint, mountedAt }
  bench: null, // last bench result
  benchRunning: false,
  log: [],
};

function log(line) {
  const entry = `${new Date().toISOString()} ${line}`;
  state.log.push(entry);
  if (state.log.length > 500) state.log.shift();
  console.log(entry);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

async function isMounted(mountPoint) {
  const info = await readFile("/proc/self/mountinfo", "utf8");
  return info.split("\n").some((l) => l.split(" ")[4] === mountPoint);
}

async function mountFsx({ dns, path }, mountPoint) {
  await mkdir(mountPoint, { recursive: true });
  if (await isMounted(mountPoint)) {
    log(`mount: ${mountPoint} already mounted`);
  } else {
    const source = `${dns}:${path}`;
    log(`mount: ${source} -> ${mountPoint} (${MOUNT_OPTS})`);
    try {
      await run("mount", ["-t", "nfs", "-o", MOUNT_OPTS, source, mountPoint]);
    } catch (err) {
      log(`mount: failed: ${(err.stderr ?? err.message).trim()}`);
      log(`mount: diag ${JSON.stringify(await diagnostics())}`);
      throw err;
    }
  }
  // Validate: it is a mountpoint, and it is writable by us (all_squash → anonuid).
  if (!(await isMounted(mountPoint)))
    throw new Error(`${mountPoint} is not a mountpoint after mount`);
  const probe = `${mountPoint}/.mend-probe-${process.pid}`;
  await writeFile(probe, "ok\n");
  // The owner the server reports for a file we just wrote shows whether the
  // export's all_squash/anonuid mapping is in effect (expect uid 1000).
  const st = await stat(probe);
  await run("rm", ["-f", probe]);
  log(
    `mount: validated ${mountPoint}; new file owner uid=${st.uid} gid=${st.gid} (squash ${st.uid === 1000 ? "active" : "NOT active"})`,
  );
  state.mount = { dns, path, mountPoint, mountedAt: new Date().toISOString() };
}

async function sh(cmd, timeout = 60000) {
  try {
    const { stdout, stderr } = await run("bash", ["-lc", cmd], { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

async function diagnostics() {
  const out = {};
  for (const [k, c] of Object.entries({
    id: "id",
    caps: "grep -E 'Cap(Eff|Bnd|Prm)' /proc/self/status",
    filesystems: "grep -E 'nfs|fuse|overlay' /proc/filesystems || true",
    kernel: "uname -a",
    modules: "ls /lib/modules 2>/dev/null; cat /proc/modules 2>/dev/null | head -5",
    dmesg: "dmesg 2>&1 | tail -5",
  })) {
    const r = await sh(c, 10000);
    out[k] = (r.stdout + r.stderr).trim().slice(0, 800);
  }
  return out;
}

async function runBench(spec) {
  if (state.benchRunning) throw new Error("bench already running");
  state.benchRunning = true;
  try {
    const args = ["/opt/bench/bench.sh"];
    const env = {
      ...process.env,
      BENCH_REPO: spec.repo ?? "https://github.com/sealant-sh/mend.git",
      BENCH_RUNS: String(spec.runs ?? 3),
      BENCH_FSX_ROOT: state.mount ? state.mount.mountPoint : "",
      BENCH_LOCAL_ROOT: "/var/tmp/bench-local",
      BENCH_INSTALL: spec.install ? "1" : "0",
      BENCH_ID: `${state.microvmId ?? "local"}-${Date.now()}`,
    };
    log(
      `bench: start ${JSON.stringify({ repo: env.BENCH_REPO, runs: env.BENCH_RUNS, install: env.BENCH_INSTALL })}`,
    );
    const { stdout, stderr } = await run("bash", args, {
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60 * 60 * 1000,
    });
    const result = JSON.parse(stdout);
    result.stderrTail = stderr.split("\n").slice(-40).join("\n");
    state.bench = result;
    if (state.mount) {
      const dir = `${state.mount.mountPoint}/_bench`;
      await mkdir(dir, { recursive: true });
      await writeFile(`${dir}/${env.BENCH_ID}.json`, JSON.stringify(result, null, 2));
    }
    log(`bench: done, ${Object.keys(result.results ?? {}).length} measurements`);
    return result;
  } catch (err) {
    log(`bench: failed ${err.message}`);
    state.bench = { error: err.message, stderr: err.stderr?.slice(-4000) };
    throw err;
  } finally {
    state.benchRunning = false;
  }
}

// R1: bucket ↔ executor transfer over presigned URLs. Same result slot and
// polling contract as the git bench (/results answers with .bench when done).
async function runTransfer(spec) {
  if (state.benchRunning) throw new Error("bench already running");
  if (typeof spec.getUrl !== "string" || typeof spec.putUrl !== "string")
    throw new Error("transfer needs getUrl and putUrl");
  state.benchRunning = true;
  state.bench = null;
  try {
    const env = {
      ...process.env,
      BENCH_GET_URL: spec.getUrl,
      BENCH_PUT_URL: spec.putUrl,
      BENCH_S3_URI: spec.s3Uri ?? "",
      BENCH_SIZE: String(spec.size ?? 1073741824),
      BENCH_PARALLEL: String(spec.parallel ?? 8),
      BENCH_EGRESS: spec.egress ?? "unknown",
      BENCH_ID: `${state.microvmId ?? "local"}-${Date.now()}`,
    };
    log(`transfer: start ${JSON.stringify({ egress: env.BENCH_EGRESS, size: env.BENCH_SIZE, parallel: env.BENCH_PARALLEL })}`);
    const { stdout, stderr } = await run("bash", ["/opt/bench/bench-transfer.sh"], {
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
    const result = JSON.parse(stdout);
    result.stderrTail = stderr.split("\n").slice(-60).join("\n");
    state.bench = result;
    log(`transfer: done, ${Object.keys(result.results ?? {}).length} measurements`);
    return result;
  } catch (err) {
    log(`transfer: failed ${err.message}`);
    state.bench = { error: err.message, stderr: err.stderr?.slice(-4000) };
    throw err;
  } finally {
    state.benchRunning = false;
  }
}

const hooks = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.startsWith(HOOK_PREFIX))
    return json(res, 404, { error: "not a hook" });
  const hook = req.url.slice(HOOK_PREFIX.length + 1);
  try {
    switch (hook) {
      case "ready":
      case "validate":
        // Image build time: nothing session-specific exists yet. Safe to snapshot.
        return json(res, 200, { status: "ok", hook });
      case "run": {
        const raw = await readBody(req);
        const envelope = raw ? JSON.parse(raw) : {};
        const payload = envelope.runHookPayload ? JSON.parse(envelope.runHookPayload) : envelope;
        state.microvmId = envelope.microvmId ?? null;
        state.payload = payload;
        log(`run: microvm ${state.microvmId} payload keys ${Object.keys(payload).join(",")}`);
        if (payload.probe) {
          log("run: probe mode, not mounting");
          return json(res, 200, { status: "ok", hook, probe: true });
        }
        if (!payload.fsx?.dns || !payload.fsx?.path)
          throw new Error("run payload needs fsx.dns and fsx.path");
        await mountFsx(payload.fsx, payload.mountPoint ?? "/mend");
        if (payload.bench) {
          // Acknowledge first (run hook timeout is ≤ 60 s), bench in the background.
          json(res, 200, { status: "ok", hook, mount: state.mount, bench: "started" });
          runBench(payload.bench).catch(() => {});
          return;
        }
        return json(res, 200, { status: "ok", hook, mount: state.mount });
      }
      case "resume": {
        // Re-validate the mount after a suspend/resume. Remount if the kernel lost it.
        if (state.mount)
          await mountFsx({ dns: state.mount.dns, path: state.mount.path }, state.mount.mountPoint);
        return json(res, 200, { status: "ok", hook, mount: state.mount });
      }
      case "suspend":
        await run("sync", []);
        return json(res, 200, { status: "ok", hook });
      case "terminate":
        return json(res, 200, { status: "ok", hook });
      default:
        return json(res, 404, { error: `unknown hook ${hook}` });
    }
  } catch (err) {
    log(`${hook}: error ${err.message}`);
    return json(res, 500, { error: err.message, hook });
  }
});

const app = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        microvmId: state.microvmId,
        mount: state.mount,
        benchRunning: state.benchRunning,
      });
    }
    if (req.method === "GET" && req.url === "/results")
      return json(res, 200, { bench: state.bench, log: state.log.slice(-100) });
    if (req.method === "GET" && req.url === "/log") return json(res, 200, { log: state.log });
    if (req.method === "GET" && req.url === "/diag") return json(res, 200, await diagnostics());
    if (req.method === "POST" && req.url === "/exec") {
      // POC-only remote exec, reachable solely through the token-scoped endpoint.
      const { cmd, timeout } = JSON.parse((await readBody(req)) || "{}");
      if (typeof cmd !== "string") return json(res, 400, { error: "cmd required" });
      return json(res, 200, await sh(cmd, timeout ?? 120000));
    }
    if (req.method === "POST" && req.url === "/transfer") {
      const spec = JSON.parse((await readBody(req)) || "{}");
      json(res, 202, { status: "started", egress: spec.egress ?? null });
      runTransfer(spec).catch(() => {});
      return;
    }
    if (req.method === "POST" && req.url === "/bench") {
      const spec = JSON.parse((await readBody(req)) || "{}");
      json(res, 202, { status: "started", spec });
      runBench(spec).catch(() => {});
      return;
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

hooks.listen(HOOK_PORT, "0.0.0.0", () => log(`hooks listening on :${HOOK_PORT}`));
app.listen(APP_PORT, "0.0.0.0", () => log(`app listening on :${APP_PORT}`));
