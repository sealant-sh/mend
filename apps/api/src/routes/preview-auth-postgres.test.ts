import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";

import { PgClient } from "@effect/sql-pg";
import {
  DevicesRepo,
  MemberRevocationsRepo,
  notifyEvent,
  previewTicketScope,
  ProjectsRepo,
  type TicketCredential,
  UpgradeTicketsRepo,
  UserEvents,
} from "@mend/db";
import { ProjectId } from "@mend/domain";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  APP,
  appGet,
  atPreview,
  exchangeAt,
  grantCount,
  grantIn,
  hostOf,
  label,
  locationOf,
  mintTicket,
  NAVIGATION,
  openStream,
  ORG_A,
  originOf,
  type People,
  type Person,
  postgres,
  previewListenerPort,
  PREVIEWS,
  type PreviewKey,
  previewTickets,
  printed,
  query,
  runtime,
  setUpPreviewAuth,
  signIn,
  signInToPreview,
  signOut,
  STATIC_TOKEN,
  statements,
  tearDownPreviewAuth,
  whoami,
  within,
} from "../../test/support/preview-auth-fixture.ts";

const previewAuthAs = (person: Person | null, key: PreviewKey) =>
  appGet(
    `/api/preview-auth?preview=${PREVIEWS[key].id}&path=%2F`,
    person === null ? {} : { cookie: person.cookie },
  );

let alice: Person;
let carol: Person;
let bob: Person;
let dave: Person;

describe.skipIf(postgres.skip)("signing in to a preview, against an HTTP fixture", () => {
  beforeAll(async () => {
    const people: People = await setUpPreviewAuth();
    ({ alice, carol, bob, dave } = people);
  }, 120_000);

  afterAll(tearDownPreviewAuth);

  it("signs a person in end to end: a cookie GET, a ticket, an exchange, a grant per request", async () => {
    const issued = await appGet(
      `/api/preview-auth?preview=${PREVIEWS.shared.id}&path=${encodeURIComponent("/pricing?tab=2")}`,
      { cookie: carol.cookie },
    );
    expect(issued.status).toBe(302);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(issued.headers.get("referrer-policy")).toBe("no-referrer");
    const location = new URL(issued.headers.get("location") ?? "");
    expect(location.origin).toBe(originOf("shared"));
    expect(location.pathname).toBe("/__mend/auth");
    expect(location.searchParams.get("path")).toBe("/pricing?tab=2");

    const exchanged = await atPreview("shared", location.pathname + location.search, NAVIGATION);
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers["location"]).toBe(
      `/__mend/signed-in?path=${encodeURIComponent("/pricing?tab=2")}`,
    );
    expect(exchanged.headers["referrer-policy"]).toBe("no-referrer");
    expect(exchanged.headers["cache-control"]).toBe("no-store");
    const [cookie] = exchanged.headers["set-cookie"] ?? [];
    const grant = grantIn(exchanged);
    expect(cookie).toBe(`__Host-mend-preview=${grant}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    const landed = await atPreview("shared", locationOf(exchanged), {
      ...NAVIGATION,
      cookie: `__Host-mend-preview=${grant}`,
    });
    expect(landed.status).toBe(303);
    expect(landed.headers["location"]).toBe("/pricing?tab=2");

    const me = await whoami("shared", grant);
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toEqual({
      userId: carol.userId,
      previewId: PREVIEWS.shared.id,
      origin: originOf("shared"),
    });
    const rows = await query(
      (sql) =>
        sql<{ readonly tokenHash: string; readonly userId: string; readonly credential: string }>`
        SELECT token_hash, user_id, credential FROM preview_grants
        WHERE token_hash = ${createHash("sha256").update(grant).digest("hex")}`,
    );
    expect(rows).toEqual([
      {
        tokenHash: createHash("sha256").update(grant).digest("hex"),
        userId: carol.userId,
        credential: `session:${carol.signInId}`,
      },
    ]);
  });

  it("opens for anyone who can see the project, and for no one else", async () => {
    const before = await previewTickets();
    expect((await previewAuthAs(bob, "shared")).status).toBe(404);
    expect((await previewAuthAs(alice, "carolsPrivate")).status).toBe(404);
    expect(
      (await appGet(`/api/preview-auth?preview=pv-unknown&path=%2F`, { cookie: carol.cookie }))
        .status,
    ).toBe(404);
    const signedOut = await previewAuthAs(null, "shared");
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent(`/preview-auth?preview=${PREVIEWS.shared.id}&path=%2F`)}`,
    );
    const bearer = await appGet(`/api/preview-auth?preview=${PREVIEWS.shared.id}&path=%2F`, {
      authorization: `Bearer ${STATIC_TOKEN}`,
    });
    expect(bearer.status).toBe(302);
    expect(bearer.headers.get("location")).toMatch(/^\/login\?next=/);
    expect(await previewTickets()).toBe(before);
    expect((await previewAuthAs(carol, "carolsPrivate")).status).toBe(302);
  });

  it("spends one ticket once, however many requests race for it", async () => {
    const ticket = await mintTicket({
      userId: carol.userId,
      credential: `session:${carol.signInId}`,
      key: "shared",
    });
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => exchangeAt("shared", ticket)),
    );
    expect(replies.map((reply) => reply.status).toSorted()).toEqual([
      303, 401, 401, 401, 401, 401, 401, 401,
    ]);
    const winner = replies.find((reply) => reply.status === 303);
    if (winner === undefined) throw new Error("no exchange won");
    const replay = await atPreview("shared", `/__mend/auth?ticket=${ticket}&path=%2F`, {
      ...NAVIGATION,
      cookie: `__Host-mend-preview=${grantIn(winner)}`,
    });
    expect(replay.status).toBe(401);
    expect(replay.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a ticket at another host or for another target, without spending it", async () => {
    const credential: TicketCredential = `session:${carol.signInId}`;
    const ticket = await mintTicket({ userId: carol.userId, credential, key: "shared" });
    const sibling = await exchangeAt("sibling", ticket);
    expect(sibling.status).toBe(401);
    const forged = await atPreview("sibling", `/__mend/auth?ticket=${ticket}&path=%2F`, {
      ...NAVIGATION,
      "x-forwarded-host": hostOf("shared"),
      forwarded: `host=${hostOf("shared")}`,
    });
    expect(forged.status).toBe(401);
    for (const host of [
      `${PREVIEWS.shared.label}.preview.test:8443`,
      `x.${PREVIEWS.shared.label}.preview.test`,
      `${PREVIEWS.shared.label}.preview.test.evil`,
      `${label("z")}.preview.test`,
    ]) {
      expect((await exchangeAt({ host }, ticket)).status, host).toBe(404);
    }
    const tty = await mintTicket({
      userId: carol.userId,
      credential,
      key: "shared",
      target: "tty",
    });
    expect((await exchangeAt("shared", tty)).status).toBe(401);
    expect(
      await runtime.runPromise(
        Effect.flatMap(UpgradeTicketsRepo, (tickets) =>
          tickets.consume({
            ticket: tty,
            target: "tty",
            scope: previewTicketScope({
              previewId: PREVIEWS.shared.id,
              origin: originOf("shared"),
            }),
          }),
        ),
      ),
    ).not.toBeNull();
    expect((await exchangeAt("shared", ticket)).status).toBe(303);
  });

  it("refuses a repeated or unknown parameter before anything is spent", async () => {
    const before = await previewTickets();
    for (const search of [
      `preview=${PREVIEWS.shared.id}&preview=${PREVIEWS.shared.id}`,
      `preview=${PREVIEWS.shared.id}&pr%65view=${PREVIEWS.sibling.id}`,
      `preview=${PREVIEWS.shared.id}&path=%2F&path=%2Fx`,
      `preview=${PREVIEWS.shared.id}&origin=${encodeURIComponent("https://evil.example")}`,
      `preview=${PREVIEWS.shared.id}&path=${encodeURIComponent("//evil.example/")}`,
      "path=%2F",
    ]) {
      expect(
        (await appGet(`/api/preview-auth?${search}`, { cookie: carol.cookie })).status,
        search,
      ).toBe(400);
    }
    expect(await previewTickets()).toBe(before);
    const ticket = await mintTicket({
      userId: carol.userId,
      credential: `session:${carol.signInId}`,
      key: "shared",
    });
    for (const search of [
      `ticket=${ticket}&ticket=${ticket}`,
      `ticket=${ticket}&tick%65t=${ticket}`,
      `path=%2F&ticket=${ticket}&path=%2Fother`,
      `ticket=${ticket}&path=${encodeURIComponent("https://evil.example/")}`,
      `ticket=${ticket}&path=${encodeURIComponent("/__mend/auth")}`,
      `ticket=${ticket}&preview=${PREVIEWS.sibling.id}`,
    ]) {
      expect((await atPreview("shared", `/__mend/auth?${search}`, NAVIGATION)).status, search).toBe(
        400,
      );
    }
    expect(
      (await atPreview("shared", `/__mend/auth?ticket=${ticket}`, NAVIGATION, "POST")).status,
    ).toBe(403);
    expect(
      (
        await atPreview(
          "shared",
          `/__mend/auth?ticket=${ticket}`,
          { origin: originOf("shared"), "sec-fetch-site": "same-origin" },
          "POST",
        )
      ).status,
    ).toBe(405);
    const exchanged = await exchangeAt("shared", ticket);
    expect(exchanged.status).toBe(303);
    const grant = grantIn(exchanged);
    const twice = await atPreview("shared", "/whoami", {
      cookie: [`__Host-mend-preview=${grant}`, `__Host-mend-preview=${grant}`],
    });
    expect(twice.status).toBe(400);
    const twoHosts = await new Promise<string>((resolve, reject) => {
      const socket = connect(previewListenerPort(), "127.0.0.1", () =>
        socket.write(
          `GET /whoami HTTP/1.1\r\nHost: ${hostOf("shared")}\r\nHost: ${hostOf("sibling")}\r\n` +
            `Cookie: __Host-mend-preview=${grant}\r\nConnection: close\r\n\r\n`,
        ),
      );
      let answer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (answer += chunk));
      socket.on("end", () => resolve(answer));
      socket.on("error", reject);
    });
    expect(twoHosts).toMatch(/^HTTP\/1\.1 400 /);
  });

  it("refuses a ticket minted without a credential, and a grant whose credential is another's", async () => {
    const devToken = await mintTicket({ userId: alice.userId, credential: null, key: "shared" });
    expect((await exchangeAt("shared", devToken)).status).toBe(401);
    expect((await exchangeAt("shared", devToken)).status).toBe(401);
    const forged = `mpg_${randomBytes(32).toString("base64url")}`;
    await query(
      (sql) =>
        sql`INSERT INTO preview_grants (token_hash, preview_id, origin, user_id, credential)
        VALUES (${createHash("sha256").update(forged).digest("hex")}, ${PREVIEWS.shared.id},
          ${originOf("shared")}, ${alice.userId}, ${`session:${carol.signInId}`})`,
    );
    expect((await whoami("shared", forged)).status).toBe(401);
    const rows = await query(
      (sql) =>
        sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM preview_grants
        WHERE user_id = ${alice.userId} AND credential NOT LIKE 'session:%' AND credential NOT LIKE 'device:%'`,
    );
    expect(rows[0]?.count).toBe(0);
  });

  it("asks a navigation without a grant to sign in, and refuses every other request", async () => {
    const page = await atPreview("shared", "/pricing?tab=2", NAVIGATION);
    expect(page.status).toBe(302);
    expect(page.headers["location"]).toBe(
      `${APP}/preview-auth?preview=${PREVIEWS.shared.id}&path=${encodeURIComponent("/pricing?tab=2")}`,
    );
    const fetched = await atPreview("shared", "/api/data", {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    });
    expect(fetched.status).toBe(401);
    expect(fetched.headers["location"]).toBeUndefined();
    const { grant } = await signInToPreview(carol, "shared");
    expect((await whoami("shared", grant, { origin: originOf("sibling") })).status).toBe(403);
    expect(
      (await atPreview("shared", "/whoami", { cookie: `__Host-mend-preview=${grant}` }, "POST"))
        .status,
    ).toBe(403);
    expect((await whoami("sibling", grant)).status).toBe(401);
  });

  it("signing out ends the grant for new requests and closes its open stream", async () => {
    const session = await signIn("carol@example.com");
    const { grant } = await signInToPreview(session, "shared");
    const stream = await openStream("shared", grant);
    const signedOut = await signOut(session);
    expect(signedOut.status).toBe(200);
    expect((await whoami("shared", grant)).status).toBe(401);
    expect((await whoami("shared", grant, NAVIGATION)).status).toBe(302);
    await within(stream.ended, 3_000, "the stream ends after signing out");
  });

  it("a sign-out Better Auth failed to delete is completed, or reported as failed", async () => {
    const once = await signIn("carol@example.com");
    const { grant } = await signInToPreview(once, "shared");
    const stream = await openStream("shared", grant);
    await query((sql) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS sign_out_attempts`);
        yield* sql.unsafe(`CREATE OR REPLACE FUNCTION fail_first_sign_out() RETURNS trigger AS $$
          BEGIN
            IF nextval('sign_out_attempts') = 1 THEN RAISE EXCEPTION 'injected delete failure'; END IF;
            RETURN OLD;
          END $$ LANGUAGE plpgsql`);
        yield* sql.unsafe(`CREATE TRIGGER fail_first_sign_out BEFORE DELETE ON "session"
          FOR EACH ROW WHEN (OLD.id = '${once.signInId}') EXECUTE FUNCTION fail_first_sign_out()`);
      }),
    );
    const completed = await signOut(once);
    expect(completed.status).toBe(200);
    expect(await query((sql) => sql`SELECT id FROM "session" WHERE id = ${once.signInId}`)).toEqual(
      [],
    );
    expect((await whoami("shared", grant)).status).toBe(401);
    await within(stream.ended, 3_000, "the stream ends after a completed sign-out");

    const stuck = await signIn("carol@example.com");
    const kept = await signInToPreview(stuck, "shared");
    await query((sql) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`CREATE OR REPLACE FUNCTION fail_every_sign_out() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'injected delete failure'; END $$ LANGUAGE plpgsql`);
        yield* sql.unsafe(`CREATE TRIGGER fail_every_sign_out BEFORE DELETE ON "session"
          FOR EACH ROW WHEN (OLD.id = '${stuck.signInId}') EXECUTE FUNCTION fail_every_sign_out()`);
      }),
    );
    const failed = await signOut(stuck);
    expect(failed.status).toBe(503);
    expect(failed.headers.getSetCookie()).toEqual([]);
    expect((await whoami("shared", kept.grant)).status).toBe(200);
    await query((sql) => sql.unsafe(`DROP TRIGGER fail_every_sign_out ON "session"`));
    expect((await signOut(stuck)).status).toBe(200);
    expect((await whoami("shared", kept.grant)).status).toBe(401);

    const suppressed = await signIn("carol@example.com");
    const held = await signInToPreview(suppressed, "shared");
    const heldStream = await openStream("shared", held.grant);
    await query((sql) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`CREATE OR REPLACE FUNCTION suppress_sign_out() RETURNS trigger AS $$
          BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`);
        yield* sql.unsafe(`CREATE TRIGGER suppress_sign_out BEFORE DELETE ON "session"
          FOR EACH ROW WHEN (OLD.id = '${suppressed.signInId}') EXECUTE FUNCTION suppress_sign_out()`);
      }),
    );
    const notDeleted = await signOut(suppressed);
    expect(notDeleted.status).toBe(503);
    expect(notDeleted.headers.getSetCookie()).toEqual([]);
    expect((await whoami("shared", held.grant)).status).toBe(200);
    await query((sql) => sql.unsafe(`DROP TRIGGER suppress_sign_out ON "session"`));
    expect((await signOut(suppressed)).status).toBe(200);
    expect((await whoami("shared", held.grant)).status).toBe(401);
    await within(heldStream.ended, 3_000, "the stream ends once the sign-out completes");
  });

  it("revoking a device ends that device's grant and stream, and leaves the sign-in's", async () => {
    const token = `mdt_${randomBytes(24).toString("base64url")}`;
    const device = await runtime.runPromise(
      Effect.flatMap(DevicesRepo, (devices) =>
        devices.create({
          userId: carol.userId,
          name: "phone",
          platform: "ios",
          tokenHash: createHash("sha256").update(token).digest("hex"),
        }),
      ),
    );
    const ticket = await mintTicket({
      userId: carol.userId,
      credential: `device:${device.id}`,
      key: "shared",
    });
    const phoneGrant = grantIn(await exchangeAt("shared", ticket));
    const laptop = await signIn("carol@example.com");
    const laptopGrant = (await signInToPreview(laptop, "shared")).grant;
    const phoneStream = await openStream("shared", phoneGrant);
    const laptopStream = await openStream("shared", laptopGrant);
    await runtime.runPromise(
      Effect.flatMap(DevicesRepo, (devices) => devices.revoke(carol.userId, device.id)),
    );
    await within(phoneStream.ended, 3_000, "the device's stream ends");
    expect((await whoami("shared", phoneGrant)).status).toBe(401);
    expect((await whoami("shared", laptopGrant)).status).toBe(200);
    expect(laptopStream.isOpen()).toBe(true);
    laptopStream.close();
  });

  it("removal from the organization ends every grant and stream of the person", async () => {
    const { grant } = await signInToPreview(dave, "shared");
    const stream = await openStream("shared", grant);
    await runtime.runPromise(
      Effect.gen(function* () {
        const removals = yield* MemberRevocationsRepo;
        yield* removals.beginRemoval({
          organizationId: ORG_A,
          userId: dave.userId,
          actorUserId: alice.userId,
          revocationLeaseMs: 60_000,
        });
        yield* (yield* UserEvents).changed(dave.userId, "access");
      }),
    );
    await within(stream.ended, 3_000, "the removed member's stream ends");
    expect((await whoami("shared", grant)).status).toBe(401);
  });

  it("losing the membership alone ends access, though the sign-in still stands", async () => {
    const { grant } = await signInToPreview(carol, "visibility");
    const stream = await openStream("visibility", grant);
    await query((sql) => sql`DELETE FROM organization_members WHERE user_id = ${carol.userId}`);
    expect((await whoami("visibility", grant)).status).toBe(401);
    await within(stream.ended, 3_000, "the stream ends at the sweep");
    await query(
      (sql) =>
        sql`INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org-a', ${carol.userId}, 'member')`,
    );
    expect((await whoami("visibility", grant)).status).toBe(200);
  });

  it("a project made private ends the streams of those who lost it, and its creator keeps it", async () => {
    const creator = (await signInToPreview(alice, "visibility")).grant;
    const teammate = (await signInToPreview(carol, "visibility")).grant;
    const creatorStream = await openStream("visibility", creator);
    const teammateStream = await openStream("visibility", teammate);
    await runtime.runPromise(
      Effect.flatMap(ProjectsRepo, (projects) =>
        projects.setVisibility(ProjectId.make("p-vis"), "private"),
      ),
    );
    await within(teammateStream.ended, 3_000, "the teammate's stream ends");
    expect((await whoami("visibility", teammate)).status).toBe(404);
    expect((await whoami("visibility", teammate, NAVIGATION)).status).toBe(404);
    expect((await whoami("visibility", creator)).status).toBe(200);
    expect(creatorStream.isOpen()).toBe(true);
    const stalled = await openStream("visibility", creator, "/stall");
    await query(
      (sql) => sql`UPDATE previews SET worktree_id = NULL WHERE id = ${PREVIEWS.visibility.id}`,
    );
    await runtime.runPromise(
      Effect.flatMap(PgClient.PgClient, (client) =>
        notifyEvent(client, { type: "worktree", worktreeId: "wt-p-vis", projectId: "p-vis" }),
      ),
    );
    await within(
      Promise.all([creatorStream.ended, stalled.ended]),
      3_000,
      "the removed preview's streams end",
    );
    expect((await whoami("visibility", creator)).status).toBe(404);
  });

  it("a browser that does not keep the grant cookie is told so after one round", async () => {
    const tickets = await previewTickets();
    const grants = await grantCount();
    const page = await atPreview("shared", "/pricing", NAVIGATION);
    expect(page.status).toBe(302);
    const signInAt = new URL(locationOf(page));
    expect(signInAt.pathname).toBe("/preview-auth");
    const issued = await appGet(`/api/preview-auth${signInAt.search}`, { cookie: carol.cookie });
    expect(issued.status).toBe(302);
    const ticketAt = new URL(issued.headers.get("location") ?? "");
    const exchanged = await atPreview("shared", ticketAt.pathname + ticketAt.search, NAVIGATION);
    expect(exchanged.status).toBe(303);
    const dropped = await atPreview("shared", locationOf(exchanged), NAVIGATION);
    expect(dropped.status).toBe(400);
    expect(dropped.headers["location"]).toBeUndefined();
    expect(dropped.body).toMatch(/did not keep the preview's sign-in cookie/);
    expect(await previewTickets()).toBe(tickets);
    expect(await grantCount()).toBe(grants + 1);
  });

  it("never lets an encoded /__mend path reach the app", async () => {
    const { grant } = await signInToPreview(carol, "shared");
    expect((await whoami("shared", grant)).status).toBe(200);
    for (const target of ["/%5F%5Fmend/auth", "/%5f_mend/whoami", "/__m%65nd/x", "/%E0%A4%A"]) {
      const reply = await within(
        atPreview("shared", target, { cookie: `__Host-mend-preview=${grant}` }),
        2_000,
        `an answer for ${target}`,
      );
      expect(reply.status, target).toBe(404);
    }
  });

  it("admits a request with two statements: the preview row and the grant", async () => {
    const { grant } = await signInToPreview(carol, "shared");
    statements.length = 0;
    expect((await whoami("shared", grant)).status).toBe(200);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/from "previews"/i);
    expect(statements[1]).toMatch(/from "preview_grants"/i);
  });

  it("never prints a ticket or a grant", () => {
    const output = printed.join("\n");
    expect(output).not.toMatch(/mut_[A-Za-z0-9_-]{20}/);
    expect(output).not.toMatch(/mpg_[A-Za-z0-9_-]{20}/);
  });
});
