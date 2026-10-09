import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runExec,
  secretForms,
  startPickupChannel,
  type PickupChannel,
} from "../test/pickup-channel.ts";
import {
  parseHomeFileOutcomes,
  WORKSPACE_EXEC_ARG_CHARS,
  WORKSPACE_EXEC_BATCH_CHARS,
  writeAbsentHomeFilesExecs,
  writeFilesExecs,
  writeFilesPickupExec,
} from "./workspace-files.ts";

/** Run the execs with a real `sh`, the way a workspace would, and fail on the first nonzero exit. */
const runAll = (execs: ReadonlyArray<ReadonlyArray<string>>) => {
  for (const [command = "", ...args] of execs) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }
};

/** Mode bits, setgid included, of what is at `at`, never through a link. */
const modeOf = (at: string) => fs.lstatSync(at).mode & 0o7777;

/** Incompressible bytes: gzip keeps them about as large as they are. */
const randomOf = (size: number) => new Uint8Array(randomBytes(size));

/** Every argument under the per-argument limit; each exec's arguments under the batch, paths aside. */
const expectWithinLimits = (execs: ReadonlyArray<ReadonlyArray<string>>) => {
  for (const argv of execs) {
    const args = argv.slice(4);
    expect(args.some((arg) => arg.length > WORKSPACE_EXEC_ARG_CHARS)).toBe(false);
    expect(args.reduce((sum, arg) => sum + arg.length, 0)).toBeLessThan(
      WORKSPACE_EXEC_BATCH_CHARS + 10_000,
    );
  }
};

/** About 30 KB of a skill's text. */
const skillText = (index: number) =>
  new TextEncoder().encode(
    Array.from(
      { length: 600 },
      (_, line) => `- skill ${index}, rule ${line}: say what was observed\n`,
    ).join(""),
  );

describe("writeFilesExecs", () => {
  it("packs small files into one exec and writes them readable, directories included", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    const first = path.join(root, "skills", "a", "SKILL.md");
    const second = path.join(root, "skills", "b", "nested", "notes.md");
    const execs = writeFilesExecs([
      { path: first, bytes: new TextEncoder().encode("# a\n$(touch pwned)\n") },
      { path: second, bytes: new TextEncoder().encode("") },
    ]);
    expect(execs).toHaveLength(1);
    runAll(execs);
    expect(fs.readFileSync(first, "utf8")).toBe("# a\n$(touch pwned)\n");
    expect(fs.readFileSync(second, "utf8")).toBe("");
    expect(fs.existsSync(path.join(root, "pwned"))).toBe(false);
    expect(fs.statSync(first).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.dirname(first)).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(path.dirname(first))).toEqual(["SKILL.md"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a whole skills library in one exec: text compresses, and a copy travels once", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    // 60 files of ~30 KB of text in each of three harness directories: 5.4 MB written, which
    // took 60 execs per directory as base64 riding 90 KB at a time.
    const files = ["claude", "codex", "pi"].flatMap((harness) =>
      Array.from({ length: 60 }, (_, index) => ({
        path: path.join(root, `.${harness}`, "skills", `s${index}`, "SKILL.md"),
        bytes: skillText(index),
      })),
    );
    const execs = writeFilesExecs(files);
    expect(execs).toHaveLength(1);
    expectWithinLimits(execs);
    runAll(execs);
    for (const file of files) {
      expect(fs.readFileSync(file.path).equals(file.bytes)).toBe(true);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stages a content too large for one exec across several and writes it whole at the end", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    const target = path.join(root, "paste", "20260925-101010-abcd.png");
    const copy = path.join(root, "elsewhere", "same.png");
    const large = randomOf(1_600_000);
    const small = path.join(root, "paste", "small.txt");
    const execs = writeFilesExecs([
      { path: target, bytes: large },
      { path: copy, bytes: large },
      { path: small, bytes: new TextEncoder().encode("after") },
    ]);
    // ~2.13 M base64 characters are 24 arguments: 11, 11 and 2, the write riding the last with
    // the small file.
    expect(execs).toHaveLength(3);
    expectWithinLimits(execs);
    runAll(execs.slice(0, 2));
    // Until the last exec, readers see nothing at either path.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(copy)).toBe(false);
    runAll(execs.slice(2));
    expect(fs.readFileSync(target).equals(large)).toBe(true);
    expect(fs.readFileSync(copy).equals(large)).toBe(true);
    expect(fs.readdirSync(path.dirname(target)).toSorted()).toEqual([
      "20260925-101010-abcd.png",
      "small.txt",
    ]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(small, "utf8")).toBe("after");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a payload named like a staging file and its neighbour alike (review of #513)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    const names = ["data.mend-part", "data", "big.mend-gz64", "big", ".mend-part-0000000000000000"];
    const files = names.map((name, index) => ({
      path: path.join(root, "skill", name),
      bytes: index === 3 ? randomOf(1_600_000) : new TextEncoder().encode(`${name}\n`),
    }));
    const execs = writeFilesExecs(files);
    runAll(execs);
    for (const file of files) {
      expect(fs.readFileSync(file.path).equals(file.bytes)).toBe(true);
    }
    // Nothing of the writer's own is left beside them.
    expect(fs.readdirSync(path.join(root, "skill")).toSorted()).toEqual(names.toSorted());
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts a new exec when the next content would not fit", () => {
    const files = [0, 1, 2].map((index) => ({
      path: `/workspace/harness-home/f${index}`,
      bytes: randomOf(400_000),
    }));
    // 400 000 random bytes are ~533 000 characters: two never share one exec.
    const execs = writeFilesExecs(files);
    expect(execs).toHaveLength(3);
    expectWithinLimits(execs);
  });

  it("writes a path given twice with its last bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-files-"));
    const target = path.join(root, "a.txt");
    runAll(
      writeFilesExecs([
        { path: target, bytes: new TextEncoder().encode("first") },
        { path: target, bytes: new TextEncoder().encode("last") },
      ]),
    );
    expect(fs.readFileSync(target, "utf8")).toBe("last");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

const encode = (value: string) => new TextEncoder().encode(value);

/** Run each exec with `HOME` at `home`; return what they printed, one outcome per file. */
const runIn = (home: string, execs: ReadonlyArray<ReadonlyArray<string>>) =>
  execs.flatMap(([command = "", ...args]) => {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return parseHomeFileOutcomes(result.stdout);
  });

describe("writeFilesPickupExec", () => {
  let channel: PickupChannel;
  beforeAll(async () => {
    channel = await startPickupChannel();
  });
  afterAll(() => channel.close());

  it("writes every file from one exec and one pickup, and no byte of any rides the argv", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-pickup-"));
    const mcp = path.join(root, ".pi/agent/mend/profile/root/mcp.json");
    const settings = path.join(root, ".pi/agent/mend/profile/root/settings.json");
    const files = [
      {
        path: mcp,
        bytes: new TextEncoder().encode(
          '{"servers":{"x":{"headers":{"Authorization":"Bearer sk-live-0123456789abcdef"}}}}',
        ),
      },
      { path: settings, bytes: randomOf(300 * 1024) },
    ];
    const ticket = channel.mint(files);
    const argv = writeFilesPickupExec(
      files.map((file) => ({ path: file.path, secret: file.path === mcp })),
      ticket,
    );
    const joined = argv.join("\u0000");
    for (const file of files) {
      for (const form of secretForms(file.bytes)) expect(joined).not.toContain(form);
    }
    const before = channel.redemptions();
    const result = await runExec(argv, channel.env);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(channel.redemptions() - before).toBe(1);
    expect(fs.readFileSync(mcp)).toEqual(Buffer.from(files[0]?.bytes ?? []));
    expect(fs.readFileSync(settings)).toEqual(Buffer.from(files[1]?.bytes ?? []));
    expect(fs.readdirSync(path.dirname(mcp)).toSorted()).toEqual(["mcp.json", "settings.json"]);
    // The file with someone's keys is theirs alone; the rest stay readable.
    expect((fs.statSync(mcp).mode & 0o777).toString(8)).toBe("600");
    expect((fs.statSync(settings).mode & 0o777).toString(8)).toBe("644");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a person's saved state 0600, in directories made 0700, opening up none already there", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-pickup-"));
    const records = path.join(root, ".mend-saved");
    fs.mkdirSync(records, { mode: 0o700 });
    fs.chmodSync(records, 0o700);
    const manifest = path.join(records, "managed-skills.json");
    const memory = path.join(root, ".claude/projects/-workspace-repo/memory/MEMORY.md");
    const files = [
      { path: manifest, bytes: new TextEncoder().encode("{}") },
      { path: memory, bytes: new TextEncoder().encode("- learned\n") },
    ];
    const result = await runExec(
      writeFilesPickupExec(
        files.map((file) => ({ path: file.path, private: true })),
        channel.mint(files),
      ),
      channel.env,
    );
    expect(result.status).toBe(0);
    expect(fs.statSync(records).mode & 0o777).toBe(0o700);
    expect(fs.statSync(manifest).mode & 0o777).toBe(0o600);
    expect(fs.statSync(memory).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(memory)).mode & 0o777).toBe(0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes an absent-only file where nothing is, and leaves a file or a link already there as it was", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-pickup-"));
    const fresh = path.join(root, "sessions", "new.jsonl");
    const there = path.join(root, "sessions", "there.jsonl");
    const linked = path.join(root, "sessions", "linked.jsonl");
    fs.mkdirSync(path.dirname(there), { recursive: true });
    fs.writeFileSync(there, "the person's own\n");
    fs.symlinkSync(path.join(root, "nowhere"), linked);
    const files = [fresh, there, linked].map((at) => ({
      path: at,
      bytes: new TextEncoder().encode("from before\n"),
    }));
    const result = await runExec(
      writeFilesPickupExec(
        files.map((file) => ({ path: file.path, absent: true })),
        channel.mint(files),
      ),
      channel.env,
    );
    expect(result.status).toBe(0);
    expect(fs.readFileSync(fresh, "utf8")).toBe("from before\n");
    // Its own saved state: theirs alone.
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(there, "utf8")).toBe("the person's own\n");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(root, "nowhere"))).toBe(false);
    expect(result.stdout).toBe(`present ${there}\npresent ${linked}\n`);
    // Nothing staged is left.
    expect(fs.readdirSync(path.dirname(fresh)).toSorted()).toEqual([
      "linked.jsonl",
      "new.jsonl",
      "there.jsonl",
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a secret file into no directory reached through a link, and leaves nothing behind", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-pickup-"));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-elsewhere-"));
    fs.mkdirSync(path.join(root, "profile"));
    fs.symlinkSync(elsewhere, path.join(root, "profile", "root"));
    const target = path.join(root, "profile", "root", "mcp.json");
    const ticket = channel.mint([
      { path: target, bytes: new TextEncoder().encode("sk-live-secret-1") },
    ]);
    const result = await runExec(
      writeFilesPickupExec([{ path: target, secret: true }], ticket),
      channel.env,
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`not written: ${target} (its directory is really`);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  describe("a file kept inside its root (a pasted image, mend#597 review finding 2)", () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    const place = async (target: string, root: string, modes = { dir: 0o755, file: 0o644 }) =>
      runExec(
        writeFilesPickupExec(
          [
            {
              path: target,
              within: { root, directoryMode: modes.dir, fileMode: modes.file },
            },
          ],
          channel.mint([{ path: target, bytes: PNG }]),
        ),
        channel.env,
      );

    it("refuses a paste directory that is a link out of the root, writing and changing nothing there", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-paste-root-"));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mend-paste-outside-"));
      fs.chmodSync(outside, 0o700);
      fs.symlinkSync(outside, path.join(root, "paste"));
      const target = path.join(root, "paste", "20261010-120000-abcd.png");
      const result = await place(target, root);
      expect(result.status).toBe(3);
      expect(result.stderr).toBe(`mend-write: not written: ${target} (a link: ${root}/paste)\n`);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(modeOf(outside)).toBe(0o700);
      expect(fs.readdirSync(root)).toEqual(["paste"]);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it("refuses a link deeper down too, and a path outside the root", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-paste-root-"));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mend-paste-outside-"));
      fs.mkdirSync(path.join(root, "people"));
      fs.symlinkSync(outside, path.join(root, "people", "maria"));
      const deep = path.join(root, "people", "maria", "paste", "a.png");
      const linked = await place(deep, root);
      expect(linked.status).toBe(3);
      expect(linked.stderr).toContain(`(a link: ${root}/people/maria)`);
      const elsewhere = path.join(outside, "a.png");
      const out = await place(elsewhere, root);
      expect(out.status).toBe(3);
      expect(out.stderr).toContain(`(not inside ${root})`);
      const climbing = `${root}/paste/../../a.png`;
      const climbed = await place(climbing, root);
      expect(climbed.status).toBe(3);
      expect(climbed.stderr).toContain("(not a plain absolute path)");
      expect(fs.readdirSync(outside)).toEqual([]);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it("replaces a link at the file's own name, never writing through it", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-paste-root-"));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mend-paste-outside-"));
      const victim = path.join(outside, "victim");
      fs.writeFileSync(victim, "theirs");
      fs.mkdirSync(path.join(root, "paste"));
      const target = path.join(root, "paste", "a.png");
      fs.symlinkSync(victim, target);
      const result = await place(target, root);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(victim, "utf8")).toBe("theirs");
      expect(fs.lstatSync(target).isFile()).toBe(true);
      expect(new Uint8Array(fs.readFileSync(target))).toEqual(PNG);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it("keeps the mode of a directory already there, and makes a new one with the mode it names", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-paste-root-"));
      fs.mkdirSync(path.join(root, "paste"));
      fs.chmodSync(path.join(root, "paste"), 0o700);
      const kept = path.join(root, "paste", "a.png");
      expect((await place(kept, root)).status).toBe(0);
      expect(modeOf(path.join(root, "paste"))).toBe(0o700);
      expect(modeOf(kept)).toBe(0o644);
      expect(modeOf(root)).toBe(0o700);

      // A person's saved directory (docs/adr/0016): a new `paste/` 0770 and the image 0640,
      // whatever the writer's umask.
      const saved = path.join(root, "people", "maria");
      fs.mkdirSync(saved, { recursive: true });
      fs.chmodSync(saved, 0o710);
      const made = path.join(saved, "paste", "b.png");
      const result = await runExec(
        [
          "sh",
          "-c",
          'umask 077 && exec "$@"',
          "mend-as-person",
          ...writeFilesPickupExec(
            [{ path: made, within: { root: saved, directoryMode: 0o770, fileMode: 0o640 } }],
            channel.mint([{ path: made, bytes: PNG }]),
          ),
        ],
        channel.env,
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(modeOf(path.join(saved, "paste"))).toBe(0o770);
      expect(modeOf(made)).toBe(0o640);
      expect(modeOf(saved)).toBe(0o710);
      expect(new Uint8Array(fs.readFileSync(made))).toEqual(PNG);
      // Nothing staged is left beside it.
      expect(fs.readdirSync(path.join(saved, "paste"))).toEqual(["b.png"]);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("carries only the ticket, the root and the path in its arguments", () => {
      const argv = writeFilesPickupExec(
        [
          {
            path: "/workspace/harness-home/people/u1/paste/a.png",
            within: {
              root: "/workspace/harness-home/people/u1",
              directoryMode: 0o770,
              fileMode: 0o640,
            },
          },
        ],
        "ticket-1",
      );
      expect(argv.slice(4)).toEqual([
        "ticket-1",
        "C770:640:/workspace/harness-home/people/u1",
        "/workspace/harness-home/people/u1/paste/a.png",
      ]);
    });
  });

  it("fails, naming the reason and no byte, when the ticket is spent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-pickup-"));
    const target = path.join(root, "mcp.json");
    const ticket = channel.mint([
      { path: target, bytes: new TextEncoder().encode("token-abcdefgh") },
    ]);
    channel.tickets.discard(ticket);
    const result = await runExec(writeFilesPickupExec([{ path: target }], ticket), channel.env);
    expect(result.status).toBe(3);
    expect(result.stderr).toBe(
      "mend-write: the pickup was refused: this pickup ticket is spent, expired or unknown\n",
    );
    expect(fs.existsSync(target)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("writeAbsentHomeFilesExecs", () => {
  it("writes each absent file under $HOME, directories included, and reports it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-home-files-"));
    const execs = writeAbsentHomeFilesExecs([
      { path: ".zshrc", bytes: encode("# a\n$(touch pwned)\n") },
      { path: ".config/starship.toml", bytes: encode("add_newline = false\n") },
    ]);
    expect(execs).toHaveLength(1);
    expect(runIn(home, execs)).toEqual([
      { path: ".zshrc", outcome: "written" },
      { path: ".config/starship.toml", outcome: "written" },
    ]);
    expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("# a\n$(touch pwned)\n");
    expect(fs.readFileSync(path.join(home, ".config/starship.toml"), "utf8")).toBe(
      "add_newline = false\n",
    );
    expect(fs.statSync(path.join(home, ".zshrc")).mode & 0o777).toBe(0o644);
    expect(fs.existsSync(path.join(home, "pwned"))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("leaves a file, a symlink (even a dangling one) and a directory where they are", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-home-files-"));
    fs.writeFileSync(path.join(home, ".zshrc"), "mine\n");
    fs.mkdirSync(path.join(home, ".config"), { mode: 0o700 });
    fs.symlinkSync(
      path.join(home, "dots", "starship.toml"),
      path.join(home, ".config/starship.toml"),
    );
    fs.mkdirSync(path.join(home, ".bashrc"));
    const execs = writeAbsentHomeFilesExecs([
      { path: ".zshrc", bytes: encode("mend\n") },
      { path: ".config/starship.toml", bytes: encode("mend\n") },
      { path: ".bashrc", bytes: encode("mend\n") },
      { path: ".config/new.toml", bytes: encode("new\n") },
    ]);
    expect(runIn(home, execs)).toEqual([
      { path: ".zshrc", outcome: "present" },
      { path: ".config/starship.toml", outcome: "present" },
      { path: ".bashrc", outcome: "present" },
      { path: ".config/new.toml", outcome: "written" },
    ]);
    expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("mine\n");
    expect(fs.lstatSync(path.join(home, ".config/starship.toml")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, "dots"))).toBe(false);
    expect(fs.statSync(path.join(home, ".bashrc")).isDirectory()).toBe(true);
    // An existing directory keeps its own mode.
    expect(fs.statSync(path.join(home, ".config")).mode & 0o777).toBe(0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("splits files that would pass the argument budget across execs", () => {
    const large = "x".repeat(WORKSPACE_EXEC_ARG_CHARS / 2);
    const execs = writeAbsentHomeFilesExecs([
      { path: "a", bytes: encode(large) },
      { path: "b", bytes: encode(large) },
    ]);
    expect(execs).toHaveLength(2);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-home-files-"));
    expect(runIn(home, execs).map((outcome) => outcome.outcome)).toEqual(["written", "written"]);
    expect(fs.readFileSync(path.join(home, "b"), "utf8")).toBe(large);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
