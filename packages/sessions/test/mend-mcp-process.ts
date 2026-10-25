import { spawn } from "node:child_process";

export const startMendMcp = (helper: string, env: Record<string, string>) => {
  const child = spawn(process.execPath, [helper, "mcp"], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiters: Array<() => void> = [];
  const lines = () => stdout.split("\n").filter((line) => line !== "");
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    for (const wake of waiters.splice(0)) wake();
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    send: (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`),
    read: async (count: number) => {
      while (lines().length < count) await new Promise<void>((wake) => waiters.push(wake));
    },
    end: async () => {
      child.stdin.end();
      const code = await exited;
      return { code, stdout: lines().map((line): unknown => JSON.parse(line)), stderr };
    },
  };
};
