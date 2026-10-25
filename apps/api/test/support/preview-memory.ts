import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./preview-memory-probe.ts", import.meta.url));

export interface MemorySample {
  readonly t: number;
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

export interface SampledChild {
  readonly child: ChildProcess;
  readonly line: (matches: (line: string) => boolean) => Promise<string>;
  readonly samples: () => ReadonlyArray<MemorySample>;
  readonly baseline: () => Promise<MemorySample>;
  readonly peak: () => MemorySample;
  readonly nodeVersion: () => string | null;
  readonly stop: () => Promise<void>;
}

export interface SampledOptions {
  readonly intervalMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly collect?: boolean;
}

interface ProbeSample {
  readonly at: number;
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly version: string;
}

const probeSampleOf = (message: unknown): ProbeSample | null => {
  if (typeof message !== "object" || message === null) return null;
  if (!("kind" in message) || message.kind !== "preview-memory") return null;
  const number = (name: string) => {
    const value: unknown = Reflect.get(message, name);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const version: unknown = Reflect.get(message, "version");
  const at = number("at");
  const rss = number("rss");
  const heapUsed = number("heapUsed");
  const external = number("external");
  const arrayBuffers = number("arrayBuffers");
  if (typeof version !== "string" || at === null || rss === null) return null;
  if (heapUsed === null || external === null || arrayBuffers === null) return null;
  return { at, rss, heapUsed, external, arrayBuffers, version };
};

const fieldwiseMax = (samples: ReadonlyArray<MemorySample>): MemorySample =>
  samples.reduce((peak, sample) => ({
    t: sample.rss > peak.rss ? sample.t : peak.t,
    rss: Math.max(peak.rss, sample.rss),
    heapUsed: Math.max(peak.heapUsed, sample.heapUsed),
    external: Math.max(peak.external, sample.external),
    arrayBuffers: Math.max(peak.arrayBuffers, sample.arrayBuffers),
  }));

export const spawnSampled = (
  modulePath: string,
  args: ReadonlyArray<string>,
  options: SampledOptions = {},
): SampledChild => {
  const spawnedAt = Date.now();
  const collect = options.collect === true;
  const flags = collect ? ["--expose-gc"] : [];
  const child = spawn(process.execPath, [...flags, "--import", PROBE, modulePath, ...args], {
    stdio: ["ignore", "pipe", "inherit", "ipc"],
    env: {
      ...(options.env ?? process.env),
      MEND_PREVIEW_MEMORY_INTERVAL_MS: String(options.intervalMs ?? 100),
      MEND_PREVIEW_MEMORY_COLLECT: collect ? "1" : "0",
    },
  });
  const exited = once(child, "exit");
  const all: MemorySample[] = [];
  let windowStart = 0;
  let version: string | null = null;
  const waiters: Array<(sample: MemorySample) => void> = [];

  child.on("message", (message: unknown) => {
    const probe = probeSampleOf(message);
    if (probe === null) return;
    version = probe.version;
    const sample: MemorySample = {
      t: probe.at - spawnedAt,
      rss: probe.rss,
      heapUsed: probe.heapUsed,
      external: probe.external,
      arrayBuffers: probe.arrayBuffers,
    };
    all.push(sample);
    for (const wake of waiters.splice(0)) wake(sample);
  });

  const lines: string[] = [];
  const lineWaiters = new Set<(line: string) => void>();
  let partial = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (text: string) => {
    const parts = (partial + text).split("\n");
    partial = parts.pop() ?? "";
    for (const next of parts) {
      lines.push(next);
      for (const wake of lineWaiters) wake(next);
    }
  });

  return {
    child,
    line: (matches) =>
      new Promise((resolve, reject) => {
        const seen = lines.find(matches);
        if (seen !== undefined) return resolve(seen);
        const onExit = () => {
          lineWaiters.delete(onLine);
          reject(new Error("the child exited before printing the line"));
        };
        const onLine = (next: string) => {
          if (!matches(next)) return;
          lineWaiters.delete(onLine);
          child.off("exit", onExit);
          resolve(next);
        };
        lineWaiters.add(onLine);
        child.once("exit", onExit);
      }),
    samples: () => all,
    baseline: async () => {
      const sample = await new Promise<MemorySample>((resolve) => waiters.push(resolve));
      windowStart = all.indexOf(sample);
      return sample;
    },
    peak: () => {
      const window = all.slice(windowStart);
      if (window.length === 0) throw new Error("no memory sample yet");
      return fieldwiseMax(window);
    },
    nodeVersion: () => version,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killer);
    },
  };
};
