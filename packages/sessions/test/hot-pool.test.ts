import { defaultWorkspaceImage } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { hotFingerprint, type HotFingerprintInputs } from "../src/hot-pool.ts";

const base: HotFingerprintInputs = {
  workspaceImage: defaultWorkspaceImage,
  applyDotfiles: true,
  inheritUserSkills: true,
  skills: [
    { id: "skill-user", name: "typescript", revision: 2 },
    { id: "skill-project", name: "review", revision: 1 },
  ],
  dotfiles: {
    repository: {
      url: "git@github.com:acme/dots.git",
      ref: null,
      subdirectory: "dots",
      manager: "stow",
      bootstrap: true,
    },
    snapshotSha: "abc123",
  },
  environmentRevision: 3,
  secretRevision: 1,
  clusterBindingRevision: 2,
  references: [
    { name: "effect", path: "/store/_references/effect" },
    { name: "drizzle", path: "/store/_references/drizzle" },
  ],
  mounts: [{ name: "notes", hostPath: "/home/u/notes", readOnly: true }],
  links: [{ name: "api", rootPath: "/store/api/worktrees" }],
};

describe("hotFingerprint", () => {
  it("is stable across skill, reference, and mount ordering", () => {
    const reordered: HotFingerprintInputs = {
      ...base,
      skills: base.skills.toReversed(),
      references: base.references.toReversed(),
      mounts: base.mounts.toReversed(),
    };
    expect(hotFingerprint(reordered)).toBe(hotFingerprint(base));
  });

  it("changes when any create-time input changes", () => {
    const variants: ReadonlyArray<HotFingerprintInputs> = [
      { ...base, environmentRevision: base.environmentRevision + 1 },
      { ...base, secretRevision: base.secretRevision + 1 },
      { ...base, clusterBindingRevision: base.clusterBindingRevision + 1 },
      { ...base, applyDotfiles: false },
      { ...base, inheritUserSkills: false },
      {
        ...base,
        skills: base.skills.map((skill) =>
          skill.id === "skill-project" ? { ...skill, revision: skill.revision + 1 } : skill,
        ),
      },
      { ...base, skills: base.skills.slice(1) },
      { ...base, dotfiles: { ...base.dotfiles, snapshotSha: "def456" } },
      // Every saved field of the repository decides what a workspace applies.
      ...(
        [
          { url: "git@github.com:acme/other-dots.git" },
          { ref: "laptop" },
          { subdirectory: null },
          { manager: "chezmoi" },
          { bootstrap: false },
        ] as const
      ).map(
        (change): HotFingerprintInputs => ({
          ...base,
          dotfiles: {
            ...base.dotfiles,
            repository:
              base.dotfiles.repository === null ? null : { ...base.dotfiles.repository, ...change },
          },
        }),
      ),
      {
        ...base,
        dotfiles: { repository: null, snapshotSha: base.dotfiles.snapshotSha },
      },
      {
        ...base,
        workspaceImage: {
          mode: "family",
          os: "nix",
          packages: [],
          shell: "bash",
          services: { docker: true },
        },
      },
      { ...base, references: base.references.slice(1) },
      {
        ...base,
        mounts: [{ name: "notes", hostPath: "/home/u/notes", readOnly: false }],
      },
    ];
    const seen = new Set([hotFingerprint(base)]);
    for (const variant of variants) {
      const fingerprint = hotFingerprint(variant);
      expect(seen.has(fingerprint)).toBe(false);
      seen.add(fingerprint);
    }
  });

  it("changes when a linked project's root changes, not when its bound worktree does", () => {
    const relinked = hotFingerprint({
      ...base,
      links: [{ name: "api", rootPath: "/store/api-fork/worktrees" }],
    });
    expect(relinked).not.toBe(hotFingerprint(base));
    // The worktree bound at launch is not a create-time input, so it is not in the inputs at all.
    expect(hotFingerprint({ ...base, links: [...base.links].toReversed() })).toBe(
      hotFingerprint(base),
    );
  });
});
