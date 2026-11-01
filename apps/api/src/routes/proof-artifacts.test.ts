import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PgClient } from "@effect/sql-pg";
import {
  AuthMiddleware,
  CurrentUser,
  ProofArtifactView,
  proofArtifactsGroup,
} from "@mend/api-contracts";
import {
  InstanceRolesRepoLive,
  MendDBLive,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  ServicesRepoLive,
  ProofArtifactsRepo,
  ProofArtifactsRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import {
  ChangeId,
  ProjectId,
  ProofArtifactId,
  ScreenId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { ProofArtifact, proofBlobKey } from "@mend/domain/workbench";
import { BlobStore, BlobStoreFsLive } from "@mend/store";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectAccessLive } from "../access.ts";
import { ProofArtifactsGroupLive } from "./proof-artifacts.ts";

const postgres = postgresTestConfig();
const database = `mend_proof_http_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const db = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.toString()) })),
);
const repos = Layer.mergeAll(
  InstanceRolesRepoLive,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  ServicesRepoLive,
  ProofArtifactsRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
).pipe(Layer.provideMerge(db));
const root = await mkdtemp(join(tmpdir(), "mend-proof-http-"));
const services = Layer.mergeAll(
  ProjectAccessLive.pipe(Layer.provideMerge(repos)),
  BlobStoreFsLive(root),
);
const runtime = ManagedRuntime.make(services);
const auth = Layer.succeed(AuthMiddleware, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = request.headers["authorization"]?.slice("Bearer ".length) ?? "outsider";
    return yield* Effect.provideService(httpEffect, CurrentUser, {
      user: { id, name: id, email: `${id}@test.invalid` },
      expiresAt: new Date(Date.now() + 60_000),
      credential: `device:${id}`,
    });
  }),
);
const app = HttpApiBuilder.layer(HttpApi.make("mend").add(proofArtifactsGroup).prefix("/api")).pipe(
  Layer.provide(ProofArtifactsGroupLive),
  Layer.provide(auth),
  Layer.provide(services),
  Layer.provide(HttpServer.layerServices),
);
const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
const request = async (path: string, account = "proof-reader", method = "GET", range?: string) =>
  handler(
    new Request(`http://mend.test/api${path}`, {
      method,
      headers: { authorization: `Bearer ${account}`, ...(range === undefined ? {} : { range }) },
    }),
    await runtime.runPromise(Effect.context<Layer.Success<typeof services>>()),
  );
const CHANGE = ChangeId.make("proof-http-change");
const ID = ProofArtifactId.make("proof-http-image");
const key = proofBlobKey(CHANGE, ID, "image/png");
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
let created = false;

describe.skipIf(postgres.skip)("proof artifact reads", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)).pipe(
        Effect.provide(admin),
        Effect.scoped,
      ),
    );
    created = true;
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        for (const id of ["proof-owner", "proof-reader", "outsider"])
          yield* sql`INSERT INTO "user" (id,name,email,"createdAt") VALUES (${id},${id},${`${id}@test.invalid`},NOW())`;
        yield* sql`INSERT INTO organization_members (organization_id,user_id,role) SELECT id,'proof-owner','owner' FROM organizations LIMIT 1`;
        yield* sql`INSERT INTO organization_members (organization_id,user_id,role) SELECT id,'proof-reader','member' FROM organizations LIMIT 1`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id,visibility) VALUES ('proof-http-project','Proof','/store/proof.git','main',(SELECT id FROM organizations LIMIT 1),'proof-owner','shared')`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES ('proof-http-worktree','proof-http-project','Proof','proof','mend/proof','abc')`;
        yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status) VALUES ('proof-http-session','proof-http-project','proof-http-worktree','proof-owner','claude','proof','mend/proof','abc','completed')`;
        yield* sql`INSERT INTO worktree_changes (id,project_id,worktree_id,branch,base_sha) VALUES (${CHANGE},'proof-http-project','proof-http-worktree','mend/proof','abc')`;
        yield* (yield* BlobStore).put(key, bytes);
        yield* (yield* ProofArtifactsRepo).insert(
          new ProofArtifact({
            id: ID,
            changeId: CHANGE,
            worktreeId: WorktreeId.make("proof-http-worktree"),
            projectId: ProjectId.make("proof-http-project"),
            sessionId: SessionId.make("proof-http-session"),
            turnId: null,
            title: "Task board",
            caption: "Before completion",
            side: "before",
            source: { _tag: "Base", commit: Sha.make("abcdef123") },
            capture: {
              _tag: "Screenshot",
              moment: { screenId: ScreenId.make("screen"), seq: 3 },
              media: { blobKey: key, mimeType: "image/png", bytes: bytes.length, sha256: "digest" },
            },
            launch: null,
            differences: null,
            observedFrom: new Date("2026-11-01T14:02:00Z"),
            observedTo: null,
            createdAt: new Date(),
          }),
          "capture",
        );
      }),
    );
  });
  afterAll(async () => {
    await dispose();
    await runtime.dispose();
    if (created)
      await Effect.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`),
        ).pipe(Effect.provide(admin), Effect.scoped),
      );
    await readdir(root);
    await rm(root, { recursive: true });
  });

  it("returns UTC labels and stable media paths", async () => {
    const response = await request(`/proof-artifacts/${ID}`);
    expect(response.status).toBe(200);
    const view = Schema.decodeUnknownSync(ProofArtifactView)(await response.json());
    expect(view.label).toBe("Task board · before · base abcdef1 · observed 14:02 UTC");
    expect(view.mediaPath).toBe(`/api/proof-artifacts/${ID}/media`);
    const list = await request(`/changes/${CHANGE}/proof-artifacts`);
    expect(await list.json()).toEqual([Schema.encodeSync(ProofArtifactView)(view)]);
  });
  it("serves PNG bytes and HEAD metadata with private headers", async () => {
    const response = await request(`/proof-artifacts/${ID}/media`);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const head = await request(`/proof-artifacts/${ID}/media`, "proof-reader", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("8");
    expect(await head.text()).toBe("");
  });
  it.each([
    ["bytes=1-3", [80, 78, 71], "bytes 1-3/8"],
    ["bytes=-2", [26, 10], "bytes 6-7/8"],
    ["bytes=6-99", [26, 10], "bytes 6-7/8"],
  ])("serves %s", async (range, expected, contentRange) => {
    const response = await request(
      `/proof-artifacts/${ID}/media`,
      "proof-reader",
      "GET",
      String(range),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(expected);
  });
  it("answers an unsatisfiable range with 416", async () => {
    const response = await request(
      `/proof-artifacts/${ID}/media`,
      "proof-reader",
      "GET",
      "bytes=8-",
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */8");
  });
  it("refuses every read after a reader loses current project visibility", async () => {
    await runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE projects SET visibility = 'private' WHERE id = 'proof-http-project'`,
      ),
    );
    for (const [path, method] of [
      [`/proof-artifacts/${ID}`, "GET"],
      [`/proof-artifacts/${ID}/media`, "GET"],
      [`/proof-artifacts/${ID}/media`, "HEAD"],
      [`/changes/${CHANGE}/proof-artifacts`, "GET"],
    ]) {
      expect((await request(path ?? "", "proof-reader", method)).status).toBe(404);
    }
    expect((await request(`/proof-artifacts/${ID}/media`, "proof-owner")).status).toBe(200);
    expect((await request(`/proof-artifacts/${ID}`, "outsider")).status).toBe(404);
  });
});
