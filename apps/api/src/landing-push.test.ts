import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OrganizationId, ProjectId } from "@mend/domain";
import { Project } from "@mend/domain/workbench";
import {
  AgentBridge,
  gitRemoteEnvironment,
  MendKeys,
  NO_SIGNER_SSH_COMMAND,
  SourcePolicy,
  makeSourcePolicy,
} from "@mend/store";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeProject } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { landingPushFor } from "./landing-state.ts";

describe("landing push destination and identity", () => {
  let repository: string;
  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), "mend-landing-identity-"));
    execFileSync("git", ["init", "-q", "--bare", "--template=", repository]);
  });
  afterEach(() => rmSync(repository, { recursive: true, force: true }));

  const prepare = async (
    originUrl: string,
    options: {
      readonly hasKey?: boolean;
      readonly mode?: "mend-key" | "bridge";
      readonly rewriteTarget?: string;
    } = {},
  ) => {
    const project = new Project({
      ...makeProject({
        id: ProjectId.make("p-api"),
        organizationId: OrganizationId.make("org-acme"),
        visibility: "shared",
        createdByUserId: "someone-else",
        storePath: repository,
      }),
      originUrl,
      gitAuthMode: options.mode ?? "mend-key",
    });
    execFileSync("git", ["config", "remote.origin.url", originUrl], { cwd: repository });
    if (options.rewriteTarget !== undefined) {
      execFileSync(
        "git",
        ["config", `url.${options.rewriteTarget}.insteadOf`, "git@github.com:acme/api.git"],
        { cwd: repository },
      );
    }
    const before = readFileSync(join(repository, "config"), "utf8");
    const keyReads: Array<string | null> = [];
    const keyUses: Array<string | null> = [];
    const bridgeUses: string[] = [];
    const layers = Layer.mergeAll(
      Layer.mock(ProjectAccess, { isOperator: () => Effect.succeed(false) }),
      Layer.succeed(
        SourcePolicy,
        makeSourcePolicy({
          profile: "tenant",
          allowedHosts: [],
          resolve: async () => ["140.82.112.3"],
        }),
      ),
      Layer.succeed(MendKeys, {
        read: (id) =>
          Effect.sync(() => {
            keyReads.push(id);
            return options.hasKey === false
              ? null
              : {
                  publicKey: "ssh-ed25519 fixture ada",
                  fingerprint: "fixture",
                  privateKeyPath: `/keys/${id}/id_ed25519`,
                };
          }),
        ensure: (id) =>
          Effect.sync(() => {
            keyUses.push(id);
            return {
              publicKey: "ssh-ed25519 fixture ada",
              fingerprint: "fixture",
              privateKeyPath: `/keys/${id}/id_ed25519`,
            };
          }),
      }),
      Layer.mock(AgentBridge, {
        status: (id) =>
          Effect.sync(() => {
            bridgeUses.push(id);
            return { connected: true, clientName: "laptop", since: null };
          }),
        socketPath: (id) => `/bridge/${id}.sock`,
      }),
    );
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const pending = yield* landingPushFor(project, "change-owner");
        expect(keyReads).toEqual([]);
        expect(keyUses).toEqual([]);
        const target = yield* pending;
        const env = yield* gitRemoteEnvironment(target.remoteEnv, {
          direction: "push",
          remote: target.remote ?? "origin",
          repositoryPath: repository,
          env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
        return { remote: target.remote ?? "origin", env };
      }).pipe(Effect.scoped, Effect.provide(layers)),
    );
    expect(project.originUrl).toBe(originUrl);
    expect(readFileSync(join(repository, "config"), "utf8")).toBe(before);
    return { ...answer, keyReads, keyUses, bridgeUses };
  };

  it.each([
    "https://github.com/acme/api.git",
    "https://github.com/acme/api",
    "https://github.com:443/acme/api.git",
  ])("uses only the change owner's Mend key for %s", async (origin) => {
    const result = await prepare(origin);
    expect(result.remote).toBe("git@github.com:acme/api.git");
    expect(result.keyReads).toEqual(["change-owner"]);
    expect(result.env.GIT_SSH_COMMAND).toContain("/keys/change-owner/id_ed25519");
    expect(result.env.GIT_SSH_COMMAND).toContain("HostName=140.82.112.3");
    expect(result.bridgeUses).toEqual([]);
  });

  it("uses the owner's existing Mend key for HTTPS GitHub even when the project selects bridge", async () => {
    const result = await prepare("https://github.com/acme/api.git", { mode: "bridge" });
    expect(result.remote).toBe("git@github.com:acme/api.git");
    expect(result.env.GIT_SSH_COMMAND).toContain("/keys/change-owner/id_ed25519");
    expect(result.bridgeUses).toEqual([]);
  });

  it.each(["mend-key", "bridge"] as const)(
    "leaves HTTPS GitHub without a Mend key on HTTPS in %s mode",
    async (mode) => {
      const result = await prepare("https://github.com/acme/api.git", { hasKey: false, mode });
      expect(result.remote).toBe("origin");
      expect(result.keyUses).toEqual([]);
      expect(result.env.GIT_SSH_COMMAND).toBe(NO_SIGNER_SSH_COMMAND);
    },
  );

  it("checks the rewritten push's effective destination through source policy", async () => {
    await expect(
      prepare("https://github.com/acme/api.git", {
        rewriteTarget: "http://169.254.169.254/private.git",
      }),
    ).rejects.toMatchObject({
      _tag: "GitError",
      stderr: expect.stringContaining("169.254.169.254 is not a repository host"),
    });
  });

  it.each([
    "https://gitlab.com/acme/api.git",
    "https://github.example.com/acme/api.git",
    "https://github.com:8443/acme/api.git",
  ])("retains HTTPS without an SSH credential for %s", async (origin) => {
    const result = await prepare(origin);
    expect(result.remote).toBe("origin");
    expect(result.keyReads).toEqual([]);
    expect(result.keyUses).toEqual([]);
    expect(result.env.GIT_SSH_COMMAND).toBe(NO_SIGNER_SSH_COMMAND);
  });

  it("retains the named SSH origin and owner's Mend key", async () => {
    const result = await prepare("git@github.com:acme/api.git");
    expect(result.remote).toBe("origin");
    expect(result.keyReads).toEqual([]);
    expect(result.keyUses).toEqual(["change-owner"]);
    expect(result.env.GIT_SSH_COMMAND).toContain("/keys/change-owner/id_ed25519");
  });

  it("retains the owner's bridge for an SSH origin", async () => {
    const result = await prepare("ssh://git@github.com/acme/api.git", { mode: "bridge" });
    expect(result.remote).toBe("origin");
    expect(result.keyReads).toEqual([]);
    expect(result.keyUses).toEqual([]);
    expect(result.bridgeUses).toEqual(["change-owner"]);
    expect(result.env.SSH_AUTH_SOCK).toBe("/bridge/change-owner.sock");
  });
});
