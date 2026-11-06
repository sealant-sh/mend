import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { conversationQuiescenceScript, parseConversationReport } from "../src/conversation-home.ts";

const exec = promisify(execFile);
it("observes target auxiliary exit without ending a differently marked process", async () => {
  const targetId = `history-target-${process.pid}`;
  const target = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    {
      env: { PATH: process.env["PATH"], MEND_AGENT_PROCESS_ID: targetId },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const peer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    env: { PATH: process.env["PATH"], MEND_AGENT_PROCESS_ID: `peer-${process.pid}` },
    stdio: "ignore",
  });
  try {
    await once(target.stdout, "data");
    const exited = once(target, "exit");
    const result = await exec(
      "sh",
      [
        "-c",
        conversationQuiescenceScript({
          sessionId: `unused-${process.pid}`,
          processIds: [targetId],
        }),
      ],
      {
        env: { PATH: process.env["PATH"] },
      },
    );
    await exited;
    expect(parseConversationReport(result.stdout).empty).toBe(true);
    expect(peer.exitCode).toBeNull();
    expect(peer.signalCode).toBeNull();
  } finally {
    target.kill("SIGKILL");
    peer.kill("SIGKILL");
  }
});
