// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configPath,
  forgetToken,
  loadConfig,
  mergeConfig,
  saveConfig,
  tokenFromEnvironment,
} from "./config";

const saved = {
  xdg: process.env["XDG_CONFIG_HOME"],
  url: process.env["MEND_URL"],
  token: process.env["MEND_TOKEN"],
};

const restore = (key: string, value: string | undefined) => {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
};

let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-desktop-config-"));
  process.env["XDG_CONFIG_HOME"] = home;
  Reflect.deleteProperty(process.env, "MEND_URL");
  Reflect.deleteProperty(process.env, "MEND_TOKEN");
});

afterEach(() => {
  restore("XDG_CONFIG_HOME", saved.xdg);
  restore("MEND_URL", saved.url);
  restore("MEND_TOKEN", saved.token);
  fs.rmSync(home, { recursive: true, force: true });
});

const writeFile = (contents: unknown) => {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(contents));
};

describe("the shared credential file", () => {
  it("lives under XDG_CONFIG_HOME", () => {
    expect(configPath()).toBe(path.join(home, "mend", "cli.json"));
  });

  it("reads the device id the CLI saved", () => {
    writeFile({ url: "https://alpha.example", token: "t", deviceId: "dev-1" });
    expect(loadConfig()).toEqual({ url: "https://alpha.example", token: "t", deviceId: "dev-1" });
  });

  it("drops the file's device id when MEND_TOKEN replaces its token", () => {
    writeFile({ url: "https://alpha.example", token: "t", deviceId: "dev-1" });
    process.env["MEND_TOKEN"] = "from-env";
    expect(loadConfig()).toEqual({
      url: "https://alpha.example",
      token: "from-env",
      deviceId: null,
    });
  });

  it("keeps every field it does not own when saving", () => {
    writeFile({ url: "https://old.example", token: "old", deviceId: "dev-1", future: { a: 1 } });
    saveConfig({ url: "https://new.example", token: "new", deviceId: "dev-2" });
    const written: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    expect(written).toEqual({
      url: "https://new.example",
      token: "new",
      deviceId: "dev-2",
      future: { a: 1 },
    });
    expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("signs out to nulls, as mend logout does", () => {
    writeFile({ url: "https://alpha.example", token: "t", deviceId: "dev-1" });
    forgetToken();
    expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({
      url: "https://alpha.example",
      token: null,
      deviceId: null,
    });
  });

  it("keeps the file's own url and fields when signing out under MEND_URL", () => {
    writeFile({ url: "https://alpha.example", token: "t", deviceId: "dev-1", future: 1 });
    fs.chmodSync(configPath(), 0o644);
    process.env["MEND_URL"] = "http://localhost:3105";
    forgetToken();
    expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({
      url: "https://alpha.example",
      token: null,
      deviceId: null,
      future: 1,
    });
    expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("says when MEND_TOKEN supplies the token", () => {
    expect(tokenFromEnvironment()).toBe(false);
    process.env["MEND_TOKEN"] = "from-env";
    expect(tokenFromEnvironment()).toBe(true);
  });

  it("merges without mutating what it read", () => {
    const existing = { url: "a", token: "b", deviceId: "c", other: true };
    const merged = mergeConfig(existing, { url: "x", token: null, deviceId: null });
    expect(merged).toEqual({ url: "x", token: null, deviceId: null, other: true });
    expect(existing.url).toBe("a");
  });
});
