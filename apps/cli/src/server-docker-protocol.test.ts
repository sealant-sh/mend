import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  claimServerDockerVolumes,
  SERVER_VOLUME_OWNER_LABEL,
  verifyServerDockerVolumes,
  type ServerDockerNamespace,
} from "./server-docker-volumes.ts";
import type { ServerSetupRuntime } from "./server-setup.ts";

// Opt in with an explicit context. Never inspect, create or remove standard Mend resources.
const context = process.env["MEND_DOCKER_TEST_CONTEXT"];
const environment: NodeJS.ProcessEnv = {};
for (const key of [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DOCKER_CONFIG",
  "SSH_AUTH_SOCK",
  "TMPDIR",
  "TMP",
  "TEMP",
]) {
  if (process.env[key] !== undefined) environment[key] = process.env[key];
}
const runtime: Pick<ServerSetupRuntime, "run"> = {
  run: (command, args, options = { timeoutMs: 30_000 }) =>
    new Promise((resolve) => {
      execFile(
        command,
        [...args],
        {
          env: environment,
          encoding: "utf8",
          timeout: options.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          resolve({
            status: error === null ? 0 : null,
            stdout,
            stderr,
            ...(error === null ? {} : { error: error.message }),
          });
        },
      );
    }),
};
const volumeRuntime = {
  run: (command: string, args: ReadonlyArray<string>) =>
    runtime.run(command, args, { timeoutMs: 30_000 }),
};
const docker = async (...args: string[]) => {
  if (context === undefined) throw new Error("Explicit integration Docker context is required");
  const output = await runtime.run("docker", ["--context", context, ...args], {
    timeoutMs: 60_000,
  });
  if (output.status !== 0) throw new Error(output.error ?? output.stderr);
  return output.stdout.trim();
};
const freshNamespace = (): ServerDockerNamespace => {
  const project = `mend-protocol-${randomBytes(12).toString("hex")}`;
  return { project, store: `${project}-store`, control: `${project}-control` };
};
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const cleanVolumes = async (namespace: ServerDockerNamespace, owners: ReadonlyArray<string>) => {
  for (const name of [namespace.control, namespace.store]) {
    // Exact-name comparison after a successful list, never failure-message matching.
    const names = (await docker("volume", "ls", "--format", "{{.Name}}")).split("\n");
    if (!names.includes(name)) continue;
    const owner = await docker(
      "volume",
      "inspect",
      name,
      "--format",
      `{{index .Labels "${SERVER_VOLUME_OWNER_LABEL}"}}`,
    );
    expect(owners).toContain(owner);
    await docker("volume", "rm", name);
  }
};

describe.skipIf(context === undefined)("real Docker ownership and registry protocol", () => {
  it("Engine named create preserves original labels; matching retries verify and another identity loses", async () => {
    if (context === undefined) return;
    const namespace = freshNamespace();
    const identityBytes = randomBytes(48);
    const otherIdentity = randomBytes(48);
    const input = { dockerContext: context, identityBytes, namespace };
    try {
      expect(await claimServerDockerVolumes(volumeRuntime, input)).toMatchObject({ _tag: "ok" });
      await docker(
        "volume",
        "create",
        "--label",
        `${SERVER_VOLUME_OWNER_LABEL}=${digest(otherIdentity)}`,
        namespace.store,
      );
      expect(await verifyServerDockerVolumes(volumeRuntime, input)).toMatchObject({ _tag: "ok" });
      expect(await claimServerDockerVolumes(volumeRuntime, input)).toMatchObject({ _tag: "ok" });
      expect(
        await claimServerDockerVolumes(volumeRuntime, { ...input, identityBytes: otherIdentity }),
      ).toMatchObject({ _tag: "error", error: { reason: "conflict" } });
    } finally {
      await cleanVolumes(namespace, [digest(identityBytes)]);
    }
  }, 120_000);

  it("claims beside a foreign Compose namespace and preserves its container and network", async () => {
    if (context === undefined) return;
    const namespace = freshNamespace();
    const foreignProject = `${namespace.project}-dev`;
    const identityBytes = randomBytes(48);
    const label = "dev.sealant.mend.protocol-test";
    const nonce = randomBytes(24).toString("hex");
    let containerId: string | undefined;
    let networkId: string | undefined;
    // Test infrastructure only. The stopped container needs neither ports nor persistent storage.
    await docker("image", "pull", "busybox:1.37");
    try {
      containerId = await docker(
        "container",
        "create",
        "--name",
        `${foreignProject}-postgres-1`,
        "--label",
        `${label}=${nonce}`,
        "--label",
        `com.docker.compose.project=${foreignProject}`,
        "busybox:1.37",
        "true",
      );
      networkId = await docker(
        "network",
        "create",
        "--label",
        `${label}=${nonce}`,
        "--label",
        `com.docker.compose.project=${foreignProject}`,
        `${foreignProject}_default`,
      );
      const beforeContainer = await docker("container", "inspect", containerId);
      const beforeNetwork = await docker("network", "inspect", networkId);
      expect(
        await claimServerDockerVolumes(volumeRuntime, {
          dockerContext: context,
          identityBytes,
          namespace,
        }),
      ).toMatchObject({ _tag: "ok" });
      expect(await docker("container", "inspect", containerId)).toBe(beforeContainer);
      expect(await docker("network", "inspect", networkId)).toBe(beforeNetwork);
    } finally {
      if (containerId !== undefined) {
        expect(
          await docker(
            "container",
            "inspect",
            containerId,
            "--format",
            `{{index .Config.Labels "${label}"}}`,
          ),
        ).toBe(nonce);
        await docker("container", "rm", containerId);
      }
      if (networkId !== undefined) {
        expect(
          await docker("network", "inspect", networkId, "--format", `{{index .Labels "${label}"}}`),
        ).toBe(nonce);
        await docker("network", "rm", networkId);
      }
      await cleanVolumes(namespace, [digest(identityBytes)]);
    }
  }, 120_000);

  it("two concurrent identities cannot both claim a fresh namespace", async () => {
    if (context === undefined) return;
    const namespace = freshNamespace();
    const identities = [randomBytes(48), randomBytes(48)];
    const dockerContext = context;
    try {
      const results = await Promise.all(
        identities.map((identityBytes) =>
          claimServerDockerVolumes(volumeRuntime, { dockerContext, identityBytes, namespace }),
        ),
      );
      expect(results.filter((result) => result._tag === "ok")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "error")).toHaveLength(1);
      const storeOwner = await docker(
        "volume",
        "inspect",
        namespace.store,
        "--format",
        `{{index .Labels "${SERVER_VOLUME_OWNER_LABEL}"}}`,
      );
      const controlOwner = await docker(
        "volume",
        "inspect",
        namespace.control,
        "--format",
        `{{index .Labels "${SERVER_VOLUME_OWNER_LABEL}"}}`,
      );
      expect(storeOwner).toBe(controlOwner);
    } finally {
      await cleanVolumes(namespace, identities.map(digest));
    }
  }, 120_000);
});
