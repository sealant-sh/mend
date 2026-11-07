import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { sameGrant } from "@mend/domain/workbench";

import { claudeCli, forgetGrant, readGrant } from "./claude-grant.ts";
import { codexCli, sameCodexLogin } from "./codex-grant.ts";
import { writeCommandEvent, type CommandResult } from "./command-result.ts";
import { throwawayLoginDir } from "./login-dir.ts";

type ProviderGrant =
  | { readonly kind: "grant"; readonly secret: string }
  | { readonly kind: "result"; readonly result: CommandResult<never> };

const launchKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SystemRoot",
];

export const providerAuthorizeUrl = (provider: "claude" | "codex", text: string): string | null => {
  for (const [candidate] of stripVTControlCharacters(text).matchAll(/https:\/\/[^\s<>"]+/g)) {
    try {
      const url = new URL(candidate);
      if (url.username !== "" || url.password !== "") continue;
      if (
        provider === "claude" &&
        ["claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname) &&
        url.pathname === "/oauth/authorize"
      )
        return url.href;
      if (
        provider === "codex" &&
        url.hostname === "auth.openai.com" &&
        ["/codex/device", "/device"].includes(url.pathname)
      )
        return url.href;
    } catch {
      /* Provider progress is not a protocol. Only recognized authorization URLs leave it. */
    }
  }
  return null;
};

export const providerLogin = async (input: {
  readonly provider: "claude" | "codex";
  readonly parent: string;
  readonly timeoutMs: number;
  readonly personalSecret: string | null;
}): Promise<ProviderGrant> => {
  const cli = input.provider === "claude" ? claudeCli() : codexCli();
  const home = throwawayLoginDir(input.parent, `${input.provider}-login-`);
  const env = Object.fromEntries(
    launchKeys.flatMap((key) => (cli.env[key] === undefined ? [] : [[key, cli.env[key]]])),
  );
  env[input.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = home;
  let timedOut = false;
  let interrupted = false;
  try {
    const status = await new Promise<number | null>((resolve) => {
      const child = spawn(
        cli.bin,
        input.provider === "claude" ? ["auth", "login", "--claudeai"] : ["login", "--device-auth"],
        { env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
      );
      const kill = () => {
        try {
          if (process.platform === "win32" || child.pid === undefined) child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The process may have already closed. */
        }
      };
      const interrupt = () => {
        interrupted = true;
        kill();
      };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, input.timeoutMs);
      let output = "";
      let lastEvent = "";
      const progress = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 64 * 1024) {
          kill();
          return;
        }
        const complete = stripVTControlCharacters(output.slice(0, output.lastIndexOf("\n") + 1));
        const url = providerAuthorizeUrl(input.provider, complete);
        const code =
          input.provider === "codex"
            ? /^\s*([A-Z0-9]{4}-[A-Z0-9]{4,5})\s*$/m.exec(complete)?.[1]
            : undefined;
        const event = JSON.stringify({
          v: 1,
          event: "authorize",
          provider: input.provider,
          url,
          ...(code === undefined ? {} : { code }),
        });
        if (url !== null && event !== lastEvent) {
          writeCommandEvent(
            {
              event: "authorize",
              provider: input.provider,
              url,
              ...(code === undefined ? {} : { code }),
            },
            (line) => {
              process.stdout.write(line);
            },
          );
          lastEvent = event;
        }
      };
      child.stdout.on("data", progress);
      child.stderr.on("data", progress);
      child.once("error", () => {
        /* Close still fires and owns cleanup. */
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
        resolve(code);
      });
    });
    const refused = (code: string, message: string): ProviderGrant => ({
      kind: "result",
      result: {
        status: timedOut ? "timeout" : "failed",
        error: {
          code,
          message,
          fix: `Run mend connect ${input.provider} --json again, or pipe a key with --api-key.`,
        },
      },
    });
    if (timedOut)
      return refused(
        "timeout",
        "Provider sign-in reached its deadline. The login process was stopped.",
      );
    if (interrupted || status !== 0)
      return refused(
        "provider_login_failed",
        "Provider sign-in did not complete. Check that the provider CLI is installed.",
      );
    const file = path.join(home, "auth.json");
    const grant = input.provider === "claude" ? readGrant(home) : null;
    const secret =
      input.provider === "claude"
        ? grant?.kind === "missing"
          ? null
          : (grant?.secret ?? null)
        : fs.existsSync(file)
          ? fs.readFileSync(file, "utf8").trim()
          : null;
    if (secret === null || secret === "")
      return refused("provider_login_missing", "The provider did not save its new login.");
    if (
      input.personalSecret !== null &&
      (input.provider === "claude"
        ? sameGrant(secret, input.personalSecret)
        : sameCodexLogin(secret, input.personalSecret))
    )
      return refused(
        "provider_login_shared",
        "The provider reused this machine's login. Use --use-my-login only with the person's explicit permission.",
      );
    return { kind: "grant", secret };
  } finally {
    if (input.provider === "claude") forgetGrant(home);
    else fs.rmSync(home, { recursive: true, force: true });
  }
};
