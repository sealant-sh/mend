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

const SHARED: { readonly layout: "shared" } = { layout: "shared" };

describe("hotFingerprint", () => {
  it("is stable across skill, reference, and mount ordering", () => {
    const reordered: HotFingerprintInputs = {
      ...base,
      skills: base.skills.toReversed(),
      references: base.references.toReversed(),
      mounts: base.mounts.toReversed(),
    };
    expect(hotFingerprint(reordered, SHARED)).toBe(hotFingerprint(base, SHARED));
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
    const seen = new Set([hotFingerprint(base, SHARED)]);
    for (const variant of variants) {
      const fingerprint = hotFingerprint(variant, SHARED);
      expect(seen.has(fingerprint)).toBe(false);
      seen.add(fingerprint);
    }
  });

  it("is unchanged for a shared standby, and names a person standby's layout and the image answer it booted on (docs/adr/0016)", () => {
    const person = hotFingerprint(base, {
      layout: "person",
      imageKey: "digest:sha256:a\u0000docker",
    });
    expect(person).not.toBe(hotFingerprint(base, SHARED));
    expect(
      hotFingerprint(base, { layout: "person", imageKey: "digest:sha256:b\u0000docker" }),
    ).not.toBe(person);
    // A shared standby warmed before per-person standbys is still claimed: its hash is the same.
    expect(hotFingerprint(base, SHARED)).toBe(
      "858de71759eb5f7d1af3c4d71ba15adb35a2a17c56c0fabb8fc6792c4f5a450f",
    );
  });

  it("leaves a person standby's dotfiles out: they are resolved at claim, so a change to them does not drain it (review of mend#596, N7)", () => {
    const person: { readonly layout: "person"; readonly imageKey: string } = {
      layout: "person",
      imageKey: "digest:sha256:a\u0000docker",
    };
    const changed: HotFingerprintInputs = {
      ...base,
      applyDotfiles: !base.applyDotfiles,
      dotfiles: { ...base.dotfiles, snapshotSha: "f".repeat(40) },
    };
    expect(hotFingerprint(changed, person)).toBe(hotFingerprint(base, person));
    expect(hotFingerprint(changed, SHARED)).not.toBe(hotFingerprint(base, SHARED));
  });

  it("changes when a linked project's root changes, not when its bound worktree does", () => {
    const relinked = hotFingerprint(
      {
        ...base,
        links: [{ name: "api", rootPath: "/store/api-fork/worktrees" }],
      },
      SHARED,
    );
    expect(relinked).not.toBe(hotFingerprint(base, SHARED));
    // The worktree bound at launch is not a create-time input, so it is not in the inputs at all.
    expect(hotFingerprint({ ...base, links: [...base.links].toReversed() }, SHARED)).toBe(
      hotFingerprint(base, SHARED),
    );
  });
});
