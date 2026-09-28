import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_NOTE,
  LEGACY_NOTE_MARKER,
  parseWorkspaceNoteOutcomes,
  WORKSPACE_NOTE_BEGIN,
  WORKSPACE_NOTE_FILES,
  workspaceNoteBlock,
  workspaceNoteExec,
} from "./workspace-note.ts";

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    spawnSync("chmod", ["-R", "u+rwx", home]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A fresh `$HOME`, with a space in it: the paths ride quoted. */
const makeHome = () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mend-note-")), "the home");
  fs.mkdirSync(home);
  homes.push(path.dirname(home));
  return home;
};

const claude = (home: string) => path.join(home, ".claude", "CLAUDE.md");
const codex = (home: string) => path.join(home, ".codex", "AGENTS.md");

/** Run the exec exactly as the engine hands it to a workspace. */
const runNote = (home: string, body: string) => {
  const [command = "", ...args] = workspaceNoteExec(body);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return new Map(
    parseWorkspaceNoteOutcomes(result.stdout).map((outcome) => [outcome.file, outcome]),
  );
};

const write = (file: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const BODY = "## Mend mounts\n\nMounted beside the repo:\n\n\n## Mend Services\n\nRun things.\n\n";
const NEW_BODY = "## Mend mounts\n\nMounted beside the repo:\n\n- /workspace/ref/api\n\n";

/** An open-ended note as one of Mend's old generators wrote it (`engine.ts`, before review 17). */
const legacyNote = (options: {
  readonly services: string | null;
  readonly sections: ReadonlyArray<{ heading: string; bullets: ReadonlyArray<string> }>;
  readonly declared: string | null;
}) =>
  `\n${LEGACY_NOTE_MARKER}\n${LEGACY_NOTE.header}` +
  options.sections
    .map((section) => `${section.heading}\n\n${section.bullets.join("\n")}\n\n`)
    .join("") +
  (options.services === null
    ? ""
    : `\n${options.services}${options.declared === null ? "" : `${options.declared}\n\n`}`);

const OWNER = "# Owner instructions\nUse the local test runner.\n";
const AFTER = "\n## My project notes\nKeep the migration compatibility shim until v3.\n";

describe("workspace note", () => {
  it("creates an absent file with the block alone, and a second run writes nothing", () => {
    const home = makeHome();
    const first = runNote(home, BODY);
    expect(first.get(claude(home))?.outcome).toBe("created");
    expect(first.get(codex(home))?.outcome).toBe("created");
    expect(fs.readFileSync(claude(home), "utf8")).toBe(workspaceNoteBlock(BODY));
    const before = fs.statSync(claude(home));
    const second = runNote(home, BODY);
    expect(second.get(claude(home))?.outcome).toBe("unchanged");
    const after = fs.statSync(claude(home));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("replaces only the block: text before and after it stays byte for byte", () => {
    const home = makeHome();
    for (const file of [claude(home), codex(home)]) {
      write(file, `${OWNER}\n${workspaceNoteBlock(BODY)}${AFTER}`);
    }
    const outcomes = runNote(home, NEW_BODY);
    for (const file of [claude(home), codex(home)]) {
      expect(outcomes.get(file)?.outcome).toBe("replaced");
      expect(fs.readFileSync(file, "utf8")).toBe(
        `${OWNER}\n${workspaceNoteBlock(NEW_BODY)}${AFTER}`,
      );
    }
  });

  it("appends the block after the user's text, adding the newline a file may lack", () => {
    const home = makeHome();
    write(claude(home), "no trailing newline");
    write(codex(home), OWNER);
    const outcomes = runNote(home, BODY);
    expect(outcomes.get(claude(home))?.outcome).toBe("appended");
    expect(fs.readFileSync(claude(home), "utf8")).toBe(
      `no trailing newline\n\n${workspaceNoteBlock(BODY)}`,
    );
    expect(fs.readFileSync(codex(home), "utf8")).toBe(`${OWNER}\n${workspaceNoteBlock(BODY)}`);
  });

  describe("an open-ended note from an earlier Mend", () => {
    const sections = [
      {
        heading: LEGACY_NOTE.headings[0],
        bullets: ["- /workspace/ref/effect", "- /workspace/ref/react"],
      },
      { heading: LEGACY_NOTE.headings[1], bullets: ["- /workspace/repos/api"] },
      {
        heading: LEGACY_NOTE.headings[2],
        bullets: [
          `- /workspace/home/notes${LEGACY_NOTE.suffixes[0]}`,
          `- /workspace/home/scratch${LEGACY_NOTE.suffixes[1]}`,
        ],
      },
      {
        heading: LEGACY_NOTE.headings[3],
        bullets: [`- /workspace/folders/data${LEGACY_NOTE.suffixes[2]}`],
      },
    ];
    const cases = [
      // The first generator: mounts only, no Services section.
      { name: "mounts only", note: legacyNote({ services: null, sections, declared: null }) },
      ...LEGACY_NOTE.services.flatMap((services, index) => [
        {
          name: `Services variant ${index + 1}, no mounts`,
          note: legacyNote({ services, sections: [], declared: null }),
        },
        {
          name: `Services variant ${index + 1}, every section and declared recipes`,
          note: legacyNote({
            services,
            sections,
            declared:
              index === 0
                ? "Declared Services (mend.toml): web, db — start one with `mend service run <name>`."
                : "Declared Services (mend.toml + project): web — start one with `mend service run <name>`.",
          }),
        },
      ]),
    ];

    for (const scenario of cases) {
      it(`${scenario.name}: becomes the block, and what follows it stays`, () => {
        const home = makeHome();
        write(claude(home), `${OWNER}${scenario.note}${AFTER}`);
        // A file that only ever held the note (the generator created it) and nothing after.
        write(codex(home), scenario.note);
        const outcomes = runNote(home, NEW_BODY);
        expect(outcomes.get(claude(home))?.outcome).toBe("migrated");
        expect(fs.readFileSync(claude(home), "utf8")).toBe(
          `${OWNER}\n${workspaceNoteBlock(NEW_BODY)}${AFTER}`,
        );
        expect(outcomes.get(codex(home))?.outcome).toBe("migrated");
        expect(fs.readFileSync(codex(home), "utf8")).toBe(workspaceNoteBlock(NEW_BODY));
      });
    }

    it("the pre-fix engine's own output, restored by a capture, with the user's text after it", () => {
      const home = makeHome();
      const fixture = fs.readFileSync(
        new URL("../test/fixtures/workspace-note-legacy.txt", import.meta.url),
        "utf8",
      );
      write(claude(home), fixture);
      const outcomes = runNote(home, NEW_BODY);
      expect(outcomes.get(claude(home))?.outcome).toBe("migrated");
      expect(fs.readFileSync(claude(home), "utf8")).toBe(
        `${OWNER}\n${workspaceNoteBlock(NEW_BODY)}${AFTER}`,
      );
    });

    const edits = [
      {
        name: "a line inside the mounts",
        edit: (note: string) =>
          note.replace("- /workspace/ref/react\n", "- /workspace/ref/react\nread these first\n"),
      },
      {
        name: "a reworded Services paragraph",
        edit: (note: string) => note.replace("NEVER background", "Never ever background"),
      },
      {
        name: "a line between the mounts and the Services section",
        edit: (note: string) =>
          note.replace("\n\n## Mend Services", "\n\nmine\n\n## Mend Services"),
      },
      {
        name: "a mount path with a space",
        edit: (note: string) => note.replace("/workspace/repos/api", "/workspace/repos/my api"),
      },
    ];
    for (const { name, edit } of edits) {
      it(`${name}: nothing of it is removed, and the block is added at the end`, () => {
        const home = makeHome();
        const note = edit(
          legacyNote({ services: LEGACY_NOTE.services[3], sections, declared: null }),
        );
        const original = `${OWNER}${note}${AFTER}`;
        write(claude(home), original);
        const outcomes = runNote(home, NEW_BODY);
        expect(outcomes.get(claude(home))?.outcome).toBe("appended-legacy-kept");
        expect(fs.readFileSync(claude(home), "utf8")).toBe(
          `${original}\n${workspaceNoteBlock(NEW_BODY)}`,
        );
        // The next launch finds its block and replaces only that.
        expect(runNote(home, BODY).get(claude(home))?.outcome).toBe("replaced");
        expect(fs.readFileSync(claude(home), "utf8")).toBe(
          `${original}\n${workspaceNoteBlock(BODY)}`,
        );
      });
    }

    it("an old note a rolled-back Mend added after the block goes; the text after it stays", () => {
      const home = makeHome();
      const note = legacyNote({ services: LEGACY_NOTE.services[3], sections: [], declared: null });
      write(claude(home), `${OWNER}\n${workspaceNoteBlock(BODY)}${note}${AFTER}`);
      expect(runNote(home, NEW_BODY).get(claude(home))?.outcome).toBe("replaced");
      expect(fs.readFileSync(claude(home), "utf8")).toBe(
        `${OWNER}\n${workspaceNoteBlock(NEW_BODY)}${AFTER}`,
      );
    });
  });

  it("markers that do not form exactly one block leave the file as it is", () => {
    const home = makeHome();
    const block = workspaceNoteBlock(BODY);
    const twice = `${OWNER}\n${block}mine\n${block}`;
    const unclosed = `${OWNER}\n${WORKSPACE_NOTE_BEGIN} -->\nmine, all of it\n`;
    write(claude(home), twice);
    write(codex(home), unclosed);
    const outcomes = runNote(home, NEW_BODY);
    expect(outcomes.get(claude(home))?.outcome).toBe("ambiguous");
    expect(outcomes.get(codex(home))?.outcome).toBe("ambiguous");
    expect(fs.readFileSync(claude(home), "utf8")).toBe(twice);
    expect(fs.readFileSync(codex(home), "utf8")).toBe(unclosed);
  });

  it("a failed read is never a rewrite: a directory, an unreadable file, bytes that are not UTF-8", () => {
    const home = makeHome();
    fs.mkdirSync(claude(home), { recursive: true });
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    write(codex(home), latin1);
    let outcomes = runNote(home, BODY);
    expect(outcomes.get(claude(home))).toMatchObject({ outcome: "unreadable", detail: "EISDIR" });
    expect(outcomes.get(codex(home))).toMatchObject({ outcome: "unreadable", detail: "not-utf8" });
    expect(fs.statSync(claude(home)).isDirectory()).toBe(true);
    expect(fs.readFileSync(codex(home)).equals(latin1)).toBe(true);

    if (process.getuid?.() === 0) return;
    fs.rmSync(claude(home), { recursive: true });
    write(claude(home), `${OWNER}${AFTER}`);
    fs.chmodSync(claude(home), 0o000);
    outcomes = runNote(home, BODY);
    expect(outcomes.get(claude(home))).toMatchObject({ outcome: "unreadable", detail: "EACCES" });
    fs.chmodSync(claude(home), 0o644);
    expect(fs.readFileSync(claude(home), "utf8")).toBe(`${OWNER}${AFTER}`);
  });

  it("a write that fails leaves the file as it was and no temporary file behind", () => {
    if (process.getuid?.() === 0) return;
    const home = makeHome();
    write(claude(home), `${OWNER}${AFTER}`);
    fs.chmodSync(path.dirname(claude(home)), 0o555);
    const outcomes = runNote(home, BODY);
    expect(outcomes.get(claude(home))).toMatchObject({ outcome: "failed", detail: "EACCES" });
    fs.chmodSync(path.dirname(claude(home)), 0o755);
    expect(fs.readFileSync(claude(home), "utf8")).toBe(`${OWNER}${AFTER}`);
    expect(fs.readdirSync(path.dirname(claude(home)))).toEqual(["CLAUDE.md"]);
  });

  it("keeps the mode, writes a symlink's target, and keeps hard links joined", () => {
    const home = makeHome();
    const target = path.join(path.dirname(home), "dotfiles", "CLAUDE.md");
    write(target, OWNER);
    fs.chmodSync(target, 0o600);
    fs.mkdirSync(path.dirname(claude(home)), { recursive: true });
    fs.symlinkSync(target, claude(home));
    const linked = path.join(path.dirname(home), "AGENTS-copy.md");
    write(codex(home), OWNER);
    fs.linkSync(codex(home), linked);
    runNote(home, BODY);
    expect(fs.lstatSync(claude(home)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(`${OWNER}\n${workspaceNoteBlock(BODY)}`);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(linked, "utf8")).toBe(`${OWNER}\n${workspaceNoteBlock(BODY)}`);
  });

  it("a dangling symlink is left alone", () => {
    const home = makeHome();
    fs.mkdirSync(path.dirname(claude(home)), { recursive: true });
    fs.symlinkSync(path.join(home, "nowhere", "CLAUDE.md"), claude(home));
    expect(runNote(home, BODY).get(claude(home))?.outcome).toBe("dangling");
    expect(fs.existsSync(path.join(home, "nowhere"))).toBe(false);
  });

  it("names both harness files", () => {
    expect(WORKSPACE_NOTE_FILES).toEqual([".claude/CLAUDE.md", ".codex/AGENTS.md"]);
  });
});
