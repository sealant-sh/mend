import { Auth } from "@mend/auth";
import { PreviewId } from "@mend/domain";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { PreviewIdentity, PreviewPoolFull } from "../preview-identity.ts";
import { answerPreviewAuth } from "./preview-auth.ts";

const signedIn = Layer.mock(Auth, {
  getSession: () =>
    Effect.succeed(
      Option.some({
        user: { id: "carol", email: "carol@example.com", name: "Carol" },
        expiresAt: new Date("2026-11-01T00:00:00Z"),
        credential: "session:carol-1",
      }),
    ),
});

describe("opening a preview through Mend", () => {
  it.each([
    {
      name: "ordinary ports can expire",
      nextFreeAt: new Date("2026-10-30T14:04:30.200Z"),
      expected:
        "The next one frees at 2026-10-30 14:05 UTC at the earliest, if its preview stays closed until then.",
    },
    {
      name: "all ports are fixed reservations",
      nextFreeAt: null,
      expected: "All 16 ports are reserved for fixed project previews.",
    },
  ])("names the pool's size and availability when $name", async ({ nextFreeAt, expected }) => {
    const identity = Layer.mock(PreviewIdentity, {
      issueTicket: () => Effect.fail(new PreviewPoolFull({ size: 16, nextFreeAt })),
    });
    const reply = await Effect.runPromise(
      answerPreviewAuth({
        method: "GET",
        target: `/api/preview-auth?preview=${PreviewId.make("pv-1")}&path=%2F`,
        cookie: "__Host-better-auth.session_token=s",
      }).pipe(Effect.provide(Layer.merge(signedIn, identity))),
    );
    expect(reply.status).toBe(503);
    expect(reply.body).toContain("No preview port is free. All 16 ports");
    expect(reply.body).toContain(expected);
    if (nextFreeAt === null) expect(reply.body).not.toContain("frees at");
    else expect(reply.body).toContain("Fixed project preview ports stay reserved.");
    expect(reply.headers["cache-control"]).toBe("no-store");
  });
});
