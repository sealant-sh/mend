// The benchmark's reach into an instance: the Mend API (the routes the CLI and the web app call),
// the terminal socket, and the host the server runs on (its docker logs, stats and sizes). Run on
// the server's host, everything is local and loopback; elsewhere, `--ssh` reaches the host.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// ─── the API ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(method, route, status, body) {
    super(`${method} ${route} → ${status} ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

/** A bearer-authenticated JSON client for one Mend server; every call is timed. */
export const makeApi = ({ url, token }) => {
  const base = url.replace(/\/$/, "");
  const call = async (method, route, body) => {
    const started = performance.now();
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const ms = performance.now() - started;
    if (!response.ok) throw new ApiError(method, route, response.status, text);
    return { value: text === "" ? null : JSON.parse(text), ms };
  };
  return {
    base,
    call,
    get: async (route) => (await call("GET", route)).value,
    post: async (route, body) => (await call("POST", route, body ?? {})).value,
    put: async (route, body) => (await call("PUT", route, body)).value,
    delete: async (route) => (await call("DELETE", route)).value,
  };
};

// ─── the terminal socket (/api/tty, docs/adr/0004 "Upgrade tickets") ────────

/**
 * One attached terminal: every output frame is kept with the time it arrived, so a caller can
 * ask when some text first appeared after an instant.
 */
export const attachTerminal = async (api, params, { cols = 160, rows = 48 } = {}) => {
  const ticket = await api.post("/upgrade-tickets", { target: "tty", ...params });
  const url = new URL(`${api.base}/api/tty`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries({ ...params, from: "0", ticket: ticket.ticket })) {
    url.searchParams.set(key, value);
  }
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const frames = [];
  const waiters = new Set();
  let ended = false;
  const isEnded = () => ended;
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      if (event.data.includes('"end"')) ended = true;
      return;
    }
    frames.push({ at: performance.now(), text: Buffer.from(event.data).toString("utf8") });
    for (const waiter of waiters) waiter();
  });
  socket.addEventListener("close", () => {
    ended = true;
    for (const waiter of waiters) waiter();
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("terminal socket refused")), {
      once: true,
    });
  });
  const openedAt = performance.now();
  socket.send(JSON.stringify({ t: "resize", cols, rows }));

  /** Resolves on the next frame (or close), or after `ms`. */
  const nextFrame = (ms) => {
    const { promise, resolve } = Promise.withResolvers();
    const wake = () => {
      clearTimeout(timer);
      waiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    waiters.add(wake);
    return promise;
  };

  /** The output received since index `from`, as one string. */
  const textSince = (from) =>
    frames
      .slice(from)
      .map((frame) => frame.text)
      .join("");

  /** The length of the text from frame `from` up to (not including) frame `end`. */
  const lengthUpTo = (from, end) =>
    frames.slice(from, end).reduce((sum, frame) => sum + frame.text.length, 0);

  return {
    openedAt,
    frames,
    get ended() {
      return ended;
    },
    send: (text) => socket.send(new TextEncoder().encode(text)),
    /** The first frame at or after `sinceIndex`, waiting up to `timeoutMs`. */
    firstFrame: async (sinceIndex, timeoutMs) => {
      const deadline = performance.now() + timeoutMs;
      while (frames.length <= sinceIndex && !isEnded() && performance.now() < deadline) {
        await nextFrame(deadline - performance.now());
      }
      return frames[sinceIndex] ?? null;
    },
    /** Waits until `pattern` appears in the output after `sinceIndex`; the frame where it completed. */
    waitFor: async (pattern, sinceIndex, timeoutMs, normalize = (text) => text) => {
      const deadline = performance.now() + timeoutMs;
      let checked = sinceIndex;
      for (;;) {
        if (frames.length > checked && pattern.test(normalize(textSince(sinceIndex)))) {
          // The frame that completed the match: the shortest prefix that already matches.
          for (let end = Math.max(sinceIndex + 1, checked); end <= frames.length; end += 1) {
            if (
              pattern.test(normalize(textSince(sinceIndex).slice(0, lengthUpTo(sinceIndex, end))))
            ) {
              return { frame: frames[end - 1], index: end - 1, text: textSince(sinceIndex) };
            }
          }
        }
        checked = frames.length;
        if (isEnded() || performance.now() >= deadline) return null;
        await nextFrame(Math.max(1, deadline - performance.now()));
      }
    },
    /** Waits until no frame has arrived for `quietMs` (or `timeoutMs` passed). */
    settle: async (quietMs, timeoutMs) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline && !isEnded()) {
        const before = frames.length;
        await nextFrame(quietMs);
        if (frames.length === before) return;
      }
    },
    close: () => socket.close(),
  };
};

// ─── the host ───────────────────────────────────────────────────────────────

/**
 * Commands on the host that runs the server: locally (the benchmark runs there) or over SSH
 * (`--ssh "root@10.0.0.40 -J root@100.94.101.28"`). Null when neither is possible: log-derived
 * steps are then reported as not run, never guessed.
 */
export const makeHost = async ({ ssh }) => {
  const sshArgs = ssh === null ? null : ssh.split(/\s+/).filter((part) => part !== "");
  const shell = async (command, { timeoutMs = 120_000 } = {}) => {
    const [file, args] =
      sshArgs === null
        ? ["sh", ["-c", command]]
        : ["ssh", ["-o", "BatchMode=yes", ...sshArgs, command]];
    const { stdout } = await run(file, args, { timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024 });
    return stdout;
  };
  try {
    await shell("docker version --format '{{.Server.Version}}'", { timeoutMs: 30_000 });
  } catch {
    return null;
  }
  return {
    shell,
    /**
     * Server minus local clock, over one held connection so a round trip is the network's and
     * not a new SSH handshake's: the probe with the shortest round trip of `samples` wins.
     */
    clockOffset: async (samples = 15) => {
      const command = "while read -r _; do date +%s%N; done";
      const child =
        sshArgs === null
          ? spawn("sh", ["-c", command])
          : spawn("ssh", ["-o", "BatchMode=yes", ...sshArgs, command]);
      let buffer = "";
      const lines = [];
      let wake = null;
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        lines.push(...parts.filter((line) => line.trim() !== ""));
        wake?.();
      });
      const nextLine = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (lines.length === 0) {
          if (Date.now() > deadline) throw new Error("the clock probe did not answer");
          const { promise, resolve } = Promise.withResolvers();
          wake = resolve;
          const timer = setTimeout(resolve, 100);
          await promise;
          clearTimeout(timer);
        }
        return lines.shift();
      };
      try {
        // The first answer pays for the connection; it is not a sample.
        child.stdin.write("\n");
        await nextLine(30_000);
        let best = null;
        for (let k = 0; k < samples; k += 1) {
          const before = Date.now();
          child.stdin.write("\n");
          const serverMs = Number(BigInt((await nextLine(10_000)).trim()) / 1_000_000n);
          const after = Date.now();
          const rtt = after - before;
          if (best === null || rtt < best.rtt)
            best = { rtt, offset: serverMs - (before + after) / 2 };
        }
        return { offsetMs: best.offset, uncertaintyMs: best.rtt / 2 };
      } finally {
        child.stdin.end();
        child.kill("SIGTERM");
      }
    },
    /** Follows a container's whole log until it exits or `stop()`; the text so far, with docker timestamps. */
    follow: (container) => {
      const command = `docker logs -f -t ${container} 2>&1`;
      const child =
        sshArgs === null
          ? spawn("sh", ["-c", command])
          : spawn("ssh", ["-o", "BatchMode=yes", ...sshArgs, command]);
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk.toString("utf8");
      });
      child.stderr.on("data", () => {});
      const exited = new Promise((resolve) => child.on("close", resolve));
      return {
        text: () => text,
        stop: async () => {
          child.kill("SIGTERM");
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
          return text;
        },
      };
    },
  };
};

/** Mend's own log for a window, with docker timestamps. */
export const mendLogBetween = (host, container, fromMs, toMs) =>
  host.shell(
    `docker logs -t --since ${new Date(fromMs - 2000).toISOString()} --until ${new Date(toMs + 2000).toISOString()} ${container} 2>&1`,
    { timeoutMs: 180_000 },
  );

/** The executor container a session launched: its env names the session (`MEND_SESSION_ID`). */
export const executorOf = async (host, sessionId) => {
  const out = await host.shell(
    `for c in $(docker ps --format '{{.Names}}' | grep '^sealant-' | grep -v -- '-docker$'); do ` +
      `docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx 'MEND_SESSION_ID=${sessionId}' && echo "$c"; done; true`,
  );
  const names = out.split("\n").filter((line) => line.startsWith("sealant-"));
  return names.at(-1) ?? null;
};

/** The executor's writable layer and memory, its Docker sidecar's beside it. */
export const executorResources = async (host, container) => {
  const disk = await host.shell(
    `docker ps -s --filter name=^${container}$ --format '{{.Size}}'; docker ps -s --filter name=^${container}-docker$ --format '{{.Size}}'`,
    { timeoutMs: 300_000 },
  );
  const memory = await host.shell(
    `docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}' ${container} ${container}-docker 2>/dev/null; true`,
  );
  const [mainDisk, sidecarDisk] = disk.split("\n");
  const byName = Object.fromEntries(
    memory
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => line.split("|")),
  );
  return {
    mainDisk,
    sidecarDisk,
    mainMemory: byName[container],
    sidecarMemory: byName[`${container}-docker`],
  };
};

/** The image an executor runs, and when Docker says it was made (`Created`, the host's clock). */
export const imageOfExecutor = async (host, container) => {
  const out = await host.shell(
    `docker image inspect "$(docker inspect ${container} --format '{{.Image}}')" --format '{{.Id}} {{.Created}}' 2>/dev/null; true`,
  );
  const [id, created] = out.trim().split(/\s+/);
  return id === undefined || id === "" ? null : { id, created: created ?? null };
};

/** A harness's version as its executor's binary says it (`<harness> --version`), or null. */
export const harnessVersionIn = async (host, container, harness) => {
  if (!["claude", "codex", "pi", "opencode"].includes(harness)) return null;
  const out = await host.shell(
    `docker exec ${container} sh -c '${harness} --version 2>&1 | head -3'; true`,
    { timeoutMs: 60_000 },
  );
  return /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(out)?.[0] ?? null;
};

/**
 * The commit the Mend server's image was built from: its `org.opencontainers.image.revision`
 * label (.github/workflows/image.yml), or null when the image carries none.
 */
export const mendImageCommit = async (host, container) => {
  const out = await host.shell(
    `docker inspect ${container} --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null; true`,
  );
  const commit = out.trim();
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
};
