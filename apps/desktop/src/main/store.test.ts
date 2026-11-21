import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDesktopStore,
  EMPTY_STORE_STATE,
  parseDesktopState,
  readCliDefaultUrl,
  recordRecentServer,
  removeRecentServer,
} from "./store.ts";

const tempDirs: Array<string> = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-desktop-store-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseDesktopState", () => {
  it("drops invalid URLs, deduplicates recent servers, and includes active server in recents", () => {
    const parsed = parseDesktopState({
      serverUrl: "https://mend.example.com/",
      recentServers: ["http://localhost:3115/", "javascript:alert(1)", "http://localhost:3115"],
      bounds: { x: 50, y: 60, width: 1200, height: 800 },
      maximized: true,
    });
    expect(parsed).toEqual({
      serverUrl: "https://mend.example.com",
      recentServers: ["https://mend.example.com", "http://localhost:3115"],
      bounds: { x: 50, y: 60, width: 1200, height: 800 },
      maximized: true,
    });
  });

  it("returns empty defaults on malformed input", () => {
    expect(parseDesktopState(null)).toEqual(EMPTY_STORE_STATE);
    expect(parseDesktopState("corrupt")).toEqual(EMPTY_STORE_STATE);
  });
});

describe("recent servers helpers", () => {
  it("moves reconnected server to the front, caps at 6, and removes by exact URL", () => {
    const list = [
      "https://one.example",
      "https://two.example",
      "https://three.example",
      "https://four.example",
      "https://five.example",
      "https://six.example",
    ];
    expect(recordRecentServer(list, "https://three.example")).toEqual([
      "https://three.example",
      "https://one.example",
      "https://two.example",
      "https://four.example",
      "https://five.example",
      "https://six.example",
    ]);
    expect(recordRecentServer(list, "https://seven.example")).toHaveLength(6);
    expect(removeRecentServer(list, "https://two.example")).not.toContain("https://two.example");
  });
});

describe("createDesktopStore", () => {
  it("persists and reloads state from userData/desktop-state.json", () => {
    const dir = makeTempDir();
    const store = createDesktopStore(dir);
    expect(store.load()).toEqual(EMPTY_STORE_STATE);

    const saved = {
      serverUrl: "http://localhost:3115",
      recentServers: ["http://localhost:3115"],
      bounds: { x: 20, y: 30, width: 1280, height: 840 },
      maximized: false,
    };
    store.save(saved);
    expect(store.load()).toEqual(saved);
  });
});

describe("readCliDefaultUrl", () => {
  it("reads the URL from XDG cli.json read-only without needing or exposing a token", () => {
    const home = makeTempDir();
    const xdg = path.join(home, "xdg");
    fs.mkdirSync(path.join(xdg, "mend"), { recursive: true });
    fs.writeFileSync(
      path.join(xdg, "mend", "cli.json"),
      JSON.stringify({ url: "https://cli.example.com/", token: "secret-should-not-matter" }),
    );

    expect(readCliDefaultUrl({ XDG_CONFIG_HOME: xdg }, home)).toBe("https://cli.example.com");
    expect(
      readCliDefaultUrl({ XDG_CONFIG_HOME: xdg, MEND_URL: "http://localhost:3115" }, home),
    ).toBe("http://localhost:3115");
  });

  it("returns null when no CLI config exists", () => {
    const home = makeTempDir();
    expect(readCliDefaultUrl({ XDG_CONFIG_HOME: path.join(home, "empty") }, home)).toBeNull();
  });
});
