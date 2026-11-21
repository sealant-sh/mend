import { SkillsRepo, type SkillBundleInput, type SkillOwner } from "@mend/db";
import { ProjectId, Sha } from "@mend/domain";
import { SKILL_MAX_FILE_BYTES, SKILL_MAX_FILES } from "@mend/domain/workbench";
import { Store, type FileRead, type SubtreeBlobEntry } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  importAdoptedProjectSkills,
  readSkillFrontmatterDescription,
  selectAdoptedSkillFiles,
} from "./adoption-skills.ts";

describe("readSkillFrontmatterDescription", () => {
  it("extracts plain and quoted single-line descriptions and ignores block scalars", () => {
    expect(
      readSkillFrontmatterDescription("---\nname: linear\ndescription: How Sealant works.\n---\n"),
    ).toBe("How Sealant works.");
    expect(readSkillFrontmatterDescription('---\nname: a\ndescription: "Quoted text"\n---\n')).toBe(
      "Quoted text",
    );
    expect(
      readSkillFrontmatterDescription("---\nname: a\ndescription: 'Single quoted'\n---\n"),
    ).toBe("Single quoted");
    expect(readSkillFrontmatterDescription("---\nname: a\ndescription: >\n  folded\n---\n")).toBe(
      "",
    );
    expect(readSkillFrontmatterDescription("# No frontmatter\n")).toBe("");
  });
});

describe("selectAdoptedSkillFiles", () => {
  it("keeps valid .agents/skills bundles and skips hidden, ignored, oversized, and incomplete directories", () => {
    const entries: ReadonlyArray<SubtreeBlobEntry> = [
      { path: ".agents/skills/top-level.md", size: 10 },
      { path: ".agents/skills/.hidden/SKILL.md", size: 10 },
      { path: ".agents/skills/no-entry/notes.md", size: 10 },
      { path: ".agents/skills/bad name/SKILL.md", size: 10 },
      { path: ".agents/skills/Linear/SKILL.md", size: 20 },
      { path: ".agents/skills/linear/SKILL.md", size: 20 },
      { path: ".agents/skills/linear/references/rules.md", size: 30 },
      { path: ".agents/skills/linear/node_modules/pkg/index.js", size: 10 },
      { path: ".agents/skills/linear/huge.txt", size: SKILL_MAX_FILE_BYTES + 1 },
      ...Array.from({ length: SKILL_MAX_FILES + 1 }, (_, index) => ({
        path: `.agents/skills/too-many/${index === 0 ? "SKILL.md" : `f-${index}.md`}`,
        size: 5,
      })),
    ];

    expect(selectAdoptedSkillFiles(entries)).toEqual([
      {
        name: "linear",
        files: [
          {
            repoPath: ".agents/skills/linear/SKILL.md",
            skillPath: "SKILL.md",
            size: 20,
          },
          {
            repoPath: ".agents/skills/linear/references/rules.md",
            skillPath: "references/rules.md",
            size: 30,
          },
        ],
      },
    ]);
  });
});

describe("importAdoptedProjectSkills", () => {
  it("syncs valid text skills to the project library only and drops binary files", async () => {
    const projectId = ProjectId.make("project-1");
    const headSha = Sha.make("0123456789abcdef0123456789abcdef01234567");
    const encoder = new TextEncoder();
    const blobs = new Map<string, FileRead>([
      [
        ".agents/skills/linear/SKILL.md",
        {
          bytes: encoder.encode(
            "---\nname: linear\ndescription: Linear workflow\n---\nUse Linear.",
          ),
          size: 58,
          truncated: false,
          binary: false,
        },
      ],
      [
        ".agents/skills/linear/logo.png",
        {
          bytes: new Uint8Array([0, 1, 2, 3]),
          size: 4,
          truncated: false,
          binary: true,
        },
      ],
      [
        ".agents/skills/broken/SKILL.md",
        {
          bytes: new Uint8Array([0, 255]),
          size: 2,
          truncated: false,
          binary: true,
        },
      ],
    ]);

    const synced: Array<{
      readonly owner: SkillOwner;
      readonly bundles: ReadonlyArray<SkillBundleInput>;
      readonly prune: boolean;
    }> = [];

    const layer = Layer.mergeAll(
      Layer.mock(Store, {
        listSubtreeBlobs: () =>
          Effect.succeed(
            [...blobs.entries()].map(([filePath, blob]) => ({ path: filePath, size: blob.size })),
          ),
        readBlob: (_dir, _rev, relative) => Effect.succeed(blobs.get(relative) ?? null),
      }),
      Layer.mock(SkillsRepo, {
        sync: (owner, bundles, options) =>
          Effect.sync(() => {
            synced.push({ owner, bundles, prune: options.prune });
            return {
              created: bundles.map((bundle) => bundle.name),
              updated: [],
              unchanged: [],
              removed: [],
            };
          }),
      }),
    );

    const count = await Effect.runPromise(
      importAdoptedProjectSkills({ projectId, storePath: "/store/p/repo.git", headSha }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(count).toBe(1);
    expect(synced).toEqual([
      {
        owner: { scope: "project", projectId },
        prune: false,
        bundles: [
          {
            name: "linear",
            description: "Linear workflow",
            files: [
              {
                path: "SKILL.md",
                contents: "---\nname: linear\ndescription: Linear workflow\n---\nUse Linear.",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("does not call SkillsRepo.sync when the repository has no .agents/skills entries", async () => {
    let calls = 0;
    const layer = Layer.mergeAll(
      Layer.mock(Store, { listSubtreeBlobs: () => Effect.succeed([]) }),
      Layer.mock(SkillsRepo, {
        sync: () =>
          Effect.sync(() => {
            calls += 1;
            return { created: [], updated: [], unchanged: [], removed: [] };
          }),
      }),
    );

    const count = await Effect.runPromise(
      importAdoptedProjectSkills({
        projectId: ProjectId.make("project-empty"),
        storePath: "/store/empty/repo.git",
        headSha: Sha.make("0123456789abcdef0123456789abcdef01234567"),
      }).pipe(Effect.provide(layer)),
    );

    expect(count).toBe(0);
    expect(calls).toBe(0);
  });
});
