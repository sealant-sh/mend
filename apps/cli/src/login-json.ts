import * as os from "node:os";

import { parseDuration } from "@mend/domain/workbench";

import {
  needsInput,
  requestFailure,
  writeCommandResult,
  writeCommandEvent,
  type CommandResult,
} from "./command-result.ts";
import {
  authorizeUrl,
  normalizeServerUrl,
  parseCliAuthPoll,
  parseCliAuthStart,
  pollDeadline,
  pollDelayMs,
  type LoginDeps,
} from "./login.ts";
import { takeFlagValue } from "./shared.ts";

export interface AccountReceipt {
  readonly account: { readonly id: string; readonly email: string; readonly name: string };
  readonly organization: { readonly id: string; readonly name: string };
}

export const loginIdentity = async (
  base: string,
  token: string,
  signal: AbortSignal,
): Promise<AccountReceipt["organization"]> => {
  const response = await fetch(`${base}/api/organization`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error("Organization unavailable");
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || !("organization" in value))
    throw new Error("Organization unavailable");
  const organization = value.organization;
  if (
    typeof organization !== "object" ||
    organization === null ||
    !("id" in organization) ||
    !("name" in organization) ||
    typeof organization.id !== "string" ||
    typeof organization.name !== "string"
  )
    throw new Error("Organization unavailable");
  return { id: organization.id, name: organization.name };
};

const finish = (result: CommandResult<unknown>) => {
  process.exitCode = writeCommandResult(result, (line) => {
    process.stdout.write(line);
  });
};
const failure = (code: string, message: string): CommandResult<never> => ({
  status: "failed",
  error: { code, message, fix: "Run mend login --url <server-url> --json again." },
});

export const loginJson = async (args: ReadonlyArray<string>, deps: LoginDeps): Promise<void> => {
  const given = takeFlagValue(args, "--url") ?? deps.configuredUrl;
  if (given === null)
    return finish(
      needsInput("Choose the Mend server.", "Run mend login --url <server-url> --json."),
    );
  const base = normalizeServerUrl(given);
  const timeout = parseDuration(takeFlagValue(args, "--timeout") ?? "10m");
  if (base === null || timeout === null || timeout <= 0)
    return finish({
      status: "usage",
      error: {
        code: "usage",
        message: "Invalid server URL or timeout.",
        fix: "Pass --url <http-or-https-url> and --timeout 10m.",
      },
    });
  const signal = AbortSignal.timeout(timeout);
  const post = async (route: string, body: unknown) =>
    fetch(`${base}/api${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  try {
    const response = await post("/cli/auth", { name: os.hostname(), client: "cli" });
    if (!response.ok)
      return finish(
        failure("authorize_refused", `The server refused authorization (HTTP ${response.status}).`),
      );
    const opened = parseCliAuthStart(await response.json());
    if (
      opened === null ||
      !opened.verifyPath.startsWith("/authorize?") ||
      opened.verifyPath.includes("#")
    )
      return finish(
        failure("invalid_response", "The server did not return a Mend authorization request."),
      );
    writeCommandEvent(
      {
        event: "authorize",
        url: authorizeUrl(base, `/authorize?code=${encodeURIComponent(opened.code)}`),
        code: opened.code,
        expiresAt: opened.expiresAt,
      },
      (line) => {
        process.stdout.write(line);
      },
    );
    const deadline = Math.min(
      Date.now() + timeout,
      pollDeadline(opened, Date.now(), response.headers.get("date")),
    );
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.min(pollDelayMs(opened.intervalSeconds), Math.max(0, deadline - Date.now())),
        ),
      );
      signal.throwIfAborted();
      if (Date.now() >= deadline) break;
      const poll = await post("/cli/auth/token", { deviceCode: opened.deviceCode });
      if (poll.status === 403)
        return finish(failure("authorize_denied", "Authorization was denied in the browser."));
      if (poll.status === 404 || poll.status === 410)
        return finish(failure("authorize_expired", "The authorization request is no longer open."));
      if (poll.status === 429) continue;
      if (!poll.ok)
        return finish(
          failure("authorize_refused", `The server refused authorization (HTTP ${poll.status}).`),
        );
      const result = parseCliAuthPoll(await poll.json());
      if (result === null)
        return finish(
          failure("invalid_response", "The server did not return a Mend authorization answer."),
        );
      if (result.status === "pending") continue;
      deps.save({ url: base, token: result.token, deviceId: result.device.id });
      const organization = await loginIdentity(base, result.token, signal);
      writeCommandEvent({ event: "signed-in", account: result.user, organization }, (line) => {
        process.stdout.write(line);
      });
      return;
    }
    return finish(failure("authorize_expired", "The authorization request expired."));
  } catch (error) {
    if (signal.aborted)
      return finish({
        status: "timeout",
        error: {
          code: "timeout",
          message: "Sign-in reached its deadline.",
          fix: "Run mend login --url <server-url> --json again.",
        },
      });
    return finish(requestFailure(error));
  }
};
