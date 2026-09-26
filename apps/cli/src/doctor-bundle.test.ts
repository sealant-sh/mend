import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  bundleFileName,
  bundleReport,
  collectBundle,
  doctorBundleCommand,
  formatBytes,
  NOTICE,
  parseBundleArgs,
  redact,
  tarGz,
  writeBundle,
} from "./doctor-bundle.ts";

/** Enough of ustar to read back what `tarGz` wrote: name (with prefix), size, content. */
const readTar = (
  archive: Buffer,
): ReadonlyArray<{ readonly path: string; readonly content: string }> => {
  const bytes = gunzipSync(archive);
  const entries: Array<{ path: string; content: string }> = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number): string =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .split("\u0000")[0] ?? "";
    const size = Number.parseInt(text(124, 12), 8);
    const prefix = text(345, 155);
    const name = text(0, 100);
    const stored = header.subarray(148, 156).toString("ascii");
    let sum = 0;
    for (let index = 0; index < 512; index += 1)
      sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
    expect(Number.parseInt(stored, 8)).toBe(sum);
    expect(text(257, 6)).toBe("ustar");
    entries.push({
      path: prefix === "" ? name : `${prefix}/${name}`,
      content: bytes.subarray(offset + 512, offset + 512 + size).toString("utf8"),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
};

const temporary: Array<string> = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const tmp = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mend-bundle-test-"));
  temporary.push(directory);
  return directory;
};

describe("redact", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["authorization header", "Authorization: Bearer abc.def-123", "Authorization: [redacted]"],
    ["lowercase header", "authorization: Basic dXNlcjpwdw==", "authorization: [redacted]"],
    [
      "bearer in prose",
      "sent Bearer sk-ant-api03-abcdef to the server",
      "sent Bearer [redacted] to the server",
    ],
    ["slack bot token", "token xoxb-123456789-abcdefGHIJ", "token [redacted]"],
    ["slack user token", "xoxp-1-2-3-abc", "[redacted]"],
    ["slack app token", "xapp-1-A0123-456-abcdef", "[redacted]"],
    ["openai / anthropic key", "key sk-proj-AbCdEf1234567890", "key [redacted]"],
    ["github classic", "ghp_ABCDEFghijkl0123456789", "[redacted]"],
    ["github oauth", "gho_ABCDEFghijkl0123456789", "[redacted]"],
    ["github fine-grained", "github_pat_11ABCDE_abcdefghijk", "[redacted]"],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "[redacted]",
    ],
    [
      "postgres url",
      "postgres://mend:s3cr3t@db:5432/mend",
      "postgres://mend:[redacted]@db:5432/mend",
    ],
    ["postgresql url", "DATABASE=postgresql://u:p%40ss@h/db", "DATABASE=[redacted]"],
    [
      "https url with credentials",
      "https://user:hunter2@git.example.com/x.git",
      "https://user:[redacted]@git.example.com/x.git",
    ],
    ["aws access key", "AKIAIOSFODNN7EXAMPLE", "[redacted]"],
    ["password= lowercase", "password=hunter2&next=1", "password=[redacted]&next=1"],
    ["PASSWORD= uppercase", "PASSWORD=hunter2", "PASSWORD=[redacted]"],
    ["secret: yaml", "client_secret: abc123", "client_secret: [redacted]"],
    ["token= query", "?token=abc123&x=1", "?token=[redacted]&x=1"],
    [
      '"token": json',
      '{"token": "abc123", "deviceId": "d1"}',
      '{"token": "[redacted]", "deviceId": "d1"}',
    ],
    ["api key json", '"apiKey":"abc"', '"apiKey":"[redacted]"'],
    [
      "dotenv line",
      "MEND_DATABASE_URL=postgres://a:b@c/d\nPLAIN=1",
      "MEND_DATABASE_URL=[redacted]\nPLAIN=[redacted]",
    ],
    [
      "exported dotenv line",
      "export GITHUB_TOKEN=ghp_abcdef123456",
      "export GITHUB_TOKEN=[redacted]",
    ],
  ];
  for (const [label, input, expected] of cases) {
    it(`redacts ${label}`, () => {
      expect(redact(input)).toBe(expected);
    });
  }

  it("leaves booleans and nulls beside a secret-named key", () => {
    expect(redact('"hasRefreshToken": true, "secret": null')).toBe(
      '"hasRefreshToken": true, "secret": null',
    );
  });

  it("leaves ordinary text alone", () => {
    const text =
      "✓ server      https://alpha.mend.run · mend 0.31.0\n✓ signed in   token accepted\n";
    expect(redact(text)).toBe(text);
    expect(redact('{"mendEnvNames": ["MEND_TOKEN", "MEND_URL"]}')).toBe(
      '{"mendEnvNames": ["MEND_TOKEN", "MEND_URL"]}',
    );
  });
});

describe("tarGz", () => {
  it("writes a ustar archive that reads back, with long names in the prefix", () => {
    const long = `mend-bundle-2026-09-26T10-15-30Z/sessions/${"a".repeat(80)}-record.txt`;
    const archive = tarGz(
      [
        { path: "root/cli.json", content: Buffer.from("{}\n") },
        { path: "root/server-logs/mend.log", content: Buffer.from("x".repeat(1000)) },
        { path: long, content: Buffer.from("tail") },
      ],
      new Date("2026-09-26T10:15:30Z"),
    );
    expect(readTar(archive)).toEqual([
      { path: "root/cli.json", content: "{}\n" },
      { path: "root/server-logs/mend.log", content: "x".repeat(1000) },
      { path: long, content: "tail" },
    ]);
  });
});

describe("collectBundle", () => {
  it("keeps every collector's files, writes a failing collector's error, redacts all of it", async () => {
    const files = await collectBundle([
      {
        name: "cli",
        collect: async () => [{ path: "cli.json", content: '{"token": "abc"}\n' }],
      },
      {
        name: "docker",
        collect: async () => {
          throw new Error("docker version failed: spawn docker ENOENT · Bearer ghp_abcdef123456");
        },
      },
      {
        name: "logs",
        collect: async () => [
          { path: "logs/a.log", content: "one\n" },
          { path: "logs/b.log", content: "two\n" },
        ],
      },
    ]);
    expect(files.map((file) => file.path)).toEqual([
      "cli.json",
      "docker.error.txt",
      "logs/a.log",
      "logs/b.log",
    ]);
    expect(files[0]?.content).toBe('{"token": "[redacted]"}\n');
    expect(files[1]?.content).toContain("docker version failed: spawn docker ENOENT");
    expect(files[1]?.content).not.toContain("ghp_abcdef");
    expect(files[1]?.content).toContain("Bearer [redacted]");
  });
});

describe("writeBundle", () => {
  it("creates the directory 0700, the file 0600, and reports each entry's size", () => {
    const root = tmp();
    const out = path.join(root, "bundles", "mend-bundle-2026-09-26T10-15-30Z.tgz");
    const written = writeBundle(
      [
        { path: "cli.json", content: "{}\n" },
        { path: "server-logs/mend.log", content: "line\n" },
      ],
      out,
      new Date("2026-09-26T10:15:30Z"),
    );
    expect(written.path).toBe(out);
    expect(written.entries).toEqual([
      { path: "cli.json", bytes: 3 },
      { path: "server-logs/mend.log", bytes: 5 },
    ]);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(out)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    }
    expect(readTar(fs.readFileSync(out)).map((entry) => entry.path)).toEqual([
      "mend-bundle-2026-09-26T10-15-30Z/cli.json",
      "mend-bundle-2026-09-26T10-15-30Z/server-logs/mend.log",
    ]);
  });

  it("names the archive by UTC time and reports sizes as a person reads them", () => {
    expect(bundleFileName(new Date("2026-09-26T10:15:30.123Z"))).toBe(
      "mend-bundle-2026-09-26T10-15-30Z.tgz",
    );
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 kB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(
      bundleReport({
        path: "/tmp/x.tgz",
        bytes: 2048,
        entries: [
          { path: "cli.json", bytes: 3 },
          { path: "server-logs/mend.log", bytes: 1536 },
        ],
      }),
    ).toEqual([
      "/tmp/x.tgz · 2.0 kB",
      "  cli.json              3 B",
      "  server-logs/mend.log  1.5 kB",
      NOTICE,
    ]);
  });
});

describe("parseBundleArgs", () => {
  it("takes --out and --tail, defaults tail to 500, bounds it, and refuses the rest", () => {
    expect(parseBundleArgs(["--bundle"])).toEqual({ kind: "ok", args: { out: null, tail: 500 } });
    expect(parseBundleArgs(["--bundle", "--out", "/tmp/b.tgz", "--tail", "2000"])).toEqual({
      kind: "ok",
      args: { out: "/tmp/b.tgz", tail: 2000 },
    });
    for (const bad of [
      ["--bundle", "--tail", "0"],
      ["--bundle", "--tail", "2001"],
      ["--bundle", "--tail", "many"],
      ["--bundle", "--out"],
      ["--bundle", "--session", "abc"],
    ]) {
      const parsed = parseBundleArgs(bad);
      expect(parsed.kind, bad.join(" ")).toBe("usage");
      if (parsed.kind === "usage") expect(parsed.message).toContain("usage: mend doctor");
    }
  });
});

describe("doctorBundleCommand", () => {
  it("writes the default path, prints the path, the files and the notice", async () => {
    const root = tmp();
    const said: Array<string> = [];
    const warned: Array<string> = [];
    await doctorBundleCommand(["--bundle"], {
      defaultDir: path.join(root, "bundles"),
      now: () => new Date("2026-09-26T10:15:30Z"),
      say: (line) => said.push(line),
      warn: (line) => warned.push(line),
      collectors: (tail) => [
        {
          name: "cli",
          collect: async () => [{ path: "cli.json", content: `{"tail": ${tail}}\n` }],
        },
        {
          name: "server-logs",
          collect: async () => {
            throw new Error("no Mend server is installed on this machine");
          },
        },
      ],
    });
    const out = path.join(root, "bundles", "mend-bundle-2026-09-26T10-15-30Z.tgz");
    expect(fs.existsSync(out)).toBe(true);
    expect(said[0]).toMatch(new RegExp(`^${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · `));
    expect(said.slice(1, -1).map((line) => line.trim().split(/\s{2,}/)[0])).toEqual([
      "cli.json",
      "server-logs.error.txt",
    ]);
    expect(said.at(-1)).toBe(NOTICE);
    expect(readTar(fs.readFileSync(out)).map((entry) => entry.content)).toEqual([
      '{"tail": 500}\n',
      expect.stringContaining("no Mend server is installed on this machine"),
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the usage line for a bad option and sets the exit code", async () => {
    const warned: Array<string> = [];
    await doctorBundleCommand(["--bundle", "--tail", "x"], {
      defaultDir: tmp(),
      now: () => new Date(),
      say: () => {},
      warn: (line) => warned.push(line),
      collectors: () => [],
    });
    expect(warned[0]).toContain("--tail needs a number");
    expect(warned[0]).toContain("usage: mend doctor");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
