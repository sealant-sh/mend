import { createHash, randomBytes } from "node:crypto";

import {
  DevicesRepo,
  PreviewPreparationsRepoLive,
  PreviewsRepo,
  ServiceObservationsRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
} from "@mend/db";
import { WorktreeId } from "@mend/domain";
import { SlackPreviewReads } from "@mend/jobs";
import { Effect, Layer, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  APP,
  atPreview,
  grantIn,
  mend,
  NAVIGATION,
  originOf,
  type Person,
  postgres,
  PREVIEWS,
  type PreviewKey,
  previewTickets,
  printed,
  query,
  runtime,
  setUpPreviewAuth,
  STATIC_TOKEN,
  tearDownPreviewAuth,
  whoami,
} from "../../test/support/preview-auth-fixture.ts";
import { PreviewSetupConfig } from "../preview-config.ts";
import { describeWorktreePreviews, SlackPreviewReadsLive } from "../preview-reads.ts";

const SHARED_WORKTREE = WorktreeId.make("wt-p-shared");
const previewReads = Layer.mergeAll(
  PreviewPreparationsRepoLive,
  ServiceObservationsRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
);
/** What a Slack thread reads of the shared worktree's previews. */
const slackRead = () =>
  runtime.runPromise(
    Effect.flatMap(SlackPreviewReads, (reads) => reads.forWorktree(SHARED_WORKTREE)).pipe(
      Effect.provide(SlackPreviewReadsLive.pipe(Layer.provide(previewReads))),
    ),
  );
/** The web's read: allocating, then the same assembly. */
const webRead = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const views = yield* (yield* PreviewsRepo).ensureForWorktree(SHARED_WORKTREE);
      const { setup } = yield* PreviewSetupConfig;
      return yield* describeWorktreePreviews(SHARED_WORKTREE, views, setup);
    }).pipe(Effect.provide(previewReads)),
  );
const previewRows = () =>
  query((sql) =>
    sql<{ count: number }>`SELECT count(*)::int AS count FROM previews
      WHERE worktree_id = ${SHARED_WORKTREE}`.pipe(Effect.map(([row]) => row?.count)),
  );

const pairPhone = async (person: Person) => {
  const token = `mdt_${randomBytes(24).toString("base64url")}`;
  const device = await runtime.runPromise(
    Effect.flatMap(DevicesRepo, (devices) =>
      devices.create({
        userId: person.userId,
        name: "phone",
        platform: "ios",
        tokenHash: createHash("sha256").update(token).digest("hex"),
      }),
    ),
  );
  return { token, deviceId: device.id };
};

const openOnPhone = (bearer: string | null, key: PreviewKey) =>
  mend(
    new Request(`${APP}/api/previews/${PREVIEWS[key].id}/open`, {
      method: "POST",
      headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    }),
  );

let carol: Person;
let bob: Person;

describe.skipIf(postgres.skip)(
  "opening a preview on a paired phone, against an HTTP fixture",
  () => {
    beforeAll(async () => {
      const { alice, ...others } = await setUpPreviewAuth();
      ({ carol, bob } = others);
      await query((sql) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO agent_sessions (id, project_id, worktree_id, owner_user_id, harness,
          worktree, branch, base_sha, status)
        VALUES ('s-served', 'p-shared', 'wt-p-shared', ${alice.userId}, 'claude', 'p-shared',
          'mend/p-shared', 'abc', 'completed')`;
          yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port,
          browser_scheme)
        VALUES ('svc-served', 's-served', ${`web-${PREVIEWS.served.id}`}, 'explicit-run', 5173,
          'http')`;
          yield* sql`INSERT INTO session_processes (id, session_id, sealant_workspace_id,
            sealant_session_id, kind, status, service_id, attempt_ordinal, argv)
          VALUES ('att-served', 's-served', 'ws-served', 'pty-served', 'service', 'running',
            'svc-served', 1, '["npm", "run", "dev"]'::jsonb)`;
          yield* sql`UPDATE services SET current_attempt_id = 'att-served' WHERE id = 'svc-served'`;
        }),
      );
    }, 120_000);

    afterAll(tearDownPreviewAuth);

    it("opens a preview on a paired phone: its bearer gets a URL, whose ticket signs it in once", async () => {
      const phone = await pairPhone(carol);
      const opened = await openOnPhone(phone.token, "served");
      expect(opened.status).toBe(200);
      const { url } = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
        await opened.json(),
      );
      const target = new URL(url);
      expect(target.origin).toBe(originOf("served"));
      expect(target.pathname).toBe("/__mend/auth");
      expect(target.searchParams.get("path")).toBe("/");
      const first = await atPreview("served", target.pathname + target.search, NAVIGATION);
      expect(first.status).toBe(303);
      const again = await atPreview("served", target.pathname + target.search, NAVIGATION);
      expect(again.status).toBe(401);
      const grant = grantIn(first);
      const seen = await whoami("served", grant);
      expect(seen.status).toBe(200);
      expect(JSON.parse(seen.body)).toMatchObject({
        userId: carol.userId,
        previewId: PREVIEWS.served.id,
      });
      await runtime.runPromise(
        Effect.flatMap(DevicesRepo, (devices) => devices.revoke(carol.userId, phone.deviceId)),
      );
      expect((await whoami("served", grant)).status).toBe(401);
      expect((await openOnPhone(phone.token, "served")).status).toBe(401);
    });

    it("refuses the phone what the web gives no Open, a bearer with no credential, and anyone who cannot see the project", async () => {
      const before = await previewTickets();
      const carols = await pairPhone(carol);
      const unserved = await openOnPhone(carols.token, "shared");
      expect(unserved.status).toBe(409);
      expect(await unserved.json()).toEqual({
        _tag: "PreviewNotOpenable",
        reason: "not-served",
        message: `web-${PREVIEWS.shared.id} · no Service of this name in its worktree · nothing to open`,
      });
      const operator = await openOnPhone(STATIC_TOKEN, "served");
      expect(operator.status).toBe(409);
      expect(await operator.json()).toMatchObject({ reason: "no-credential" });
      const bobs = await pairPhone(bob);
      const outsider = await openOnPhone(bobs.token, "served");
      const missing = await mend(
        new Request(`${APP}/api/previews/pv-unknown/open`, {
          method: "POST",
          headers: { authorization: `Bearer ${bobs.token}` },
        }),
      );
      expect(outsider.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await outsider.json()).toEqual({ _tag: "NotFound", id: PREVIEWS.served.id });
      expect((await openOnPhone(null, "served")).status).toBe(401);
      expect(await previewTickets()).toBe(before);
    });

    it("gives Slack the phone's Open and the web's facts, and allocates no preview however often it reads", async () => {
      await query(
        (sql) =>
          sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port,
          browser_scheme)
        VALUES ('svc-storybook', 's-served', 'storybook', 'explicit-run', 6006, 'http')`,
      );
      const before = await previewRows();
      const reads = [await slackRead(), await slackRead(), await slackRead()];
      expect(await previewRows()).toBe(before);
      const [read] = reads;
      if (read?._tag !== "Shown") throw new Error("the gateway is on in this fixture");
      expect(reads.every((again) => JSON.stringify(again) === JSON.stringify(read))).toBe(true);
      expect(read.appUrl).toBe(APP);
      expect(read.previews.map(({ service }) => service)).not.toContain("storybook");

      const web = await webRead();
      expect(await previewRows()).toBe((before ?? 0) + 1);
      const carols = await pairPhone(carol);
      for (const notice of read.previews) {
        const described = web.previews.find(({ view }) => view.preview.id === notice.id);
        expect(notice.facts).toEqual(described?.facts);
        expect(notice.openable).toBe(described?.open._tag === "Open");
        const key = Object.entries(PREVIEWS).find(([, { id }]) => id === notice.id)?.[0];
        if (key !== "served" && key !== "shared" && key !== "sibling") {
          throw new Error(`unexpected preview ${notice.id}`);
        }
        const opened = await openOnPhone(carols.token, key);
        expect(opened.status).toBe(notice.openable ? 200 : 409);
      }
      expect(read.previews.map(({ id, openable }) => [id, openable])).toEqual([
        [PREVIEWS.served.id, true],
        [PREVIEWS.shared.id, false],
        [PREVIEWS.sibling.id, false],
      ]);
    });

    it("never prints the URL or its ticket", () => {
      expect(printed.join("\n")).not.toMatch(/mut_[A-Za-z0-9_-]{20}/);
    });
  },
);
