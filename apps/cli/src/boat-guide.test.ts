import { readFileSync } from "node:fs";

import { boatKeyCreateCommand } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { COMMANDS, type CommandDoc, findCommand } from "./help.ts";

/**
 * The Boat operating guide names `mend` commands and flags people type. Each must be one the help
 * catalog documents, so a renamed or removed flag fails here instead of in a reader's terminal.
 */
const GUIDE = new URL("../../docs/src/content/docs/operate/boat.md", import.meta.url);
const guide = readFileSync(GUIDE, "utf8");

const FLAG = /--[a-z][a-z0-9-]*/g;

const flagsOf = (doc: CommandDoc): ReadonlySet<string> =>
  new Set([
    ...(doc.options ?? []).flatMap((option) => option.flag.match(FLAG) ?? []),
    ...doc.synopsis.flatMap((shape) => shape.match(FLAG) ?? []),
  ]);

const EVERY_FLAG: ReadonlySet<string> = new Set(COMMANDS.flatMap((doc) => [...flagsOf(doc)]));

/** Every piece of code the guide shows: inline spans, and fenced lines with continuations joined. */
const codeOf = (markdown: string): ReadonlyArray<string> => {
  const fences = [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((match) =>
    (match[1] ?? "").replace(/\\\n\s*/g, " ").split("\n"),
  );
  const prose = markdown.replace(/```[a-z]*\n[\s\S]*?```/g, "");
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
  return [...fences, ...spans].map((code) => code.trim()).filter((code) => code !== "");
};

const code = codeOf(guide);

/** `mend <words> <flags>` in a piece of code, where it names a command. */
const mendCommands = code.flatMap((piece) =>
  [...piece.matchAll(/(?:^|\|\s*|;\s*)mend ([^|;]+)/g)].map((match) => (match[1] ?? "").trim()),
);

describe("the Boat guide's commands (SLNT-800)", () => {
  it("finds the commands it checks", () => {
    expect(mendCommands).toContain("server setup --yes --no-boat-api-key");
    expect(mendCommands).toContain("boat check --full");
  });

  for (const command of new Set(mendCommands)) {
    it(`documents mend ${command}`, () => {
      const tokens = command.split(/\s+/);
      const words = tokens.filter((token) => /^[a-z][a-z-]*$/.test(token));
      const doc = findCommand(words);
      expect(doc, `mend ${command} is not in the help catalog`).not.toBeNull();
      if (doc === null) return;
      const known = flagsOf(doc);
      for (const flag of command.match(FLAG) ?? [])
        expect(known.has(flag), `mend ${doc.name} documents no ${flag}`).toBe(true);
    });
  }

  it("names only flags some command documents", () => {
    const flags = code
      .filter((piece) => piece.startsWith("--"))
      .flatMap((piece) => piece.match(FLAG) ?? []);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.filter((flag) => !EVERY_FLAG.has(flag))).toEqual([]);
  });

  it("shows the Boat page's commands for creating a key, from the one constant", () => {
    expect(code).toContain(boatKeyCreateCommand("<your-boat-organization>"));
    expect(code).toContain(boatKeyCreateCommand(null));
  });

  it("never tells a reader to put a key in a command, a file or a variable", () => {
    for (const piece of code) {
      expect(piece).not.toMatch(/SEALANT_BOAT_API_KEY=|printf|echo |boat-key\.txt|<\s*~?\/?\S*key/);
    }
  });
});
