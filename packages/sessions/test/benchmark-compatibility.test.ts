import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { piProfileDigest } from "@mend/db";
import { validatePiProfile, type PiProfileFile } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { FastCheck } from "effect/testing";
import { expect } from "vitest";

import { PERSON_SAVED_STATE } from "../src/harness-layout.ts";
import { PI_PROFILE_HOME_DIR, materializePiProfile, planPiProfile } from "../src/pi-profile.ts";
import { it } from "./effect-vitest.ts";

const benchUrl = new URL("../../../scripts/bench/lib.mjs", import.meta.url).href;
const runBench = (program: string, args: ReadonlyArray<string>, home: string): string =>
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const bench = await import(process.argv[1]);\n${program}`,
      benchUrl,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home },
    },
  );
const ProfileProbe = Schema.Struct({ digest: Schema.String, shell: Schema.String });
const profileProbe = (
  directory: string,
  files: ReadonlyArray<{ readonly path: string; readonly bytes: ReadonlyArray<number> }>,
  home: string,
) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(ProfileProbe))(
    runBench(
      `
import { execFileSync } from "node:child_process";
const files = JSON.parse(process.argv[2]).map(file => ({ path: file.path, bytes: Buffer.from(file.bytes) }));
const shell = execFileSync("sh", ["-c", bench.PROFILE_DIGEST_SH + '\\nprintf "%s %s\\\\n" "$(profile_files "$1")" "$(profile_digest "$1")"', "bench", process.argv[3]], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ digest: bench.profileDigestOf(files), shell }));
`,
      [JSON.stringify(files), directory],
      home,
    ),
  );
const withHome = <A, E, R>(use: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "mend-benchmark-compatibility-"))),
    use,
    (home) => Effect.sync(() => fs.rmSync(home, { recursive: true, force: true })),
  );

const profiles: ReadonlyArray<{
  readonly name: string;
  readonly files: ReadonlyArray<Pick<PiProfileFile, "path" | "encoding" | "contents">>;
}> = [
  {
    name: "UTF8 and binary encoding",
    files: [
      { path: "settings.json", encoding: "utf8", contents: '{"packages":[]}\n' },
      { path: "extensions/a b.ts", encoding: "utf8", contents: "export {}; // café 😀\n" },
      { path: "extensions/banner.png", encoding: "base64", contents: "AP9BgA==" },
      { path: "extensions/.hidden.ts", encoding: "utf8", contents: "hidden\n" },
    ],
  },
  {
    name: "canonical Unicode ordering",
    files: [
      { path: "extensions/\uE000.ts", encoding: "utf8", contents: "one\n" },
      { path: "extensions/😀.ts", encoding: "utf8", contents: "two\n" },
    ],
  },
  {
    name: "raw newline and quote filenames",
    files: [
      { path: "extensions/line\nbreak.ts", encoding: "utf8", contents: "line-safe\n" },
      { path: "extensions/it's quoted.ts", encoding: "utf8", contents: "quote-safe\n" },
    ],
  },
];
for (const profile of profiles) {
  it.live(`benchmark digest matches actual stored and delivered profile: ${profile.name}`, () =>
    withHome((home) =>
      Effect.gen(function* () {
        expect(validatePiProfile(profile.files)).toBeNull();
        const digest = piProfileDigest(profile.files);
        yield* materializePiProfile(home, planPiProfile({ digest, files: profile.files }));
        const directory = path.join(home, PI_PROFILE_HOME_DIR);
        const raw = profile.files.map((file) => ({
          path: file.path,
          bytes: [...fs.readFileSync(path.join(directory, file.path))],
        }));
        if (profile.name === "UTF8 and binary encoding") {
          expect(fs.readFileSync(path.join(directory, "extensions/banner.png"))).toEqual(
            Buffer.from([0, 255, 65, 128]),
          );
          expect(fs.readFileSync(path.join(directory, "extensions/a b.ts"), "utf8")).toBe(
            "export {}; // café 😀\n",
          );
        }
        const installed = path.join(directory, "extensions/node_modules/dep/index.js");
        fs.mkdirSync(path.dirname(installed), { recursive: true });
        fs.writeFileSync(installed, "not part of a saved profile");
        fs.mkdirSync(path.join(directory, "node_modules"));
        fs.writeFileSync(path.join(directory, "node_modules/generated.js"), "ignored too");
        const found = profileProbe(directory, raw, home);
        expect(found.digest).toBe(digest);
        expect(found.shell).toBe(`${profile.files.length} ${digest}`);
      }),
    ),
  );
}

it("generated raw-byte/filename profiles keep benchmark and database digests compatible", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-benchmark-generated-"));
  try {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(
          FastCheck.record({
            name: FastCheck.constantFrom(
              "ascii",
              "space name",
              "it's quoted",
              "\uE000",
              "😀",
              "line\nbreak",
            ),
            bytes: FastCheck.uint8Array({ maxLength: 24 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (entries) => {
          const directory = fs.mkdtempSync(path.join(home, "profile-"));
          try {
            const raw = entries.map((entry, index) => ({
              path: `extensions/${entry.name}-${index}.bin`,
              bytes: [...entry.bytes],
            }));
            const files = raw.map(
              (file) =>
                ({
                  path: file.path,
                  encoding: "base64",
                  contents: Buffer.from(file.bytes).toString("base64"),
                }) satisfies Pick<PiProfileFile, "path" | "encoding" | "contents">,
            );
            expect(validatePiProfile(files)).toBeNull();
            for (const file of raw) {
              fs.mkdirSync(path.dirname(path.join(directory, file.path)), { recursive: true });
              fs.writeFileSync(path.join(directory, file.path), Buffer.from(file.bytes));
            }
            const result = profileProbe(directory, raw.toReversed(), home);
            const expected = piProfileDigest(files);
            expect(result.digest).toBe(expected);
            expect(result.shell).toBe(`${files.length} ${expected}`);
          } finally {
            fs.rmSync(directory, { recursive: true, force: true });
          }
        },
      ),
      { seed: 20261013, numRuns: 40 },
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

const SavedProbe = Schema.Struct({
  paths: Schema.Array(Schema.String),
  totals: Schema.Struct({
    total: Schema.Number,
    state: Schema.Number,
    beyond: Schema.Number,
    files: Schema.Number,
    machine: Schema.Number,
    largestBeyond: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Number })),
  }),
});
it("benchmark saved-state paths and classifications use actual session save entries and kinds", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-benchmark-state-"));
  try {
    const state = PERSON_SAVED_STATE.map(
      (entry) => `size 11 ./${entry.path}${entry.kind === "directory" ? "/sample file.json" : ""}`,
    );
    const neighbors = PERSON_SAVED_STATE.map(
      (entry) =>
        `size 3 ./${entry.path}-not-state${entry.kind === "directory" ? "/other.json" : ""}`,
    );
    const text = [
      ...state,
      ...neighbors,
      "size 17 ./codex-db/state_5.sqlite",
      "size 19 ./codex-db/state_5.sqlite-wal",
      "size 23 ./codex-db/state_5.sqlite-shm",
      "size 29 ./codex-db/logs_1.sqlite",
      "size 31 ./conversations/session/transcript.jsonl",
      "size 7 ./.mend-saved/managed-skills.json",
    ].join("\n");
    const found = Schema.decodeUnknownSync(Schema.fromJsonString(SavedProbe))(
      runBench(
        `
console.log(JSON.stringify({ paths: bench.PERSON_STATE_PATHS, totals: bench.classifySavedFiles(process.argv[2]) }));
`,
        [text],
        home,
      ),
    );
    expect(found.paths).toEqual(PERSON_SAVED_STATE.map((entry) => entry.path));
    const expectedState = PERSON_SAVED_STATE.length * 11 + 17 + 19 + 31;
    const expectedBeyond = PERSON_SAVED_STATE.length * 3 + 7;
    expect(found.totals).toEqual({
      total: expectedState + expectedBeyond,
      state: expectedState,
      beyond: expectedBeyond,
      files: PERSON_SAVED_STATE.length * 2 + 4,
      machine: 23 + 29,
      largestBeyond: [
        { path: ".mend-saved/managed-skills.json", bytes: 7 },
        ...PERSON_SAVED_STATE.slice(0, 4).map((entry) => ({
          path: `${entry.path}-not-state${entry.kind === "directory" ? "/other.json" : ""}`,
          bytes: 3,
        })),
      ],
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
