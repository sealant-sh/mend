import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { findCommand, renderManPage } from "./help.ts";
import { mainTestFixtures } from "./main-test-fixtures.ts";

const { spawning, startFakeMend, startCli, json } = mainTestFixtures();

const LABEL = "Send steers the running turn";

/** A Mend that keeps one person's message settings, starting from the default, and logs each call. */
const startSettingsMend = async () => {
  const calls: Array<{ route: string; body: unknown; authorization: string | undefined }> = [];
  let saved: unknown = { sendSteersRunningTurn: true };
  const fake = await startFakeMend((request: IncomingMessage, response: ServerResponse) => {
    const route = `${request.method} ${request.url}`;
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      const body: unknown = text === "" ? null : JSON.parse(text);
      calls.push({ route, body, authorization: request.headers.authorization });
      if (route === "GET /api/me/message-settings") json(response, saved);
      else if (route === "PUT /api/me/message-settings") {
        saved = body;
        json(response, saved);
      } else response.writeHead(500).end();
    });
  });
  return { ...fake, calls };
};

const run = async (url: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const cli = startCli(url, ["settings", ...args], { MEND_TOKEN: "fake-settings-token", ...env });
  await cli.closed;
  return { exit: await cli.exited, stdout: cli.stdout(), stderr: cli.stderr() };
};

describe("mend settings through main", spawning, () => {
  it("prints the default, one line per setting, with the caller's token", async () => {
    const fake = await startSettingsMend();
    try {
      const listed = await run(fake.url, []);
      expect(listed.exit, listed.stderr).toEqual({ kind: "exit", code: 0 });
      expect(listed.stdout).toBe(`send-steers   on   ${LABEL}\n`);
      expect(listed.stderr).toBe("");
      const shown = await run(fake.url, ["send-steers"]);
      expect(shown.stdout).toBe("on\n");
      expect(fake.calls).toEqual([
        {
          route: "GET /api/me/message-settings",
          body: null,
          authorization: "Bearer fake-settings-token",
        },
        {
          route: "GET /api/me/message-settings",
          body: null,
          authorization: "Bearer fake-settings-token",
        },
      ]);
    } finally {
      await fake.close();
    }
  });

  it("saves off, prints the saved value, and reads it back off", async () => {
    const fake = await startSettingsMend();
    try {
      const set = await run(fake.url, ["send-steers", "off"]);
      expect(set.exit, set.stderr).toEqual({ kind: "exit", code: 0 });
      expect(set.stdout).toBe("off\n");
      expect(fake.calls.map(({ route, body }) => ({ route, body }))).toEqual([
        { route: "PUT /api/me/message-settings", body: { sendSteersRunningTurn: false } },
      ]);
      expect((await run(fake.url, ["send-steers"])).stdout).toBe("off\n");
      expect((await run(fake.url, [])).stdout).toBe(`send-steers   off  ${LABEL}\n`);
      const back = await run(fake.url, ["send-steers", "on"]);
      expect(back.stdout).toBe("on\n");
      expect(fake.calls.at(-1)?.body).toEqual({ sendSteersRunningTurn: true });
    } finally {
      await fake.close();
    }
  });

  it.each([
    [["send-steers", "yes"], "send-steers takes on or off"],
    [["send-steers", "OFF"], "send-steers takes on or off"],
    [["send-steers", "true"], "send-steers takes on or off"],
    [["send-steers", "on", "off"], "usage: mend settings"],
    [["steering", "off"], "unknown setting"],
  ])("refuses mend settings %j with a usage line and sends nothing", async (args, lead) => {
    const fake = await startSettingsMend();
    try {
      const text = await run(fake.url, args);
      expect(text.exit).toEqual({ kind: "exit", code: 1 });
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain(lead);
      expect(text.stderr).toContain("usage: mend settings [send-steers [on|off]] [--json]");
      const asJson = await run(fake.url, [...args, "--json"]);
      expect(asJson.exit).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(asJson.stdout)).toEqual({
        version: 1,
        error: { tag: "InvalidSettingsArguments", message: expect.stringContaining(lead) },
      });
      expect(asJson.stderr).toBe("");
      expect(fake.calls).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("refuses an unknown flag at the global gate before contacting the server", async () => {
    const fake = await startSettingsMend();
    try {
      const refused = await run(fake.url, ["send-steers", "off", "--force"]);
      expect(refused.exit).toEqual({ kind: "exit", code: 1 });
      expect(refused.stderr).toContain("unknown flag --force · usage: mend settings");
      expect(fake.calls).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("prints one versioned object for --json: every setting, one setting, and the saved one", async () => {
    const fake = await startSettingsMend();
    try {
      const setting = (value: "on" | "off") => ({ name: "send-steers", value, label: LABEL });
      const listed = await run(fake.url, ["--json"]);
      expect(listed.exit).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(listed.stdout)).toEqual({ version: 1, settings: [setting("on")] });
      const shown = await run(fake.url, ["send-steers", "--json"]);
      expect(JSON.parse(shown.stdout)).toEqual({ version: 1, setting: setting("on") });
      const set = await run(fake.url, ["send-steers", "off", "--json"]);
      expect(set.exit).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(set.stdout)).toEqual({ version: 1, setting: setting("off") });
      expect(set.stderr).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("says to sign in when the server answers 401", async () => {
    const fake = await startFakeMend((request, response) => {
      request.resume();
      response.writeHead(401).end();
    });
    try {
      const signedOut = startCli(fake.url, ["settings"]);
      await signedOut.closed;
      expect(await signedOut.exited).toEqual({ kind: "exit", code: 1 });
      expect(signedOut.stdout()).toBe("");
      expect(signedOut.stderr()).toBe(`mend: not signed in to ${fake.url} — run: mend login\n`);
      const rejected = await run(fake.url, ["send-steers", "off", "--json"]);
      expect(rejected.exit).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(rejected.stdout)).toEqual({
        version: 1,
        error: { tag: "Unauthorized", message: expect.stringContaining("run: mend login") },
      });
    } finally {
      await fake.close();
    }
  });

  it("refuses a server answer that is not a message setting", async () => {
    const fake = await startFakeMend((request, response) => {
      request.resume();
      json(response, { sendSteersRunningTurn: "yes" });
    });
    try {
      const odd = await run(fake.url, ["--json"]);
      expect(odd.exit).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(odd.stdout)).toMatchObject({
        version: 1,
        error: { tag: "SettingsUnreadable" },
      });
    } finally {
      await fake.close();
    }
  });

  it("prints its page for mend help settings and settings --help, and has a man page", async () => {
    const byHelp = startCli("http://127.0.0.1:1", ["help", "settings"]);
    const byFlag = startCli("http://127.0.0.1:1", ["settings", "--help"]);
    await Promise.all([byHelp.closed, byFlag.closed]);
    expect(byHelp.stdout()).toContain("mend settings · see or change your own messaging setting");
    expect(byHelp.stdout()).toContain("mend settings send-steers off");
    expect(byHelp.stdout()).toContain("\nsee also\n  mend message");
    expect(byFlag.stdout()).toBe(byHelp.stdout());
    const doc = findCommand(["settings"]);
    expect(doc?.name).toBe("settings");
    if (doc === null) return;
    const man = renderManPage(doc, "0.37.0");
    expect(man.startsWith('.TH MEND-SETTINGS 1 "" "mend 0.37.0"')).toBe(true);
    expect(man).toContain("\\-\\-json");
  });

  it("completes settings, its setting and on or off in zsh and bash", async () => {
    const zsh = startCli("http://127.0.0.1:1", ["completions", "zsh"]);
    const bash = startCli("http://127.0.0.1:1", ["completions", "bash"]);
    await Promise.all([zsh.closed, bash.closed]);
    expect(zsh.stdout()).toContain("'settings:see or change your own messaging setting'");
    expect(zsh.stdout()).toContain("compadd -- on off --json");
    expect(bash.stdout()).toMatch(/compgen -W "[^"]* settings [^"]*"/);
    expect(bash.stdout()).toContain('options="on off --json"');
  });
});
