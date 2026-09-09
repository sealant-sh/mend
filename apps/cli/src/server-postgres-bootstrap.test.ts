import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { runServerProcess } from "./server-runtime.ts";
import { withServerStore } from "./server-store.ts";

// Explicit opt-in; requires the official image already loaded in a local bind-capable daemon.
const environment = { ...process.env };
const context = environment["MEND_DOCKER_TEST_CONTEXT"];
const image = "postgres:17-alpine";
const label = "dev.sealant.mend.bootstrap-test";
const docker = async (...args: string[]) => {
  if (context === undefined) throw new Error("Explicit integration Docker context is required");
  const output = await runServerProcess("docker", ["--context", context, ...args], environment, {
    timeoutMs: 10_000,
  });
  if (output.status !== 0) throw new Error(output.error ?? output.stderr);
  return output.stdout.trim();
};

const waitForBootstrap = async (containerId: string) => {
  if (context === undefined) throw new Error("Explicit integration Docker context is required");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const logs = await docker("container", "logs", containerId);
    const running = await docker(
      "container",
      "inspect",
      containerId,
      "--format",
      "{{.State.Running}}",
    );
    if (running !== "true") throw new Error(`Postgres exited during bootstrap:\n${logs}`);
    // The temporary init server has no TCP listener. Wait for init completion and the final server.
    if (logs.includes("PostgreSQL init process complete; ready for start up.")) {
      const ready = await runServerProcess(
        "docker",
        [
          "--context",
          context,
          "exec",
          containerId,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
        ],
        environment,
        { timeoutMs: 5_000 },
      );
      if (ready.status === 0) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Postgres bootstrap timed out:\n${await docker("container", "logs", containerId)}`,
  );
};

describe.skipIf(context === undefined)("real official Postgres bootstrap", () => {
  it("boots the store-generated read-only init as UID 70 and authenticates both database owners", async () => {
    const nonce = randomBytes(12).toString("hex");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-postgres-bootstrap-"));
    const adminPassword = randomBytes(24).toString("hex");
    const mendPassword = randomBytes(24).toString("hex");
    const sealantPassword = randomBytes(24).toString("hex");
    let containerId: string | undefined;
    try {
      const result = await withServerStore(root, async (store) =>
        store.commit({
          identity: "bootstrap-test-identity\n",
          config: "{}\n",
          env: `POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=${adminPassword}\nPOSTGRES_HOST_AUTH_METHOD=scram-sha-256\nMEND_DB_PASSWORD=${mendPassword}\nSEALANT_DB_PASSWORD=${sealantPassword}\n`,
          compose: fs.readFileSync(
            new URL("../test-fixtures/docker/compose.v2.yaml", import.meta.url),
            "utf8",
          ),
          postgresInit: fs.readFileSync(
            new URL("../test-fixtures/docker/postgres-init.sh", import.meta.url),
            "utf8",
          ),
        }),
      );
      if (result._tag === "error") throw result.error;
      if (result.value._tag === "error") throw result.value.error;
      const directory = result.value.value.directory;
      const script = path.join(directory, "postgres-init.sh");
      expect(fs.statSync(script).mode & 0o7777).toBe(0o755);
      for (const secret of [adminPassword, mendPassword, sealantPassword]) {
        expect(fs.readFileSync(script, "utf8").includes(secret)).toBe(false);
      }
      // Create separately so every subsequent failure still has an acquired ID for cleanup.
      // tmpfs covers the image's declared PGDATA volume: no named or anonymous data volumes.
      containerId = await docker(
        "container",
        "create",
        "--pull",
        "never",
        "--name",
        `mend-bootstrap-${nonce}`,
        "--label",
        `${label}=${nonce}`,
        "--network",
        "none",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "--env-file",
        path.join(directory, "server.env"),
        "--mount",
        `type=bind,source=${script},target=/docker-entrypoint-initdb.d/10-mend.sh,readonly`,
        image,
      );
      await docker("container", "start", containerId);
      await waitForBootstrap(containerId);
      expect(await docker("exec", containerId, "id", "-u", "postgres")).toBe("70");
      expect(
        await docker(
          "container",
          "inspect",
          containerId,
          "--format",
          '{{range .Mounts}}{{if eq .Destination "/docker-entrypoint-initdb.d/10-mend.sh"}}{{.RW}}{{end}}{{end}}',
        ),
      ).toBe("false");
      expect(
        await docker(
          "container",
          "inspect",
          containerId,
          "--format",
          '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}',
        ),
      ).toBe("");
      for (const [role, database, password] of [
        ["mend", "mend", mendPassword],
        ["sealant", "sealant_control_plane", sealantPassword],
      ] as const) {
        // TCP forces password authentication; a socket-only check could pass via local trust.
        expect(
          await docker(
            "exec",
            "--env",
            `PGPASSWORD=${password}`,
            containerId,
            "psql",
            "-X",
            "--no-password",
            "-h",
            "127.0.0.1",
            "-U",
            role,
            "-d",
            database,
            "-At",
            "--set=ON_ERROR_STOP=1",
            "-c",
            "SELECT current_user, current_database(), pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()",
          ),
        ).toBe(`${role}|${database}|${role}`);
      }
    } finally {
      try {
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
          await docker("container", "rm", "--force", containerId);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
