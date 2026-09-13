import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  claimServerDockerVolumes,
  MEND_DOCKER_NAMESPACE,
  MEND_DOCKER_NAMESPACE_WITH_GARAGE,
  SERVER_VOLUME_OWNER_LABEL,
  verifyServerDockerVolumes,
} from "./server-docker-volumes.ts";
import type { ServerSetupRuntime } from "./server-setup.ts";

const identity = Buffer.from("MEND_DB_PASSWORD=first-secret\n");
const otherIdentity = Buffer.from("MEND_DB_PASSWORD=other-secret\n");
const owner = createHash("sha256").update(identity).digest("hex");
const input = { dockerContext: "explicit-test-context", identityBytes: identity };
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const denied = { status: 1, stdout: "", stderr: "permission denied" };

type Labels = Record<string, string> | null;

// Faithful Engine named create: first writer keeps its labels; repeated creates return the name.
class DockerDaemon implements Pick<ServerSetupRuntime, "run"> {
  readonly volumes = new Map<string, Labels>();
  readonly containers = new Map<string, Labels>();
  readonly networks = new Map<string, Labels>();
  readonly commands: ReadonlyArray<string>[] = [];
  beforeCommand: (args: ReadonlyArray<string>) => Promise<void> = async () => {};
  response: (args: ReadonlyArray<string>) => ReturnType<typeof ok> | undefined = () => undefined;

  async run(command: string, args: ReadonlyArray<string>) {
    expect(command).toBe("docker");
    expect(args.slice(0, 2)).toEqual(["--context", input.dockerContext]);
    this.commands.push(args);
    await this.beforeCommand(args);
    const replacement = this.response(args);
    if (replacement !== undefined) return replacement;
    const [kind, operation] = args.slice(2);
    const collections = new Map([
      ["volume", this.volumes],
      ["container", this.containers],
      ["network", this.networks],
    ]);
    const collection = collections.get(kind ?? "");
    if (collection === undefined) throw new Error("Unexpected Docker resource");
    if (operation === "ls") {
      const filterIndex = args.indexOf("--filter");
      const project =
        filterIndex < 0
          ? undefined
          : args[filterIndex + 1]?.replace("label=com.docker.compose.project=", "");
      return ok(
        [...collection]
          .filter(
            ([, labels]) =>
              project === undefined || labels?.["com.docker.compose.project"] === project,
          )
          .map(([name]) => JSON.stringify(name))
          .join("\n"),
      );
    }
    if (kind === "volume" && operation === "create") {
      const name = args.at(-1);
      const label = args[args.indexOf("--label") + 1];
      if (name === undefined || label === undefined) throw new Error("Invalid create arguments");
      if (!this.volumes.has(name))
        this.volumes.set(name, {
          [SERVER_VOLUME_OWNER_LABEL]: label.slice(label.indexOf("=") + 1),
        });
      return ok(name);
    }
    if (operation === "inspect") {
      const name = args[4] ?? "";
      if (!collection.has(name)) return { status: 1, stdout: "", stderr: "No such resource" };
      if (kind !== "volume")
        expect(args.at(-1)).toBe(
          `{"Name":{{json .Name}},"Labels":{{json .${kind === "container" ? "Config.Labels" : "Labels"}}}}`,
        );
      return ok(
        JSON.stringify({
          Name: kind === "container" ? `/${name}` : name,
          Labels: collection.get(name),
        }),
      );
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  }

  mutations() {
    return this.commands.filter((args) => args[3] === "create");
  }
}

describe("daemon data ownership", () => {
  it("claims exact production volumes with SHA256 of persisted bytes, then verifies without allocation", async () => {
    const daemon = new DockerDaemon();
    expect(await claimServerDockerVolumes(daemon, input)).toEqual({
      _tag: "ok",
      value: { owner, namespace: MEND_DOCKER_NAMESPACE },
    });
    expect([...daemon.volumes]).toEqual([
      ["mend-store", { [SERVER_VOLUME_OWNER_LABEL]: owner }],
      ["mend-control", { [SERVER_VOLUME_OWNER_LABEL]: owner }],
    ]);
    const mutations = daemon.mutations().length;
    expect((await claimServerDockerVolumes(daemon, input))._tag).toBe("ok");
    expect((await verifyServerDockerVolumes(daemon, input))._tag).toBe("ok");
    expect(daemon.mutations()).toHaveLength(mutations);
    expect(JSON.stringify(daemon.commands)).not.toContain("first-secret");
  });

  it("claims the Garage volume beside the anchor for a bundle that carries it, and a generation without it verifies without it", async () => {
    const daemon = new DockerDaemon();
    const withGarage = { ...input, namespace: MEND_DOCKER_NAMESPACE_WITH_GARAGE };
    // An install from before the capture store: store + control only.
    expect((await claimServerDockerVolumes(daemon, input))._tag).toBe("ok");
    expect([...daemon.volumes.keys()]).toEqual(["mend-store", "mend-control"]);
    // Its lifecycle commands verify the two; the Garage volume is not asked for.
    expect((await verifyServerDockerVolumes(daemon, input))._tag).toBe("ok");
    expect(await verifyServerDockerVolumes(daemon, withGarage)).toMatchObject({
      _tag: "error",
      error: { reason: "missing", operation: "garage" },
    });
    // The upgrade that brings Garage claims its volume under the same identity, idempotently.
    expect(await claimServerDockerVolumes(daemon, withGarage)).toEqual({
      _tag: "ok",
      value: { owner, namespace: MEND_DOCKER_NAMESPACE_WITH_GARAGE },
    });
    expect(daemon.volumes.get("mend-garage")).toEqual({ [SERVER_VOLUME_OWNER_LABEL]: owner });
    const mutations = daemon.mutations().length;
    expect((await claimServerDockerVolumes(daemon, withGarage))._tag).toBe("ok");
    expect((await verifyServerDockerVolumes(daemon, withGarage))._tag).toBe("ok");
    expect(daemon.mutations()).toHaveLength(mutations);
    // A Garage volume somebody else labelled is a conflict, never adopted.
    daemon.volumes.set("mend-garage", { [SERVER_VOLUME_OWNER_LABEL]: "different-owner" });
    expect(await verifyServerDockerVolumes(daemon, withGarage)).toMatchObject({
      _tag: "error",
      error: { reason: "conflict" },
    });
  });

  it("coexists with mend-dev without modifying its containers, networks or volumes", async () => {
    const daemon = new DockerDaemon();
    const labels = { "com.docker.compose.project": "mend-dev" };
    daemon.containers.set("mend-dev-postgres-1", labels);
    daemon.networks.set("mend-dev_default", labels);
    daemon.volumes.set("mend-dev_postgres", labels);
    const containers = [...daemon.containers];
    const networks = [...daemon.networks];
    expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({ _tag: "ok" });
    expect([...daemon.containers]).toEqual(containers);
    expect([...daemon.networks]).toEqual(networks);
    expect(daemon.volumes.get("mend-dev_postgres")).toEqual(labels);
    expect(daemon.mutations().map((args) => args.at(-1))).toEqual(["mend-store", "mend-control"]);
    expect(
      daemon.commands.every((args) => ["ls", "inspect", "create"].includes(args[3] ?? "")),
    ).toBe(true);
  });

  describe.each(["container", "network"] as const)("%s namespace evidence", (kind) => {
    it.each(["-postgres-1", "_postgres_1", "_default"])(
      "permits a foreign project in its own namespace: mend-dev%s",
      async (suffix) => {
        const daemon = new DockerDaemon();
        const resources = kind === "container" ? daemon.containers : daemon.networks;
        resources.set(`mend-dev${suffix}`, { "com.docker.compose.project": "mend-dev" });
        const before = [...resources];
        expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({ _tag: "ok" });
        expect([...resources]).toEqual(before);
      },
    );

    it.each(["mend_dev", "mend-postgres-dev", "mend-mend-dev"])(
      "permits project %s without treating its name as a reserved service",
      async (project) => {
        const daemon = new DockerDaemon();
        const resources = kind === "container" ? daemon.containers : daemon.networks;
        const name = kind === "container" ? `${project}-postgres-1` : `${project}_default`;
        const labels = { "com.docker.compose.project": project };
        resources.set(name, labels);
        expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({ _tag: "ok" });
        expect(resources.get(name)).toEqual(labels);
      },
    );

    it.each([
      ["mend-dev-postgres-1", null],
      ["mend_dev_postgres_1", {}],
      ["mend-old-1", null],
      ["mend_old_1", null],
      ["mend-", null],
      ["mend_", null],
      ["mend-dev-postgres-1", { "com.docker.compose.project": "mend" }],
      ["unrelated-name", { "com.docker.compose.project": "mend" }],
      ["mend-dev-postgres-1", { "com.docker.compose.project": "other" }],
      ["mend-dev-postgres-1", { "com.docker.compose.project": "mend-de" }],
      ["mend-dev-postgres-1", { "com.docker.compose.project": "mend-dev-postgres-1" }],
      ["mend-dev-", { "com.docker.compose.project": "mend-dev" }],
      ["mend-dev_", { "com.docker.compose.project": "mend-dev" }],
      ["mend-dev-postgres-1", { "com.docker.compose.project": "" }],
      ["mend-dev-postgres-1", { "com.docker.compose.project": "MEND-dev" }],
      ["mend-dev-postgres-1", { "com.docker.compose.project": "mend.dev" }],
    ] as const)("refuses ambiguous or mismatched name %s with labels %j", async (name, labels) => {
      const daemon = new DockerDaemon();
      const resources = kind === "container" ? daemon.containers : daemon.networks;
      resources.set(name, labels);
      const before = [...resources];
      expect((await claimServerDockerVolumes(daemon, input))._tag).toBe("error");
      expect(daemon.mutations()).toEqual([]);
      expect([...resources]).toEqual(before);
    });

    it.each([
      "permission",
      "vanished",
      "rejected",
      "invalid-json",
      "null",
      "array",
      "wrong-name",
      "missing-name",
      "missing-labels",
      "array-labels",
      "number-label",
    ])("inconclusive inspection (%s) fails before allocation", async (failure) => {
      const daemon = new DockerDaemon();
      const resources = kind === "container" ? daemon.containers : daemon.networks;
      const name = "mend-dev_postgres_1";
      const labels = { "com.docker.compose.project": "mend-dev" };
      resources.set(name, labels);
      const inspectedName = kind === "container" ? `/${name}` : name;
      daemon.response = (args) => {
        if (args[2] !== kind || args[3] !== "inspect") return undefined;
        if (failure === "rejected") throw new Error("transport failure");
        if (failure === "permission" || failure === "vanished") return denied;
        if (failure === "invalid-json") return ok("{");
        if (failure === "null") return ok("null");
        if (failure === "array") return ok("[]");
        if (failure === "wrong-name") return ok(JSON.stringify({ Name: "other", Labels: labels }));
        if (failure === "missing-name") return ok(JSON.stringify({ Labels: labels }));
        if (failure === "missing-labels") return ok(JSON.stringify({ Name: inspectedName }));
        return ok(
          JSON.stringify({
            Name: inspectedName,
            Labels: failure === "array-labels" ? [] : { ...labels, other: 42 },
          }),
        );
      };
      expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
        _tag: "error",
        error: {
          reason: ["permission", "vanished", "rejected"].includes(failure)
            ? "docker"
            : "inspection",
        },
      });
      expect(daemon.mutations()).toEqual([]);
      expect(resources.get(name)).toEqual(labels);
    });

    it("does not let a proven foreign resource hide a later orphan", async () => {
      const daemon = new DockerDaemon();
      const resources = kind === "container" ? daemon.containers : daemon.networks;
      resources.set("mend-dev_postgres_1", { "com.docker.compose.project": "mend-dev" });
      resources.set("mend-orphan", null);
      expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
        _tag: "error",
        error: { reason: "unowned-data" },
      });
      expect(daemon.mutations()).toEqual([]);
    });
  });

  it.each([
    "mend",
    "mend-store",
    "mend-control",
    "mend-mend",
    "mend-postgres",
    "mend-mend-1",
    "mend-postgres-1",
    "mend-postgres-2",
    "mend-mend-run-abc123",
    "mend_mend_1",
    "mend_postgres_1",
    "mend_postgres_2",
  ])("a foreign label cannot excuse reserved container %s", async (name) => {
    const daemon = new DockerDaemon();
    // The claimed project deliberately matches the prefix where possible, not just an unrelated label.
    const project = name.replace(/[-_][^-_]+$/, "");
    daemon.containers.set(name, { "com.docker.compose.project": project });
    expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
      _tag: "error",
      error: { reason: "unowned-data" },
    });
    expect(daemon.mutations()).toEqual([]);
  });

  it.each(["mend", "mend_default", "mend-default", "mend-store", "mend-control"])(
    "a foreign label cannot excuse reserved network %s",
    async (name) => {
      const daemon = new DockerDaemon();
      daemon.networks.set(name, { "com.docker.compose.project": "mend-dev" });
      expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
        _tag: "error",
        error: { reason: "unowned-data" },
      });
      expect(daemon.mutations()).toEqual([]);
    },
  );

  it.each(["mend-store", "mend-control", "mend_dev_postgres"])(
    "foreign Compose labels do not relax volume guard for %s",
    async (name) => {
      const daemon = new DockerDaemon();
      const labels = {
        "com.docker.compose.project": "mend_dev",
        [SERVER_VOLUME_OWNER_LABEL]: "other",
      };
      daemon.volumes.set(name, labels);
      expect((await claimServerDockerVolumes(daemon, input))._tag).toBe("error");
      expect(daemon.mutations()).toEqual([]);
      expect(daemon.volumes.get(name)).toEqual(labels);
    },
  );

  it("another config directory or lost config cannot replace credentials", async () => {
    const daemon = new DockerDaemon();
    await claimServerDockerVolumes(daemon, input);
    const before = [...daemon.volumes];
    const result = await claimServerDockerVolumes(daemon, {
      ...input,
      identityBytes: otherIdentity,
    });
    expect(result).toMatchObject({ _tag: "error", error: { reason: "conflict" } });
    expect([...daemon.volumes]).toEqual(before);
    expect(daemon.mutations()).toHaveLength(2);
    // Even a trailing newline is identity, not normalized configuration text.
    expect(
      await verifyServerDockerVolumes(daemon, {
        ...input,
        identityBytes: Buffer.concat([identity, Buffer.from("\n")]),
      }),
    ).toMatchObject({ _tag: "error", error: { reason: "conflict" } });
  });

  it("only one of two fresh identities that both saw an empty daemon can create control", async () => {
    const daemon = new DockerDaemon();
    let arrived = 0;
    let release: (() => void) | undefined;
    const bothAtClaim = new Promise<void>((resolve) => {
      release = resolve;
    });
    daemon.beforeCommand = async (args) => {
      if (args[3] !== "create" || args.at(-1) !== "mend-store") return;
      arrived += 1;
      if (arrived === 2) release?.();
      await bothAtClaim;
    };
    const results = await Promise.all([
      claimServerDockerVolumes(daemon, input),
      claimServerDockerVolumes(daemon, { ...input, identityBytes: otherIdentity }),
    ]);
    expect(results.filter((result) => result._tag === "ok")).toHaveLength(1);
    expect(results.filter((result) => result._tag === "error")).toMatchObject([
      { error: { reason: "conflict" } },
    ]);
    expect(daemon.mutations().filter((args) => args.at(-1) === "mend-control")).toHaveLength(1);
    expect(daemon.volumes.get("mend-control")).toEqual(daemon.volumes.get("mend-store"));
  });

  it.each([
    "store-unlabelled",
    "control",
    "compose-volume",
    "labelled-volume",
    "container",
    "network",
    "named-container",
    "named-network",
  ])("refuses old %s data before the first claim", async (kind) => {
    const daemon = new DockerDaemon();
    const projectLabel = { "com.docker.compose.project": "mend" };
    if (kind === "store-unlabelled") daemon.volumes.set("mend-store", null);
    if (kind === "control")
      daemon.volumes.set("mend-control", { [SERVER_VOLUME_OWNER_LABEL]: owner });
    if (kind === "compose-volume") daemon.volumes.set("mend_unknown-old-data", null);
    if (kind === "labelled-volume") daemon.volumes.set("custom-volume", projectLabel);
    if (kind === "container") daemon.containers.set("custom-container", projectLabel);
    if (kind === "network") daemon.networks.set("custom-network", projectLabel);
    if (kind === "named-container") daemon.containers.set("mend-old-1", null);
    if (kind === "named-network") daemon.networks.set("mend_default", null);
    expect((await claimServerDockerVolumes(daemon, input))._tag).toBe("error");
    expect(daemon.mutations()).toEqual([]);
  });

  it("matching anchor allows control creation and existing Compose-managed data", async () => {
    const daemon = new DockerDaemon();
    daemon.volumes.set("mend-store", { [SERVER_VOLUME_OWNER_LABEL]: owner });
    daemon.volumes.set("mend_mend-postgres", null);
    expect((await claimServerDockerVolumes(daemon, input))._tag).toBe("ok");
    expect(daemon.mutations()).toHaveLength(1);
    expect(daemon.volumes.get("mend_mend-postgres")).toBeNull();
  });

  it.each([null, {}, { [SERVER_VOLUME_OWNER_LABEL]: "different-owner" }])(
    "refuses conflicting control without relabelling",
    async (labels) => {
      const daemon = new DockerDaemon();
      daemon.volumes.set("mend-store", { [SERVER_VOLUME_OWNER_LABEL]: owner });
      daemon.volumes.set("mend-control", labels);
      expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
        _tag: "error",
        error: { reason: "conflict" },
      });
      expect(daemon.volumes.get("mend-control")).toEqual(labels);
      expect(daemon.mutations()).toEqual([]);
    },
  );

  it("a control volume appearing during create is never adopted", async () => {
    const daemon = new DockerDaemon();
    daemon.beforeCommand = async (args) => {
      if (args[3] === "create" && args.at(-1) === "mend-control")
        daemon.volumes.set("mend-control", null);
    };
    expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
      _tag: "error",
      error: { reason: "conflict" },
    });
    expect(daemon.volumes.get("mend-control")).toBeNull();
  });

  it.each(["anchor", "control"])(
    "verify-only reports missing %s without allocation",
    async (missing) => {
      const daemon = new DockerDaemon();
      if (missing === "control")
        daemon.volumes.set("mend-store", { [SERVER_VOLUME_OWNER_LABEL]: owner });
      expect(await verifyServerDockerVolumes(daemon, input)).toMatchObject({
        _tag: "error",
        error: { reason: "missing", operation: missing },
      });
      expect(daemon.mutations()).toEqual([]);
    },
  );

  it.each(["volume", "container", "network"])(
    "failed %s listing is not an empty daemon",
    async (kind) => {
      const daemon = new DockerDaemon();
      daemon.response = (args) => (args[2] === kind && args[3] === "ls" ? denied : undefined);
      expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
        _tag: "error",
        error: { reason: "docker" },
      });
      expect(daemon.mutations()).toEqual([]);
    },
  );

  it.each([
    "permission",
    "vanished",
    "invalid-json",
    "wrong-name",
    "invalid-labels",
    "missing-labels",
    "rejected",
  ])("inconclusive anchor inspection (%s) fails closed", async (kind) => {
    const daemon = new DockerDaemon();
    daemon.volumes.set("mend-store", { [SERVER_VOLUME_OWNER_LABEL]: owner });
    daemon.response = (args) => {
      if (args[3] !== "inspect") return undefined;
      if (kind === "rejected") throw new Error("transport failure");
      if (kind === "permission" || kind === "vanished") return denied;
      if (kind === "invalid-json") return ok("{");
      if (kind === "wrong-name")
        return ok(
          JSON.stringify({ Name: "other", Labels: { [SERVER_VOLUME_OWNER_LABEL]: owner } }),
        );
      if (kind === "missing-labels") return ok(JSON.stringify({ Name: "mend-store" }));
      return ok(JSON.stringify({ Name: "mend-store", Labels: [] }));
    };
    expect((await claimServerDockerVolumes(daemon, input))._tag).toBe("error");
    expect(daemon.mutations()).toEqual([]);
  });

  it("failed post-create inspection stops before control and is retryable with the persisted identity", async () => {
    const daemon = new DockerDaemon();
    daemon.response = (args) => (args[3] === "inspect" ? denied : undefined);
    expect((await claimServerDockerVolumes(daemon, input))._tag).toBe("error");
    expect([...daemon.volumes.keys()]).toEqual(["mend-store"]);
    daemon.response = () => undefined;
    expect((await claimServerDockerVolumes(daemon, input))._tag).toBe("ok");
  });

  it.each(["garbage", "null", "{}", '"bad name"'])(
    "rejects malformed listing %s",
    async (stdout) => {
      const daemon = new DockerDaemon();
      daemon.response = () => ok(stdout);
      expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
        _tag: "error",
        error: { reason: "inspection" },
      });
      expect(daemon.mutations()).toEqual([]);
    },
  );

  it("supports concrete isolated names without creating production volumes", async () => {
    const daemon = new DockerDaemon();
    const namespace = { project: "isolated", store: "isolated-store", control: "isolated-control" };
    daemon.volumes.set("mend-store", null);
    expect((await claimServerDockerVolumes(daemon, { ...input, namespace }))._tag).toBe("ok");
    expect(daemon.volumes.get("mend-store")).toBeNull();
    expect(daemon.mutations().map((args) => args.at(-1))).toEqual([
      namespace.store,
      namespace.control,
    ]);
  });
});
