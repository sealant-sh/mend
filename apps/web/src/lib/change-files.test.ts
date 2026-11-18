import { describe, expect, it } from "vitest";

import type { ReviewDiffFileDto } from "./api.ts";
import {
  addedWords,
  changeFileOf,
  fileGroups,
  fileNote,
  filterGroups,
  isGenerated,
  orderedFiles,
  patchFingerprint,
  removedWords,
} from "./change-files.ts";

const file = (path: string, extra: Partial<ReviewDiffFileDto> = {}): ReviewDiffFileDto => ({
  oldPath: path,
  newPath: path,
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
  patch: `diff --git a/${path} b/${path}\n+one\n`,
  hunks: [],
  ...extra,
});

const pathsOf = (groups: ReturnType<typeof fileGroups>) =>
  groups.map((group) => [group.folder, group.files.map((each) => each.path)]);

describe("which files a tool wrote", () => {
  it("knows lock files by name, in any folder", () => {
    expect(isGenerated("pnpm-lock.yaml")).toBe(true);
    expect(isGenerated("apps/site/package-lock.json")).toBe(true);
    expect(isGenerated("Cargo.lock")).toBe(true);
    expect(isGenerated("go.sum")).toBe(true);
  });

  it("knows a generator's names", () => {
    expect(isGenerated("src/routeTree.gen.ts")).toBe(true);
    expect(isGenerated("api/schema.generated.ts")).toBe(true);
    expect(isGenerated("public/app.min.js")).toBe(true);
  });

  it("leaves files a person writes alone", () => {
    expect(isGenerated("package.json")).toBe(false);
    expect(isGenerated("src/lockfile.ts")).toBe(false);
    expect(isGenerated("docs/generated-files.md")).toBe(false);
  });
});

describe("a changed file", () => {
  it("is keyed by its new path, with its folder and name apart", () => {
    const changed = changeFileOf(file("src/payments/retry.ts"));
    expect(changed).toMatchObject({ path: "src/payments/retry.ts", dir: "src/payments/" });
    expect(changed.name).toBe("retry.ts");
    expect(changed.from).toBeNull();
  });

  it("keeps where a renamed file was", () => {
    const renamed = changeFileOf(
      file("src/app/root.tsx", { oldPath: "src/routes/root.tsx", status: "renamed" }),
    );
    expect(renamed.from).toBe("src/routes/root.tsx");
    expect(fileNote(renamed)).toBe("Renamed");
  });

  it("is keyed by its old path once deleted", () => {
    const deleted = changeFileOf(file("old.ts", { newPath: null, status: "deleted" }));
    expect(deleted.path).toBe("old.ts");
    expect(fileNote(deleted)).toBe("Deleted");
  });

  it("says Generated before anything else, then Binary", () => {
    expect(fileNote(changeFileOf(file("pnpm-lock.yaml", { status: "added" })))).toBe("Generated");
    expect(fileNote(changeFileOf(file("og.png", { binary: true })))).toBe("Binary");
    expect(fileNote(changeFileOf(file("a.ts")))).toBeNull();
  });
});

describe("the file list's groups", () => {
  it("lists files alone in their folder first by their path, then each folder of two or more", () => {
    const groups = fileGroups(
      [
        "src/routes/cart.tsx",
        "package.json",
        "src/app/root.tsx",
        "public/og/checkout.png",
        "src/routes/account.tsx",
        "pnpm-lock.yaml",
        "src/app/entry.client.tsx",
      ].map((path) => changeFileOf(file(path))),
    );
    expect(pathsOf(groups)).toEqual([
      [null, ["package.json", "pnpm-lock.yaml", "public/og/checkout.png"]],
      ["src/app", ["src/app/entry.client.tsx", "src/app/root.tsx"]],
      ["src/routes", ["src/routes/account.tsx", "src/routes/cart.tsx"]],
    ]);
    expect(orderedFiles(groups).map((each) => each.path)).toEqual([
      "package.json",
      "pnpm-lock.yaml",
      "public/og/checkout.png",
      "src/app/entry.client.tsx",
      "src/app/root.tsx",
      "src/routes/account.tsx",
      "src/routes/cart.tsx",
    ]);
  });

  it("has no loose group when every file shares a folder", () => {
    const groups = fileGroups(
      ["src/payments/retry.ts", "src/payments/charge.ts"].map((path) => changeFileOf(file(path))),
    );
    expect(pathsOf(groups)).toEqual([
      ["src/payments", ["src/payments/charge.ts", "src/payments/retry.ts"]],
    ]);
  });

  it("filters by any part of the path, in any case, dropping groups left empty", () => {
    const groups = fileGroups(
      ["README.md", "src/app/Root.tsx", "src/app/entry.tsx"].map((path) =>
        changeFileOf(file(path)),
      ),
    );
    expect(pathsOf(filterGroups(groups, "root"))).toEqual([["src/app", ["src/app/Root.tsx"]]]);
    expect(filterGroups(groups, "  ")).toBe(groups);
    expect(filterGroups(groups, "nothing")).toEqual([]);
  });
});

describe("a file's fingerprint", () => {
  it("is the same for the same patch and differs when the patch does", () => {
    expect(patchFingerprint("+one\n")).toBe(patchFingerprint("+one\n"));
    expect(patchFingerprint("+one\n")).not.toBe(patchFingerprint("+two\n"));
  });
});

describe("counts", () => {
  it("groups thousands and hides a zero", () => {
    expect(addedWords(1284)).toBe("+1,284");
    expect(removedWords(1102)).toBe("−1,102");
    expect(addedWords(0)).toBe("");
    expect(removedWords(0)).toBe("");
  });
});
