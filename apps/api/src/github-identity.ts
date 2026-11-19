import { type ConnectedAccount, CurrentUser } from "@mend/api-contracts";
import { InstanceRolesRepo } from "@mend/db";
import { SealantClients } from "@mend/sealant";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { TenancyConfig } from "./tenancy.ts";

/** Whose GitHub identity an API call to GitHub may use, or why there is none. */
export type GithubAuthority =
  /**
   * The caller's own GitHub login, connected with `mend connect github`; `login` names it.
   * `hostGh` says whether the host rule below would also let them use the host's `gh`, for the
   * reads that only know how to ask the host.
   */
  | { readonly kind: "caller"; readonly login: string | null; readonly hostGh: boolean }
  | { readonly kind: "host-gh" }
  | { readonly kind: "none"; readonly detail: string };

/** Why a read that only asks the host's `gh` shows nothing to someone the host rule leaves out. */
export const HOST_GH_RESERVED =
  "This list reads the host's gh login, which only the operator of a single-tenant install may use.";

export const NO_GITHUB_IDENTITY =
  "GitHub API access runs as you. Connect your GitHub login with mend connect github on a computer where gh is signed in.";

/**
 * GitHub API identity (docs/adr/0003-organizations-and-tenancy.md). Git over SSH already signs as
 * each account. Calls to the GitHub API (repository discovery) run as the caller's own connected
 * GitHub login when they have one: `gh` runs in a workspace of theirs that carries it, and Mend
 * never reads the token. Without one, the host's `gh` login belongs to whoever set up the
 * machine, so only the operator of a single-organization install may use it; everyone else is
 * told why there is nothing to show, rather than seeing the host account's view.
 */
export class GithubIdentity extends Context.Service<
  GithubIdentity,
  { readonly forCaller: () => Effect.Effect<GithubAuthority, never, CurrentUser> }
>()("@mend/api/GithubIdentity") {}

/** The login a connected GitHub account names: gh's account name, as the platform records it. */
const loginOf = (account: ConnectedAccount): string | null => {
  const login = account.metadata["login"];
  if (typeof login === "string" && login !== "") return login;
  return account.name === "" || account.name === "default" ? null : account.name;
};

/**
 * Whose GitHub the caller's calls use: their own working GitHub login first (the one they chose,
 * when they hold several), then the host's `gh` for the operator of a single-organization install.
 */
export const githubAuthority = (
  tenancy: "single" | "multi",
  operator: boolean,
  accounts: ReadonlyArray<ConnectedAccount>,
): GithubAuthority => {
  const working = accounts
    .filter((account) => account.provider === "github" && account.status === "active")
    .toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const [own] = working;
  const hostGh = tenancy === "single" && operator;
  if (own !== undefined) return { kind: "caller", login: loginOf(own), hostGh };
  return hostGh ? { kind: "host-gh" } : { kind: "none", detail: NO_GITHUB_IDENTITY };
};

export const GithubIdentityLive: Layer.Layer<
  GithubIdentity,
  never,
  TenancyConfig | InstanceRolesRepo | SealantClients
> = Layer.effect(
  GithubIdentity,
  Effect.gen(function* () {
    const tenancy = yield* TenancyConfig;
    const roles = yield* InstanceRolesRepo;
    const clients = yield* SealantClients;
    const forCaller = Effect.fn("GithubIdentity.forCaller")(function* () {
      const caller = yield* CurrentUser;
      // A platform that can't be read counts as no connected login: the host rule still answers.
      const accounts = yield* clients
        .connectedAccounts(caller.user.id)
        .list()
        .pipe(
          Effect.tapError((error) =>
            Effect.logInfo("github: the caller's connected accounts could not be read").pipe(
              Effect.annotateLogs({ error: error.message }),
            ),
          ),
          Effect.orElseSucceed((): ReadonlyArray<ConnectedAccount> => []),
        );
      return githubAuthority(tenancy.mode, yield* roles.isOperator(caller.user.id), accounts);
    });
    return { forCaller };
  }),
);
