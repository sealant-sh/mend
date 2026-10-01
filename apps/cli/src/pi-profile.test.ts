import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { validatePiProfile } from "@mend/domain/workbench";
import { afterEach, describe, expect, it } from "vitest";

import { piProfileLines, scanPiProfile } from "./pi-profile.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-pi-scan-"));
  dirs.push(dir);
  return dir;
};

const write = (file: string, contents: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};

/**
 * A setup laid out as Home Manager lays one out: the extensions and themes are links into a store,
 * and one package in settings.json is a store path.
 */
const linkedSetup = () => {
  const root = tempDir();
  const store = path.join(root, "store");
  const agent = path.join(root, "agent");
  write(path.join(store, "runtime", "extensions", "git-info", "index.ts"), "export default 1;\n");
  write(
    path.join(store, "runtime", "extensions", "git-info", "banner.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
  );
  write(path.join(store, "runtime", "extensions", "save-md.ts"), "export default 2;\n");
  write(path.join(store, "runtime", "extensions", "git-info", "node_modules", "x.js"), "no");
  write(path.join(store, "runtime", "themes", "dark.json"), "{}");
  const usage = path.join(store, "0123456789abcdefghijklmnopqrstuv-pi-usage-0.60.3-astra");
  write(
    path.join(usage, "package.json"),
    JSON.stringify({ name: "@narumitw/pi-usage", pi: { extensions: ["./dist/index.ts"] } }),
  );
  write(path.join(usage, "dist", "index.ts"), "export default 3;\n");
  fs.mkdirSync(agent, { recursive: true });
  fs.symlinkSync(path.join(store, "runtime", "extensions"), path.join(agent, "extensions"));
  fs.symlinkSync(path.join(store, "runtime", "themes"), path.join(agent, "themes"));
  write(
    path.join(store, "modules", "effect", "package.json"),
    JSON.stringify({ name: "effect", version: "4.0.0-beta.101" }),
  );
  write(
    path.join(store, "modules", "@effect", "platform-node", "package.json"),
    JSON.stringify({ name: "@effect/platform-node", version: "4.0.0-beta.101" }),
  );
  write(
    path.join(store, "modules", "@earendil-works", "pi-ai", "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.0.0" }),
  );
  write(path.join(store, "modules", ".package-lock.json"), "{}");
  fs.symlinkSync(path.join(store, "modules"), path.join(agent, "node_modules"));
  write(
    path.join(agent, "settings.json"),
    JSON.stringify({
      theme: "dark",
      lastChangelogVersion: "0.99.1",
      packages: [
        "npm:pi-web-access@0.23.0",
        usage,
        { source: "npm:pi-lens@4.0.1", extensions: [] },
        "./gone",
      ],
    }),
  );
  write(
    path.join(agent, "mcp.json"),
    JSON.stringify({ mcpServers: { executor: { command: "/nix/store/x-executor/bin/executor" } } }),
  );
  write(path.join(agent, "auth.json"), '{"openai-codex":{"access":"secret"}}');
  write(path.join(agent, "sessions", "a.jsonl"), "{}");
  write(path.join(agent, "trust.json"), "{}");
  return { agent, usage };
};

describe("reading a pi setup as a profile", () => {
  it("reads linked files as what they point at, and leaves logins, sessions and installs here", () => {
    const { agent } = linkedSetup();
    const scan = scanPiProfile(agent);
    if ("error" in scan) throw new Error(scan.error);
    expect(scan.files.map((file) => file.path).toSorted()).toEqual([
      "extensions/git-info/banner.png",
      "extensions/git-info/index.ts",
      "extensions/save-md.ts",
      "package.json",
      "packages/pi-usage/dist/index.ts",
      "packages/pi-usage/package.json",
      "root/mcp.json",
      "settings.json",
      "themes/dark.json",
    ]);
    const banner = scan.files.find((file) => file.path === "extensions/git-info/banner.png");
    expect(banner?.encoding).toBe("base64");
    expect(Buffer.from(banner?.contents ?? "", "base64")).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );
    expect(JSON.stringify(scan.files)).not.toContain("secret");
    expect(scan.leftHere).toEqual([
      "auth.json (pi runs on your ChatGPT login: mend connect codex)",
      "sessions",
      "trust.json",
    ]);
    expect(validatePiProfile(scan.files)).toBeNull();
  });

  it("names what the node_modules beside the extensions holds when no package.json does", () => {
    const { agent } = linkedSetup();
    const scan = scanPiProfile(agent);
    if ("error" in scan) throw new Error(scan.error);
    const manifest = scan.files.find((file) => file.path === "package.json");
    // pi provides its own packages to extensions: an installed copy is left out.
    expect(JSON.parse(manifest?.contents ?? "").dependencies).toEqual({
      "@effect/platform-node": "4.0.0-beta.101",
      effect: "4.0.0-beta.101",
    });
    expect(scan.beside).toContain("package.json (written from node_modules: 2 packages)");
  });

  it("copies a package named by path into the profile and points settings.json at the copy", () => {
    const { agent, usage } = linkedSetup();
    const scan = scanPiProfile(agent);
    if ("error" in scan) throw new Error(scan.error);
    const settings = scan.files.find((file) => file.path === "settings.json");
    expect(JSON.parse(settings?.contents ?? "")).toEqual({
      theme: "dark",
      packages: [
        "npm:pi-web-access@0.23.0",
        "./mend/profile/packages/pi-usage",
        { source: "npm:pi-lens@4.0.1", extensions: [] },
      ],
    });
    expect(scan.packages).toEqual([
      { source: "npm:pi-web-access@0.23.0", from: null },
      { source: "./mend/profile/packages/pi-usage", from: usage },
      { source: "npm:pi-lens@4.0.1", from: null },
    ]);
    expect(scan.notes).toEqual([
      "package ./gone: not on this machine, left out",
      "mcp.json: server executor runs /nix/store/x-executor/bin/executor, a path on this machine a session may not have",
    ]);
  });

  it("says what it will send before it sends it", () => {
    const { agent } = linkedSetup();
    const scan = scanPiProfile(agent);
    if ("error" in scan) throw new Error(scan.error);
    expect(piProfileLines(scan)).toEqual([
      `pi profile · ${agent} · 9 files · 1 KB`,
      "  extensions  2 · git-info, save-md.ts",
      "  themes      1",
      "  prompts     0",
      `  packages    npm:pi-web-access@0.23.0, ${scan.packages[1]?.from} (copied in), npm:pi-lens@4.0.1`,
      "  settings    theme",
      "  also        mcp.json (as it is, with any keys in it), package.json (written from node_modules: 2 packages)",
      "  left here   auth.json (pi runs on your ChatGPT login: mend connect codex), sessions, trust.json",
      "  ! package ./gone: not on this machine, left out",
      "  ! mcp.json: server executor runs /nix/store/x-executor/bin/executor, a path on this machine a session may not have",
    ]);
  });

  it("refuses a settings.json that is not a JSON object, and a missing agent directory", () => {
    const { agent } = linkedSetup();
    write(path.join(agent, "settings.json"), "[1]");
    expect(scanPiProfile(agent)).toEqual({
      error: `${path.join(agent, "settings.json")} is not a JSON object; fix it or move it aside first`,
    });
    const missing = path.join(tempDir(), "none");
    expect(scanPiProfile(missing)).toEqual({
      error: `no pi agent directory at ${missing}; run pi once, or pass --dir`,
    });
  });
});
