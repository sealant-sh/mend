import { CurrentUser } from "@mend/api-contracts";
import { InstanceRolesRepo } from "@mend/db";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { TenancyConfig } from "./tenancy.ts";

/** Whose GitHub identity an API call to GitHub may use, or why there is none. */
export type GithubAuthority =
  | { readonly kind: "host-gh" }
  | { readonly kind: "none"; readonly detail: string };

export const NO_GITHUB_IDENTITY =
  "GitHub API access runs as you. This account has no GitHub token in Mend, and the host's gh login is reserved for the operator on a single-tenant install.";

/**
 * GitHub API identity (docs/adr/0003-organizations-and-tenancy.md). Git over SSH already signs as
 * each account; calls to the GitHub API (repository discovery, pull request lists) have no
 * per-account credential yet. The host's `gh` login belongs to whoever set up the machine, so only
 * the operator of a single-organization install may use it; everyone else is told why there is
 * nothing to show, rather than seeing the host account's view.
 */
export class GithubIdentity extends Context.Service<
  GithubIdentity,
  { readonly forCaller: () => Effect.Effect<GithubAuthority, never, CurrentUser> }
>()("@mend/api/GithubIdentity") {}

export const githubAuthority = (tenancy: "single" | "multi", operator: boolean): GithubAuthority =>
  tenancy === "single" && operator
    ? { kind: "host-gh" }
    : { kind: "none", detail: NO_GITHUB_IDENTITY };

export const GithubIdentityLive: Layer.Layer<
  GithubIdentity,
  never,
  TenancyConfig | InstanceRolesRepo
> = Layer.effect(
  GithubIdentity,
  Effect.gen(function* () {
    const tenancy = yield* TenancyConfig;
    const roles = yield* InstanceRolesRepo;
    const forCaller = Effect.fn("GithubIdentity.forCaller")(function* () {
      const caller = yield* CurrentUser;
      return githubAuthority(tenancy.mode, yield* roles.isOperator(caller.user.id));
    });
    return { forCaller };
  }),
);
