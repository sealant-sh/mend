import { SettingsFailure } from "@mend/api-contracts";
import { SettingsRepo } from "@mend/db";
import {
  defaultSettings,
  defaultWorkspaceImage,
  MendSettings,
  screenPackageIds,
} from "@mend/domain";
import type { FamilyWorkspaceImage, WorkspaceImage } from "@mend/domain";
import {
  SealantClient,
  SealantPlatformError,
  type WorkspacePackageResolution,
} from "@mend/sealant";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  resolveWorkspaceEnvironment,
  saveResolvedWorkspaceEnvironment,
  saveResolvedWorkspaceEnvironmentWith,
} from "../src/services/workspace-environment.ts";

const workspaceImage = (packages: ReadonlyArray<string>): FamilyWorkspaceImage => ({
  mode: "family",
  os: "arch",
  packages,
  shell: "bash",
  services: { docker: true },
  screen: false,
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
      resolveWorkspaceEnvironment(
        workspaceImage(["gh", "github-cli"]),
        "x86_64",
        (packageName, os) => {
          observed.push({ packageName, os });
          return Effect.succeed(
            resolution(packageName, { canonicalId: "github-cli", packageName: "github-cli" }),
          );
        },
      ),
    );

    expect(observed).toEqual([
      { packageName: "gh", os: "arch" },
      { packageName: "github-cli", os: "arch" },
      { packageName: "doppler", os: "arch" },
      { packageName: "postgresql-client", os: "arch" },
      { packageName: "redis-cli", os: "arch" },
    ]);
    expect(result.workspaceImage).toEqual({
      mode: "family",
      os: "arch",
      packages: ["github-cli"],
      shell: "bash",
      services: { docker: true },
      screen: false,
    });
  });

  it.each([
    resolution("missing", { status: "not-found", canonicalId: null, supported: false }),
    resolution("linux-only", { supported: false }),
  ])("refuses the entire environment when $requested is unresolved", async (rejected) => {
    const result = await Effect.runPromise(
      resolveWorkspaceEnvironment(
        workspaceImage(["pnpm", rejected.requested]),
        "x86_64",
        (packageName) =>
          Effect.succeed(packageName === rejected.requested ? rejected : resolution(packageName)),
      ),
    );

    expect(result.workspaceImage).toBeNull();
    expect(result.resolutions).toHaveLength(5);
  });

  it("refuses a name outside the catalog that the platform matched to another project", async () => {
    // Repology's nearest project for `tree`, with no catalog id: it saved, then every launch
    // failed `Unknown workspace package 'python-urwidtrees'` (RC 0.36.0-next.754, B-F2).
    const result = await Effect.runPromise(
      resolveWorkspaceEnvironment(workspaceImage(["bat", "tree"]), "x86_64", (packageName) =>
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
      resolveWorkspaceEnvironment(defaultWorkspaceImage, "x86_64", (packageName) =>
        Effect.succeed(resolution(packageName)),
      ),
    );
    expect(fromCatalog.workspaceImage).toEqual(defaultWorkspaceImage);

    // Before it, `bun` (and `unzip`, `starship`, the zsh plugins, `direnv`) fell through to
    // Repology with no catalog id, so the Setup page could not save its own defaults (RC 3, A3).
    const beforeCatalog = await Effect.runPromise(
      resolveWorkspaceEnvironment(defaultWorkspaceImage, "x86_64", (packageName) =>
        Effect.succeed(
          packageName === "bun"
            ? resolution(packageName, { canonicalId: null })
            : resolution(packageName),
        ),
      ),
    );
    expect(beforeCatalog.workspaceImage).toBeNull();
  });

  it("resolves a screen's packages with the image's own and saves only the image's own", async () => {
    const asked: Array<string> = [];
    const result = await Effect.runPromise(
      resolveWorkspaceEnvironment(
        { ...workspaceImage(["gh"]), screen: true },
        "x86_64",
        (packageName) => {
          asked.push(packageName);
          return Effect.succeed(
            resolution(packageName, packageName === "gh" ? { canonicalId: "github-cli" } : {}),
          );
        },
      ),
    );

    expect(asked).toEqual([
      "gh",
      "doppler",
      "postgresql-client",
      "redis-cli",
      ...screenPackageIds("arch"),
    ]);
    expect(result.workspaceImage).toMatchObject({ packages: ["github-cli"], screen: true });
  });

  it("refuses a screen whose packages the platform's catalog does not carry", async () => {
    const result = await Effect.runPromise(
      resolveWorkspaceEnvironment({ ...workspaceImage(["pnpm"]), screen: true }, "x86_64", (name) =>
        Effect.succeed(
          name === "pnpm" ? resolution(name) : resolution(name, { canonicalId: null }),
        ),
      ),
    );

    expect(result.workspaceImage).toBeNull();
    expect(result.resolutions.filter((r) => !r.supported).map((r) => r.requested)).toEqual([
      "doppler",
      "postgresql-client",
      "redis-cli",
      ...screenPackageIds("arch"),
    ]);
  });

  it("refuses a screen off x86_64 before asking the platform anything", async () => {
    let asked = 0;
    const result = await Effect.runPromise(
      resolveWorkspaceEnvironment(
        { ...workspaceImage(["pnpm"]), screen: true },
        "aarch64",
        (name) =>
          Effect.sync(() => {
            asked++;
            return resolution(name);
          }),
      ).pipe(Effect.result),
    );

    expect(result._tag === "Failure" ? result.failure : null).toBeInstanceOf(SettingsFailure);
    expect(asked).toBe(0);
  });

  it("merges a resolved environment into settings read after validation", async () => {
    let current = new MendSettings({ ...defaultSettings, autoTour: false });
    const requested = workspaceImage(["pnpm"]);

    const result = await Effect.runPromise(
      saveResolvedWorkspaceEnvironmentWith(
        requested,
        (latest, resolved) => new MendSettings({ ...latest, workspaceImage: resolved }),
        {
          architecture: "x86_64",
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

describe("workspace environment save boundaries", () => {
  it("saves a custom draft verbatim without querying a managed catalog", async () => {
    const draft: WorkspaceImage = {
      mode: "custom",
      baseImage: "example.invalid/own-base:fixture",
      packages: ["own-package", "own-package"],
      setupCommands: ["echo fixture"],
      services: { docker: false },
    };
    let current = new MendSettings({ ...defaultSettings, autoTour: false });
    const resolved: Array<string> = [];
    let saves = 0;
    const result = await Effect.runPromise(
      saveResolvedWorkspaceEnvironmentWith(
        draft,
        (latest, image) => new MendSettings({ ...latest, workspaceImage: image }),
        {
          architecture: "x86_64",
          getSettings: () => Effect.succeed(current),
          modifySettings: (update) =>
            Effect.sync(() => {
              saves++;
              current = update(current);
              return current;
            }),
          resolvePackage: (name) => {
            resolved.push(name);
            return Effect.die("custom image queried a managed catalog");
          },
        },
      ),
    );
    expect(result.saved).toBe(true);
    expect(result.resolutions).toEqual([]);
    expect({ saves, resolved }).toEqual({ saves: 1, resolved: [] });
    expect(current.workspaceImage).toEqual(draft);
    expect(result.settings).toEqual(
      new MendSettings({ ...defaultSettings, autoTour: false, workspaceImage: draft }),
    );
  });

  it("returns current settings without saving any part of an unresolved draft", async () => {
    const initial = new MendSettings({ ...defaultSettings, autoTour: false });
    let current = initial;
    let saves = 0;
    const result = await Effect.runPromise(
      saveResolvedWorkspaceEnvironmentWith(
        workspaceImage(["pnpm", "missing"]),
        (latest, image) => new MendSettings({ ...latest, workspaceImage: image }),
        {
          architecture: "x86_64",
          getSettings: () => Effect.succeed(current),
          modifySettings: (update) =>
            Effect.sync(() => {
              saves++;
              current = update(current);
              return current;
            }),
          resolvePackage: (name) =>
            Effect.succeed(
              name === "missing"
                ? resolution(name, { status: "not-found", canonicalId: null, supported: false })
                : resolution(name),
            ),
        },
      ),
    );
    expect(result.saved).toBe(false);
    expect(result.settings).toEqual(initial);
    expect(result.resolutions.map(({ requested, status }) => ({ requested, status }))).toEqual([
      { requested: "pnpm", status: "resolved" },
      { requested: "missing", status: "not-found" },
      { requested: "doppler", status: "resolved" },
      { requested: "postgresql-client", status: "resolved" },
      { requested: "redis-cli", status: "resolved" },
    ]);
    expect({ saves, current }).toEqual({ saves: 0, current: initial });
  });

  it("maps a catalog outage at the actual service boundary without writing settings", async () => {
    const initial = new MendSettings({ ...defaultSettings, autoTour: false });
    let current = initial;
    let saves = 0;
    const result = await Effect.runPromise(
      saveResolvedWorkspaceEnvironment(
        workspaceImage(["pnpm"]),
        (latest, image) => new MendSettings({ ...latest, workspaceImage: image }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(SettingsRepo, {
              get: () => Effect.succeed(current),
              modify: (update) =>
                Effect.sync(() => {
                  saves++;
                  current = update(current);
                  return current;
                }),
            }),
            Layer.mock(SealantClient, {
              resolveWorkspacePackage: () =>
                Effect.fail(
                  new SealantPlatformError({
                    status: 503,
                    code: "fixture_unavailable",
                    message: "catalog unavailable",
                    cause: new Error("owned catalog fixture unavailable"),
                  }),
                ),
            }),
          ),
        ),
        Effect.result,
      ),
    );
    expect(result._tag === "Failure" ? result.failure : null).toEqual(
      new SettingsFailure({ message: "catalog unavailable" }),
    );
    expect({ saves, current }).toEqual({ saves: 0, current: initial });
  });

  it("propagates a refused persistence write without reporting a saved draft", async () => {
    const initial = new MendSettings({ ...defaultSettings, autoTour: false });
    let attempts = 0;
    const failure = new SettingsFailure({ message: "fixture write refused" });
    const result = await Effect.runPromise(
      saveResolvedWorkspaceEnvironmentWith(
        workspaceImage(["pnpm"]),
        (latest, image) => new MendSettings({ ...latest, workspaceImage: image }),
        {
          architecture: "x86_64",
          getSettings: () => Effect.succeed(initial),
          modifySettings: () => {
            attempts++;
            return Effect.fail(failure);
          },
          resolvePackage: (name) => Effect.succeed(resolution(name)),
        },
      ).pipe(Effect.result),
    );
    expect(result._tag === "Failure" ? result.failure : null).toBe(failure);
    expect(attempts).toBe(1);
  });
});
