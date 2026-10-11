import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FastCheck } from "effect/testing";
import { describe, expect, it } from "vitest";

import {
  frame,
  makeFrameFeed,
  makePushSniffer,
  parseGitRemoteCommand,
} from "../src/git-transport.ts";

describe("parseGitRemoteCommand", () => {
  it("names the three git transport verbs", () => {
    expect(parseGitRemoteCommand("git-upload-pack '/srv/repo.git'")).toEqual({ kind: "fetch" });
    expect(parseGitRemoteCommand("git-receive-pack '/srv/repo.git'")).toEqual({ kind: "push" });
    expect(parseGitRemoteCommand("git-upload-archive '/srv/repo.git'")).toEqual({
      kind: "archive",
    });
    expect(parseGitRemoteCommand("git upload-pack '/srv/repo.git'")).toEqual({ kind: "fetch" });
  });

  it("refuses everything that is not git transport", () => {
    expect(parseGitRemoteCommand("rm -rf /")).toBeNull();
    expect(parseGitRemoteCommand("git-upload-packx '/x'")).toBeNull();
    expect(parseGitRemoteCommand("bash -c 'git-upload-pack x'")).toBeNull();
    expect(parseGitRemoteCommand("git-upload-pack")).toBeNull();
  });

  it.each([
    "git-upload-pack 'repo.git'; echo injected",
    "git-upload-pack 'repo.git'\necho injected",
    "git-upload-pack 'repo.git' && echo injected",
    "git-upload-pack 'repo.git' | cat",
    "git-upload-pack 'repo.git' > output",
    "git-upload-pack 'repo.git' &",
    "git-upload-pack $(echo repo.git)",
    "git-upload-pack `echo repo.git`",
    'git-upload-pack "$HOME/repo.git"',
    'git-upload-pack "$(echo repo.git)"',
    "git-upload-pack repo*.git",
    "git-upload-pack repo{a,b}.git",
    "git-upload-pack ~/repo.git",
    "git-upload-pack =git",
    "git-upload-pack 'repo.git' another.git",
    "git-upload-pack 'repo.git' --strict",
    "git-upload-pack --help",
    "git-upload-pack '-repo.git'",
    "git-upload-pack ''",
    "git-upload-pack 'unfinished",
    "git-upload-pack 'repo.git' # ignored",
    "git-upload-pack 'repo.git'\n",
    "git-upload-pack 'repo\u0000.git'",
  ])("refuses a command outside the single-repository grammar: %j", (command) => {
    expect(parseGitRemoteCommand(command)).toBeNull();
  });

  it.each([
    "git-upload-pack repo.git",
    "git-upload-pack '/srv/a repository.git'",
    "git-upload-pack '/srv/it'\\''s.git'",
    "git-upload-pack '/srv/wow'\\!'bang.git'",
    "git-upload-pack '/srv/$(literal);repo.git'",
    "git-upload-pack '/srv/unicode-λ.git'",
    "git-upload-pack './-repo.git'",
    "git-upload-pack '~developer/repo.git'",
    "git-upload-pack '=git'",
  ])("keeps literal repository arguments: %j", (command) => {
    expect(parseGitRemoteCommand(command)).toEqual({ kind: "fetch" });
  });

  it("accepts the quoting emitted by real Git without opening a connection", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mend-git-command-"));
    const captured = join(scratch, "argv.json");
    const ssh = join(scratch, "ssh.cjs");
    writeFileSync(
      ssh,
      'require("node:fs").writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2))); process.exit(1);',
    );
    try {
      const repositories = [
        "repo.git",
        "/srv/a repository.git",
        "/srv/it's!literal$(name);.git",
        "/srv/unicode-λ.git",
        "~developer/repo.git",
      ];
      for (const repository of repositories) {
        rmSync(captured, { force: true });
        const result = spawnSync(
          "git",
          [
            "-c",
            `core.sshCommand=${process.execPath} ${ssh}`,
            "ls-remote",
            `git@example.invalid:${repository}`,
          ],
          {
            cwd: scratch,
            env: {
              PATH: process.env["PATH"],
              HOME: scratch,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_SSH_VARIANT: "ssh",
              ARGV_FILE: captured,
            },
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        const argv: unknown = JSON.parse(readFileSync(captured, "utf8"));
        if (!Array.isArray(argv)) throw new Error("Git did not call the SSH recorder");
        const command: unknown = argv.at(-1);
        if (typeof command !== "string") throw new Error("Git sent no remote command");
        expect(parseGitRemoteCommand(command), command).toEqual({ kind: "fetch" });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects shell operators appended to otherwise valid generated repository paths", () => {
    const repository = FastCheck.array(FastCheck.constantFrom("a", "b", "0", "-", "_", "."), {
      minLength: 1,
      maxLength: 80,
    }).map((chars) => `repos/${chars.join("")}.git`);
    FastCheck.assert(
      FastCheck.property(
        repository,
        FastCheck.constantFrom(
          "; echo injected",
          "\necho injected",
          " && echo injected",
          " | cat",
          " > output",
          "$(echo injected)",
        ),
        (path, suffix) => {
          expect(parseGitRemoteCommand(`git-upload-pack '${path}'`)).toEqual({ kind: "fetch" });
          expect(parseGitRemoteCommand(`git-upload-pack '${path}'${suffix}`)).toBeNull();
        },
      ),
      { seed: 678, numRuns: 200 },
    );
  });
});

describe("frames", () => {
  it("round-trips through the feed, split at awkward boundaries", () => {
    const seen: Array<{ type: string; payload: string }> = [];
    const feed = makeFrameFeed((type, payload) => seen.push({ type, payload: payload.toString() }));
    const wire = Buffer.concat([
      frame("o", Buffer.from("hello")),
      frame("e", Buffer.from("warn")),
      frame("x", Buffer.from([3])),
    ]);
    // Feed byte by byte — a frame must never depend on chunk alignment.
    for (const byte of wire) feed(Buffer.from([byte]));
    expect(seen).toEqual([
      { type: "o", payload: "hello" },
      { type: "e", payload: "warn" },
      { type: "x", payload: "" },
    ]);
  });
});

const pkt = (line: string): Buffer => {
  const payload = Buffer.from(line);
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0")), payload]);
};

describe("makePushSniffer", () => {
  it("reads the ref commands ahead of the pack", () => {
    const oldSha = "a".repeat(40);
    const newSha = "b".repeat(40);
    const sniffer = makePushSniffer();
    const stream = Buffer.concat([
      pkt(`${oldSha} ${newSha} refs/heads/main\0 report-status side-band-64k`),
      pkt(`${oldSha} ${"c".repeat(40)} refs/heads/feature\n`),
      Buffer.from("0000"),
      Buffer.from("PACK..."),
    ]);
    // Split mid-pkt to prove reassembly.
    sniffer.feed(stream.subarray(0, 10));
    sniffer.feed(stream.subarray(10));
    expect(sniffer.updates()).toEqual([
      `${oldSha} ${newSha} refs/heads/main`,
      `${oldSha} ${"c".repeat(40)} refs/heads/feature`,
    ]);
  });

  it("answers null when the stream is not pkt-lines", () => {
    const sniffer = makePushSniffer();
    sniffer.feed(Buffer.from("not a pkt line at all"));
    expect(sniffer.updates()).toBeNull();
  });
});
