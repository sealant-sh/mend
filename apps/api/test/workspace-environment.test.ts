import { defaultSettings, defaultWorkspaceImage, MendSettings } from "@mend/domain";
import type { WorkspaceImage } from "@mend/domain";
import type { WorkspacePackageResolution } from "@mend/sealant";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  resolveWorkspaceEnvironment,
  saveResolvedWorkspaceEnvironmentWith,
} from "../src/services/workspace-environment.ts";

const workspaceImage = (packages: ReadonlyArray<string>): WorkspaceImage => ({
  mode: "family",
  os: "arch",
  packages,
  shell: "bash",
  services: { docker: true },
});

const resolution = (
  requested: string,
  overrides: Partial<WorkspacePackageResolution> = {},
): WorkspacePackageResolution => ({
  requested,
  normalized: requested,
  status: "resolved",
  canonicalId: requested,
  supported: true,
  packageName: requested,
  alternatives: [],
  ...overrides,
});

describe("resolveWorkspaceEnvironment", () => {
  it("resolves every package for the selected OS and saves canonical IDs once", async () => {
    const observed: Array<{ readonly packageName: string; readonly os: string }> = [];
    const result = await Effect.runPromise(
      resolveWorkspaceEnvironment(workspaceImage(["gh", "github-cli"]), (packageName, os) => {
        observed.push({ packageName, os });
        return Effect.succeed(
          resolution(packageName, { canonicalId: "github-cli", packageName: "github-cli" }),
        );
      }),
    );

    expect(observed).toEqual([
      { packageName: "gh", os: "arch" },
      { packageName: "github-cli", os: "arch" },
    ]);
    expect(result.workspaceImage).toEqual({
      mode: "family",
      os: "arch",
      packages: ["github-cli"],
      shell: "bash",
      services: { docker: true },
    });
  });

  it.each([
    resolution("missing", { status: "not-found", canonicalId: null, supported: false }),
    resolution("linux-only", { supported: false }),
  ])("refuses the entire environment when $requested is unresolved", async (rejected) => {
    const result = await Effect.runPromise(
      resolveWorkspaceEnvironment(workspaceImage(["pnpm", rejected.requested]), (packageName) =>
        Effect.succeed(packageName === rejected.requested ? rejected : resolution(packageName)),
      ),
    );

    expect(result.workspaceImage).toBeNull();
    expect(result.resolutions).toHaveLength(2);
  });

  it("refuses a name outside the catalog that the platform matched to another project", async () => {
    // Repology's nearest project for `tree`, with no catalog id: it saved, then every launch
    // failed `Unknown workspace package 'python-urwidtrees'` (RC 0.36.0-next.754, B-F2).
    const result = await Effect.runPromise(
      resolveWorkspaceEnvironment(workspaceImage(["bat", "tree"]), (packageName) =>
        Effect.succeed(
          packageName === "tree"
            ? resolution("tree", { canonicalId: null, packageName: "python-urwidtrees" })
            : resolution(packageName),
        ),
      ),
    );

    expect(result.workspaceImage).toBeNull();
    expect(result.resolutions[1]).toMatchObject({
      requested: "tree",
      status: "unsupported",
      supported: false,
    });
  });

  it("saves the code defaults on Arch once each id answers from Core's catalog (sealant#364)", async () => {
    // Core's own test pins this list (package-standardization.test.ts, `MEND_DEFAULTS`) and
    // resolves each id on Arch from its catalog. Change one, change the other.
    expect(defaultWorkspaceImage.packages).toEqual([
      "pnpm",
      "bun",
      "python",
      "uv",
      "mise",
      "github-cli",
      "lazygit",
      "bat",
      "curl",
      "unzip",
      "jq",
      "ripgrep",
      "fd",
      "fzf",
      "starship",
      "zsh-autosuggestions",
      "zsh-syntax-highlighting",
      "zsh-history-substring-search",
      "direnv",
    ]);

    // From 0.39.0-next.726 every default answers with its catalog id and is supported.
    const fromCatalog = await Effect.runPromise(
      resolveWorkspaceEnvironment(defaultWorkspaceImage, (packageName) =>
        Effect.succeed(resolution(packageName)),
      ),
    );
    expect(fromCatalog.workspaceImage).toEqual(defaultWorkspaceImage);

    // Before it, `bun` (and `unzip`, `starship`, the zsh plugins, `direnv`) fell through to
    // Repology with no catalog id, so the Setup page could not save its own defaults (RC 3, A3).
    const beforeCatalog = await Effect.runPromise(
      resolveWorkspaceEnvironment(defaultWorkspaceImage, (packageName) =>
        Effect.succeed(
          packageName === "bun"
            ? resolution(packageName, { canonicalId: null })
            : resolution(packageName),
        ),
      ),
    );
    expect(beforeCatalog.workspaceImage).toBeNull();
  });

  it("merges a resolved environment into settings read after validation", async () => {
    let current = new MendSettings({ ...defaultSettings, autoTour: false });
    const requested = workspaceImage(["pnpm"]);

    const result = await Effect.runPromise(
      saveResolvedWorkspaceEnvironmentWith(
        requested,
        (latest, resolved) => new MendSettings({ ...latest, workspaceImage: resolved }),
        {
          getSettings: () => Effect.succeed(current),
          modifySettings: (update) =>
            Effect.sync(() => {
              current = new MendSettings({ ...current, autoTour: true });
              current = update(current);
              return current;
            }),
          resolvePackage: (packageName) => Effect.succeed(resolution(packageName)),
        },
      ),
    );

    expect(result.saved).toBe(true);
    expect(result.settings.autoTour).toBe(true);
    expect(result.settings.workspaceImage).toEqual(requested);
  });
});
