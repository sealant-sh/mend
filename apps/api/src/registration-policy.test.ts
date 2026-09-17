import { RegistrationPolicy } from "@mend/auth";
import {
  InvitationUnknownError,
  OrganizationsRepo,
  UsersRepo,
  type ResolvedInvitation,
} from "@mend/db";
import { InvitationId, OrganizationId } from "@mend/domain";
import {
  Invitation,
  Organization,
  OrganizationMember,
  type InvitationState,
} from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { RegistrationPolicyLive } from "./registration-policy.ts";

const NOW = new Date("2026-09-17T10:00:00.000Z");
const acme = new Organization({
  id: OrganizationId.make("org-acme"),
  name: "Acme",
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const resolved = (state: InvitationState, email: string | null = null): ResolvedInvitation => ({
  organization: acme,
  state,
  invitation: new Invitation({
    id: InvitationId.make("inv-1"),
    organizationId: acme.id,
    role: "member",
    email,
    createdByUserId: "alice",
    createdAt: NOW,
    expiresAt: NOW,
    acceptedByUserId: null,
    acceptedAt: null,
    revokedAt: null,
  }),
});

const policy = (options: {
  readonly users: number;
  readonly invitation?: ResolvedInvitation;
  readonly bootstrapped?: boolean;
  readonly calls?: Array<string>;
}) =>
  RegistrationPolicyLive.pipe(
    Layer.provide(Layer.mock(UsersRepo, { count: () => Effect.succeed(options.users) })),
    Layer.provide(
      Layer.mock(OrganizationsRepo, {
        invitationByToken: () =>
          options.invitation === undefined
            ? Effect.fail(new InvitationUnknownError())
            : Effect.succeed(options.invitation),
        bootstrapFirstAccount: () =>
          Effect.sync(() => {
            options.calls?.push("bootstrap");
            return options.bootstrapped ?? false;
          }),
        acceptInvitation: () =>
          Effect.sync(() => {
            options.calls?.push("accept");
            return {
              organization: acme,
              member: new OrganizationMember({
                organizationId: acme.id,
                userId: "u",
                name: "U",
                email: "u@example.invalid",
                role: "member",
                joinedAt: NOW,
              }),
            };
          }),
      }),
    ),
  );

const decide = (
  layer: Layer.Layer<RegistrationPolicy>,
  email: string,
  invitationToken: string | null,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registration = yield* RegistrationPolicy;
      return yield* registration.decide({ email, invitationToken });
    }).pipe(Effect.provide(layer)),
  );

const complete = (layer: Layer.Layer<RegistrationPolicy>, token: string | null) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registration = yield* RegistrationPolicy;
      yield* registration.registered({ id: "u", email: "u@example.invalid" }, token);
    }).pipe(Effect.provide(layer)),
  );

describe("closed registration policy (docs/adr/0003)", () => {
  it("admits the first account on an unclaimed instance", async () => {
    expect(await decide(policy({ users: 0 }), "first@example.invalid", null)).toEqual({
      kind: "bootstrap",
    });
  });

  it("refuses everyone after that without an invitation", async () => {
    const decision = await decide(policy({ users: 1 }), "second@example.invalid", null);
    expect(decision).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("invitation"),
    });
  });

  it("admits an open invitation and refuses spent, unknown or misaddressed ones", async () => {
    expect(
      await decide(policy({ users: 1, invitation: resolved("open") }), "x@example.invalid", "t"),
    ).toEqual({ kind: "invitation", token: "t" });
    expect(
      await decide(policy({ users: 1, invitation: resolved("revoked") }), "x@example.invalid", "t"),
    ).toMatchObject({ kind: "refused", message: expect.stringContaining("revoked") });
    expect(await decide(policy({ users: 1 }), "x@example.invalid", "t")).toMatchObject({
      kind: "refused",
    });
    expect(
      await decide(
        policy({ users: 1, invitation: resolved("open", "carol@example.invalid") }),
        "Mallory@example.invalid",
        "t",
      ),
    ).toMatchObject({ kind: "refused", message: expect.stringContaining("different email") });
    expect(
      await decide(
        policy({ users: 1, invitation: resolved("open", "carol@example.invalid") }),
        " CAROL@example.invalid ",
        "t",
      ),
    ).toEqual({ kind: "invitation", token: "t" });
  });

  it("completes the first account by bootstrapping, and later ones by spending the invitation", async () => {
    const first: Array<string> = [];
    await complete(policy({ users: 1, bootstrapped: true, calls: first }), "t");
    expect(first).toEqual(["bootstrap"]);
    const later: Array<string> = [];
    await complete(policy({ users: 2, bootstrapped: false, calls: later }), "t");
    expect(later).toEqual(["bootstrap", "accept"]);
  });
});
