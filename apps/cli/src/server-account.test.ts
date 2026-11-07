import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { writeCommandResult } from "./command-result.ts";
import { mainTestFixtures } from "./main-test-fixtures.ts";
import { createFirstAccount } from "./server-account.ts";

const { json, startFakeMend } = mainTestFixtures();

describe("first-account setup using existing registration, device and recovery routes", () => {
  it("creates an account without a supplied password, saves a device sign-in, and returns only the web link", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-first-account-"));
    const calls: Array<string> = [];
    let generatedPassword = "";
    const fake = await startFakeMend((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      if (request.url === "/api/instance") return json(response, { users: "none" });
      if (request.url === "/api/auth/sign-up/email") {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          const value = JSON.parse(body);
          expect(value).toMatchObject({ email: "mira@example.invalid", name: "Mira" });
          generatedPassword = value.password;
          json(response, {
            token: "private-session",
            user: { id: "mira", email: "mira@example.invalid", name: "Mira" },
          });
        });
        return;
      }
      if (request.url === "/api/organization")
        return json(response, { organization: { id: "org", name: "Mira" } });
      if (request.url === "/api/me/devices")
        return json(response, { token: "private-device", device: { id: "device" } });
      expect(request.headers.authorization).toBe("Bearer private-device");
      json(response, { path: "/reset#one-time-link", expiresAt: "2026-11-05T00:00:00Z" });
    });
    try {
      const receipt = await createFirstAccount({
        url: fake.url,
        email: "mira@example.invalid",
        name: "Mira",
        configDir: home,
        timeoutMs: 5000,
      });
      expect(receipt).toMatchObject({
        signedIn: true,
        account: { id: "mira" },
        organization: { id: "org" },
        webSetupUrl: `${fake.url}/reset#one-time-link`,
      });
      expect(generatedPassword.length).toBeGreaterThan(32);
      const config = path.join(home, "cli.json");
      expect(JSON.parse(fs.readFileSync(config, "utf8"))).toMatchObject({
        token: "private-device",
        deviceId: "device",
      });
      expect(fs.statSync(config).mode & 0o777).toBe(0o600);
      let output = "";
      writeCommandResult({ status: "done", data: receipt }, (line) => {
        output += line;
      });
      expect(output).not.toContain(generatedPassword);
      expect(output).not.toContain("private-");
      expect(JSON.parse(output).data.webSetupUrl).toBe(`${fake.url}/reset#one-time-link`);
      expect(calls).toEqual([
        "GET /api/instance",
        "POST /api/auth/sign-up/email",
        "GET /api/organization",
        "POST /api/me/devices",
        "POST /api/operator/password-resets",
      ]);
    } finally {
      await fake.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("never registers or resets a password when the server already has an account", async () => {
    const calls: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      calls.push(request.url ?? "");
      json(response, { users: "some" });
    });
    try {
      expect(
        await createFirstAccount({
          url: fake.url,
          email: "mira@example.invalid",
          name: "Mira",
          configDir: "/unused",
          timeoutMs: 5000,
        }),
      ).toBeNull();
      expect(calls).toEqual(["/api/instance"]);
    } finally {
      await fake.close();
    }
  });
});
