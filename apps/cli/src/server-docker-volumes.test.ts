import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  claimServerDockerVolumes,
  findServerOldData,
  MEND_DOCKER_NAMESPACE,
  MEND_DOCKER_NAMESPACE_WITH_GARAGE,
  removeServerLeftovers,
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
  /** Containers that run; the rest are stopped. */
  readonly running = new Set<string>();
  /** The running containers attached to each network. */
  readonly attached = new Map<string, ReadonlyArray<string>>();
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
      // Only the ownership evidence: never a container's whole config, which holds its secrets.
      if (kind === "container")
        expect(args.at(-1)).toBe(
          '{"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"Running":{{json .State.Running}}}',
        );
      if (kind === "network")
        expect(args.at(-1)).toBe(
          '{"Name":{{json .Name}},"Labels":{{json .Labels}},"Containers":{{json .Containers}}}',
        );
      return ok(
        JSON.stringify({
          Name: kind === "container" ? `/${name}` : name,
          Labels: collection.get(name),
          ...(kind === "container" ? { Running: this.running.has(name) } : {}),
          ...(kind === "network"
            ? {
                Containers: Object.fromEntries(
                  (this.attached.get(name) ?? []).map((container, index) => [
                    `id${index}`,
                    { Name: container },
                  ]),
                ),
              }
            : {}),
        }),
      );
    }
    if (operation === "rm") {
      const name = args.at(-1) ?? "";
      if (!collection.delete(name)) return { status: 1, stdout: "", stderr: "No such resource" };
      return ok(name);
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

describe("what stands in a fresh install's way", () => {
  const project = { "com.docker.compose.project": "mend" };
  const generation = {
    ...project,
    "com.docker.compose.project.working_dir":
      "/Users/a/.config/mend/generations/gen-00000000-0000-4000-8000-000000000000",
  };

  it("names an earlier install's network with nothing attached as a leftover, and removing it clears the way", async () => {
    const daemon = new DockerDaemon();
    daemon.networks.set("mend_default", project);
    const refused = await claimServerDockerVolumes(daemon, input);
    expect(refused).toMatchObject({
      _tag: "error",
      error: {
        reason: "unowned-data",
        found: {
          _tag: "leftovers",
          leftovers: {
            dockerContext: input.dockerContext,
            containers: [],
            networks: ["mend_default"],
            volumes: [],
          },
        },
        message:
          "Docker context explicit-test-context holds what an earlier Mend install left, and no installation owns it: network mend_default. Setup does not install beside it. To remove it: DOCKER_CONTEXT=explicit-test-context mend uninstall --server, then run mend server setup again.",
      },
    });
    expect(daemon.mutations()).toEqual([]);
    const found = await findServerOldData(daemon, input.dockerContext);
    if (found._tag !== "ok" || found.value?._tag !== "leftovers")
      throw new Error("expected leftovers");
    const lines: Array<string> = [];
    expect(
      await removeServerLeftovers(daemon, found.value.leftovers, (line) => lines.push(line)),
    ).toEqual([]);
    expect(lines).toEqual(["removed network mend_default"]);
    expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({ _tag: "ok" });
  });

  it("counts a generation's stopped containers and the bundle's labelled volumes as leftovers, the volumes as data", async () => {
    const daemon = new DockerDaemon();
    daemon.containers.set("mend-mend-1", generation);
    daemon.networks.set("mend_default", project);
    daemon.volumes.set("mend_mend-postgres", project);
    daemon.volumes.set("mend-control", { [SERVER_VOLUME_OWNER_LABEL]: "an-identity-long-gone" });
    expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
      _tag: "error",
      error: {
        message:
          "Docker context explicit-test-context holds what an earlier Mend install left, and no installation owns them: container mend-mend-1, network mend_default, 2 volumes (mend_mend-postgres, mend-control). The volumes may hold that install's data, and removing them deletes that data. To keep it, put that install's Mend config directory (identity.env and generations) back where it was and run mend server setup: setup takes up the volumes its identity owns. Setup does not install beside them. To remove them: DOCKER_CONTEXT=explicit-test-context mend uninstall --server, then run mend server setup again.",
      },
    });
    expect(daemon.mutations()).toEqual([]);
  });

  it("refuses Mend's own network or container while something runs on it, naming what", async () => {
    const daemon = new DockerDaemon();
    daemon.networks.set("mend_default", project);
    daemon.attached.set("mend_default", ["sealant-w1"]);
    expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
      _tag: "error",
      error: {
        found: { _tag: "in-the-way", inTheWay: [{ kind: "network", mend: true }], leftovers: null },
        message:
          "Docker context explicit-test-context has network mend_default from an earlier Mend install, with no installation to own it, and container sealant-w1 is attached to it. Setup leaves it alone. To see what it is: docker --context explicit-test-context network inspect mend_default. Stop what runs there, then remove what that install left with DOCKER_CONTEXT=explicit-test-context mend uninstall --server, or install in another Docker context: mend server setup --context <name>.",
      },
    });
    const running = new DockerDaemon();
    running.containers.set("mend-mend-1", generation);
    running.running.add("mend-mend-1");
    expect(await claimServerDockerVolumes(running, input)).toMatchObject({
      _tag: "error",
      error: {
        found: { _tag: "in-the-way", inTheWay: [{ name: "mend-mend-1", why: "it is running" }] },
      },
    });
    // A container of the project a generation did not start is not Mend's.
    const other = new DockerDaemon();
    other.containers.set("mend-api-1", project);
    expect(await claimServerDockerVolumes(other, input)).toMatchObject({
      _tag: "error",
      error: {
        found: {
          _tag: "in-the-way",
          inTheWay: [
            {
              mend: false,
              why: "carries Compose project label mend, but no Mend install started it",
            },
          ],
        },
      },
    });
  });

  it.each([
    [null, "carries no labels"],
    [{ "com.docker.compose.project": "other" }, "belongs to Compose project other"],
    [{ "com.example.owner": "someone" }, "carries no Compose project label"],
  ] as const)(
    "names a same-named network that is not Mend's (labels %j) and offers nothing to remove",
    async (labels, why) => {
      const daemon = new DockerDaemon();
      daemon.networks.set("mend_default", labels);
      expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
        _tag: "error",
        error: {
          reason: "unowned-data",
          message: `Docker context explicit-test-context has a network named mend_default that is not Mend's: it ${why}. Setup leaves it alone and cannot install beside it. To see what it is: docker --context explicit-test-context network inspect mend_default. Remove it yourself if nothing needs it, or install in another Docker context: mend server setup --context <name>.`,
        },
      });
      expect(await findServerOldData(daemon, input.dockerContext)).toMatchObject({
        _tag: "ok",
        value: { _tag: "in-the-way" },
      });
      expect([...daemon.networks]).toEqual([["mend_default", labels]]);
    },
  );

  it("names every item in the way, and the leftovers beside them", async () => {
    const daemon = new DockerDaemon();
    daemon.networks.set("mend_default", null);
    daemon.volumes.set("mend_cache", { "com.docker.compose.project": "other" });
    daemon.containers.set("mend-mend-1", generation);
    daemon.running.add("mend-mend-1");
    daemon.volumes.set("mend-control", { [SERVER_VOLUME_OWNER_LABEL]: "an-identity-long-gone" });
    expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
      _tag: "error",
      error: {
        reason: "unowned-data",
        found: {
          _tag: "in-the-way",
          inTheWay: [
            { kind: "volume", name: "mend_cache", mend: false },
            { kind: "container", name: "mend-mend-1", mend: true },
            { kind: "network", name: "mend_default", mend: false },
          ],
          leftovers: { volumes: ["mend-control"] },
        },
        message:
          "Docker context explicit-test-context has 3 things setup cannot install beside: volume mend_cache, not Mend's: it belongs to Compose project other; container mend-mend-1, from an earlier Mend install with no installation to own it: it is running; network mend_default, not Mend's: it carries no labels. Setup leaves them alone. To see what each is: docker --context explicit-test-context volume inspect mend_cache, docker --context explicit-test-context container inspect mend-mend-1, docker --context explicit-test-context network inspect mend_default. Stop what runs on Mend's, then remove what that install left with DOCKER_CONTEXT=explicit-test-context mend uninstall --server. Remove what is not Mend's yourself if nothing needs it, or install in another Docker context: mend server setup --context <name>. Beside them, what an earlier Mend install left: volume mend-control, which DOCKER_CONTEXT=explicit-test-context mend uninstall --server removes.",
      },
    });
    expect(daemon.mutations()).toEqual([]);
  });

  it.each([
    ["mend_cache", { "com.docker.compose.project": "other" }, "belongs to Compose project other"],
    [
      "mend_scratch",
      { "com.docker.compose.project": "mend" },
      "carries Compose project label mend, but no Mend install makes a volume by that name",
    ],
  ] as const)(
    "refuses volume %s (labels %j) as not Mend's and offers nothing to remove",
    async (name, labels, why) => {
      const daemon = new DockerDaemon();
      daemon.volumes.set(name, labels);
      expect(await claimServerDockerVolumes(daemon, input)).toMatchObject({
        _tag: "error",
        error: {
          found: { _tag: "in-the-way", inTheWay: [{ kind: "volume", name, mend: false, why }] },
          message: `Docker context explicit-test-context has a volume named ${name} that is not Mend's: it ${why}. Setup leaves it alone and cannot install beside it. To see what it is: docker --context explicit-test-context volume inspect ${name}. Remove it yourself if nothing needs it, or install in another Docker context: mend server setup --context <name>.`,
        },
      });
      expect(daemon.mutations()).toEqual([]);
      expect([...daemon.volumes]).toEqual([[name, labels]]);
    },
  );

  it("reads nothing in the way once an anchor exists: the claim decides whose it is", async () => {
    const daemon = new DockerDaemon();
    daemon.volumes.set("mend-store", { [SERVER_VOLUME_OWNER_LABEL]: owner });
    daemon.networks.set("mend_default", project);
    expect(await findServerOldData(daemon, input.dockerContext)).toEqual({
      _tag: "ok",
      value: null,
    });
  });
});
