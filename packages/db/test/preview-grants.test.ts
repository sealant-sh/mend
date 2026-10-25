import { createHash, randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { PreviewId } from "@mend/domain";
import { Effect, Exit, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  isPreviewGrantSecret,
  PreviewGrantsRepo,
  PreviewGrantsRepoLive,
} from "../src/repos/preview-grants.ts";
import type { TicketCredential } from "../src/repos/upgrade-tickets.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_preview_grants_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(url.toString()) });
const reposLayer = PreviewGrantsRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, PreviewGrantsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));
let created = false;

const KEPT = PreviewId.make("pv-kept");
const REMOVED = PreviewId.make("pv-removed");
const ORIGIN = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.preview.example";

const signIn = Effect.fn("signIn")(function* (userId: string) {
  const client = yield* SqlClient.SqlClient;
  const id = `sign-in-${randomUUID()}`;
  yield* client`INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
    VALUES (${id}, '2100-01-01T00:00:00Z', ${`token-${id}`}, now(), now(), ${userId})`;
  const credential: TicketCredential = `session:${id}`;
  return { id, credential };
});

const pairDevice = Effect.fn("pairDevice")(function* (userId: string) {
  const client = yield* SqlClient.SqlClient;
  const id = `device-${randomUUID()}`;
  yield* client`INSERT INTO device_tokens (id, user_id, name, platform, token_hash)
    VALUES (${id}, ${userId}, 'phone', 'ios', ${`hash-${id}`})`;
  const credential: TicketCredential = `device:${id}`;
  return { id, credential };
});

const grantFor = (userId: string, credential: TicketCredential, previewId = KEPT) =>
  Effect.flatMap(PreviewGrantsRepo, (grants) =>
    grants.create({ subject: { userId, credential }, previewId, origin: ORIGIN }),
  );

const findAt = (grant: Redacted.Redacted<string>, origin = ORIGIN, previewId = KEPT) =>
  Effect.flatMap(PreviewGrantsRepo, (grants) =>
    grants
      .standing([{ grant, previewId, origin }])
      .pipe(Effect.map(([found]) => found?.subject ?? null)),
  );

describe.skipIf(postgres.skip)("preview grants in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
      }),
    );
    created = true;
    await run(
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        yield* Effect.forEach(
          Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
          ([, migration]) => migration,
          { discard: true },
        );
        yield* client`INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
          ('alice', 'Alice', 'alice@example.com', now()),
          ('carol', 'Carol', 'carol@example.com', now()),
          ('dave', 'Dave', 'dave@example.com', now())`;
        yield* client`INSERT INTO organizations (id, name) VALUES ('org-a', 'A')`;
        yield* client`INSERT INTO organization_members (organization_id, user_id, role)
          VALUES ('org-a', 'alice', 'owner')`;
        yield* client`INSERT INTO projects (id, name, store_path, default_branch, organization_id,
            visibility, created_by_user_id)
          VALUES ('p-1', 'p-1', '/store/p-1', 'main', 'org-a', 'shared', 'alice')`;
        yield* client`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'wt-1', 'wt-1', 'mend/wt-1', 'abc')`;
        yield* client`INSERT INTO previews (id, project_id, worktree_id, service_name, label) VALUES
          (${KEPT}, 'p-1', 'wt-1', 'web', 'aaaaaaaaaaaaaaaaaaaaaaaaaa'),
          (${REMOVED}, 'p-1', NULL, 'docs', 'baaaaaaaaaaaaaaaaaaaaaaaaa')`;
      }),
    );
  });

  afterAll(async () => {
    if (!created) return;
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
        );
      }),
    );
  });

  it("stores only the grant's hash and answers it at its own origin", async () => {
    const found = await run(
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        const { credential } = yield* signIn("alice");
        const grant = yield* grantFor("alice", credential);
        const rows = yield* client<{
          readonly token_hash: string;
          readonly user_id: string;
          readonly credential: string;
          readonly preview_id: string;
          readonly origin: string;
        }>`SELECT token_hash, user_id, credential, preview_id, origin FROM preview_grants
          WHERE credential = ${credential}`;
        return {
          secret: Redacted.value(grant),
          rows,
          own: yield* findAt(grant),
          otherPort: yield* findAt(grant, `${ORIGIN}:8443`),
          otherScheme: yield* findAt(grant, ORIGIN.replace("https:", "http:")),
          otherPreview: yield* findAt(grant, ORIGIN, REMOVED),
          unknown: yield* findAt(Redacted.make(`mpg_${"A".repeat(43)}`)),
          credential,
        };
      }),
    );
    expect(isPreviewGrantSecret(found.secret)).toBe(true);
    expect(found.rows).toEqual([
      {
        token_hash: createHash("sha256").update(found.secret).digest("hex"),
        user_id: "alice",
        credential: found.credential,
        preview_id: KEPT,
        origin: ORIGIN,
      },
    ]);
    expect(JSON.stringify(found.rows)).not.toContain(found.secret);
    expect(found.own).toEqual({ userId: "alice", credential: found.credential });
    expect(found.otherPreview).toBeNull();
    expect(found.otherPort).toBeNull();
    expect(found.otherScheme).toBeNull();
    expect(found.unknown).toBeNull();
  });

  it("reads many grants at once, in order, with what access depends on", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const grants = yield* PreviewGrantsRepo;
        const alice = yield* signIn("alice");
        const carol = yield* signIn("carol");
        const aliceGrant = yield* grantFor("alice", alice.credential);
        const carolGrant = yield* grantFor("carol", carol.credential);
        const removedGrant = yield* grantFor("alice", alice.credential, REMOVED);
        const read = yield* grants.standing([
          { grant: carolGrant, previewId: KEPT, origin: ORIGIN },
          { grant: aliceGrant, previewId: KEPT, origin: ORIGIN },
          { grant: aliceGrant, previewId: KEPT, origin: `${ORIGIN}:8443` },
          { grant: removedGrant, previewId: REMOVED, origin: ORIGIN },
          { grant: aliceGrant, previewId: KEPT, origin: ORIGIN },
        ]);
        return { read, none: yield* grants.standing([]), alice, carol };
      }),
    );
    const project = { organizationId: "org-a", visibility: "shared", createdByUserId: "alice" };
    const alice = {
      subject: { userId: "alice", credential: outcome.alice.credential },
      previewKept: true,
      membership: { organizationId: "org-a", role: "owner" },
      project,
    };
    expect(outcome.read).toEqual([
      {
        subject: { userId: "carol", credential: outcome.carol.credential },
        previewKept: true,
        membership: null,
        project,
      },
      alice,
      null,
      { ...alice, previewKept: false },
      alice,
    ]);
    expect(outcome.none).toEqual([]);
  });

  it("ends with its sign-in, its device and its account, and never on another's", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        const signedOut = yield* signIn("carol");
        const expired = yield* signIn("carol");
        const revoked = yield* pairDevice("carol");
        const kept = yield* pairDevice("carol");
        const grants = {
          signedOut: yield* grantFor("carol", signedOut.credential),
          expired: yield* grantFor("carol", expired.credential),
          revoked: yield* grantFor("carol", revoked.credential),
          kept: yield* grantFor("carol", kept.credential),
        };
        yield* client`DELETE FROM "session" WHERE id = ${signedOut.id}`;
        yield* client`UPDATE "session" SET "expiresAt" = now() - interval '1 second'
          WHERE id = ${expired.id}`;
        yield* client`UPDATE device_tokens SET revoked_at = now() WHERE id = ${revoked.id}`;
        const before = {
          signedOut: yield* findAt(grants.signedOut),
          expired: yield* findAt(grants.expired),
          revoked: yield* findAt(grants.revoked),
          kept: (yield* findAt(grants.kept)) !== null,
        };
        const dave = yield* signIn("dave");
        const daveGrant = yield* grantFor("dave", dave.credential);
        yield* client`UPDATE "user" SET "deactivatedAt" = now() WHERE id = 'dave'`;
        return { before, deactivated: yield* findAt(daveGrant) };
      }),
    );
    expect(outcome.before).toEqual({
      signedOut: null,
      expired: null,
      revoked: null,
      kept: true,
    });
    expect(outcome.deactivated).toBeNull();
  });

  it("refuses a grant whose credential belongs to another account", async () => {
    const found = await run(
      Effect.gen(function* () {
        const carol = yield* signIn("carol");
        const carolDevice = yield* pairDevice("carol");
        return {
          session: yield* findAt(yield* grantFor("alice", carol.credential)),
          device: yield* findAt(yield* grantFor("alice", carolDevice.credential)),
        };
      }),
    );
    expect(found).toEqual({ session: null, device: null });
  });

  it("never stores a grant without a credential or with a malformed one", async () => {
    const exits = await run(
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        const insert = (hash: string, credential: string | null) =>
          Effect.exit(client`INSERT INTO preview_grants (token_hash, preview_id, origin, user_id, credential)
            VALUES (${hash}, ${KEPT}, ${ORIGIN}, 'alice', ${credential})`);
        const hash = createHash("sha256").update(randomUUID()).digest("hex");
        return [
          yield* insert(hash, null),
          yield* insert(hash, "session:"),
          yield* insert(hash, "token:abc"),
          yield* insert("not-a-hash", "session:abc"),
        ];
      }),
    );
    expect(exits.map(Exit.isFailure)).toEqual([true, true, true, true]);
  });

  it("cleans up only dead grants, in batches, and a second pass finds nothing", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        const grants = yield* PreviewGrantsRepo;
        yield* client`DELETE FROM preview_grants`;
        const live = yield* signIn("alice");
        const ended = yield* signIn("alice");
        const device = yield* pairDevice("alice");
        const keep = [
          yield* grantFor("alice", live.credential),
          yield* grantFor("alice", live.credential),
          yield* grantFor("alice", device.credential),
        ];
        yield* grantFor("alice", ended.credential);
        yield* grantFor("alice", ended.credential);
        yield* grantFor("alice", live.credential, REMOVED);
        yield* grantFor("carol", (yield* signIn("carol")).credential);
        yield* client`DELETE FROM "session" WHERE id = ${ended.id}`;
        yield* client`UPDATE "user" SET "deactivatedAt" = now() WHERE id = 'carol'`;
        const removed = yield* grants.cleanup({ batch: 2 });
        const again = yield* grants.cleanup({ batch: 2 });
        const remaining = yield* client<{
          readonly token_hash: string;
        }>`SELECT token_hash FROM preview_grants ORDER BY token_hash`;
        return {
          removed,
          again,
          remaining: remaining.map((row) => row.token_hash),
          kept: keep.map((grant) =>
            createHash("sha256").update(Redacted.value(grant)).digest("hex"),
          ),
        };
      }),
    );
    expect(outcome.removed).toBe(4);
    expect(outcome.again).toBe(0);
    expect(outcome.remaining).toEqual(outcome.kept.toSorted());
  });
});
