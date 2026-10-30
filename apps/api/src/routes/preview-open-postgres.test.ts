import { createHash, randomBytes } from "node:crypto";

import { DevicesRepo } from "@mend/db";
import { Effect, Schema } from "effect";
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

    it("never prints the URL or its ticket", () => {
      expect(printed.join("\n")).not.toMatch(/mut_[A-Za-z0-9_-]{20}/);
    });
  },
);
