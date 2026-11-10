import { spawn } from "node:child_process";

import { ExecutorLinkStart, ExecutorPersonalStatus } from "@mend/domain/workbench";
import { Schema } from "effect";

import { browserCommand } from "./login.ts";

interface ExecutorBoundary {
  readonly request: (
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) => Promise<unknown>;
  readonly say: (text: string) => void;
  readonly open: (url: string) => void;
}
/** Browser consent returns to Mend; neither grant ever reaches this CLI. */
export const connectExecutor = async (args: ReadonlyArray<string>, boundary: ExecutorBoundary) => {
  if (
    args.some((arg) => !["--status", "--remove", "--member", "--no-open"].includes(arg)) ||
    (args.includes("--status") && args.includes("--remove"))
  )
    throw new Error("Usage: mend connect executor [--status | --remove] [--member] [--no-open]");
  const target = args.includes("--member") ? "member" : "person";
  if (args.includes("--remove")) {
    await boundary.request("DELETE", `/me/executor/link/${target}`);
    boundary.say("Executor link removed. Grants revoked in Executor.");
    return;
  }
  if (args.includes("--status")) {
    if (target === "member")
      throw new Error("Read Mend's member in Settings → MCP servers, in the Executor row.");
    const status = Schema.decodeUnknownSync(Schema.toEncoded(ExecutorPersonalStatus))(
      await boundary.request("GET", "/me/executor"),
    );
    boundary.say(
      !status.configured
        ? "Organization's Executor is not set up."
        : `${status.link.state === "active" ? "Executor issued this link" : status.link.state === "refused" ? "Executor refused this link" : "No Executor link"}${status.link.observedAt === null ? "" : ` · observed ${status.link.observedAt}`}`,
    );
    return;
  }
  const result = Schema.decodeUnknownSync(ExecutorLinkStart)(
    await boundary.request("POST", "/me/executor/link", { target }),
  );
  boundary.say(`Consent at your organization's Executor, then return to Mend:\n${result.url}`);
  if (!args.includes("--no-open")) boundary.open(result.url);
};
export const openExecutorConsent = (url: string) => {
  const browser = browserCommand(process.platform);
  if (browser === null) return;
  const child = spawn(browser.command, [...browser.args, url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
};
