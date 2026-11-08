import { loginChoiceOf } from "@mend/domain/default-login";
import {
  ProviderSetupError,
  type ProviderAuthState,
  type ProviderInstanceId,
  type ServerProviderAuth,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import type { MendClient, MendConnectedAccount } from "./mend-client.ts";

const harnessOf = (instanceId: string): "codex" | "claude" | null =>
  instanceId === "codex" ? "codex" : instanceId === "claudeAgent" ? "claude" : null;

const refusal = (instanceId: ProviderInstanceId, detail: string) =>
  new ProviderSetupError({ instanceId, operation: "providerAuthLogout", detail });

/** Only known display fields cross the provider-auth boundary. Arbitrary metadata never does. */
export const accountAuthOf = (
  account: MendConnectedAccount,
): Omit<ServerProviderAuth, "status"> => {
  const email = account.metadata?.["accountEmail"] ?? account.metadata?.["email"];
  return {
    ...(account.name.trim() === "" ? {} : { label: account.name.trim().slice(0, 200) }),
    ...(account.kind === undefined || account.kind.trim() === ""
      ? {}
      : { type: account.kind.trim().slice(0, 64) }),
    ...(typeof email === "string" && email.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      ? { email }
      : {}),
    ...(account.id === undefined || account.id === "" ? {} : { canLogout: true }),
  };
};

/** Idle read state lets T3's own authentication UI enable its native sign-out control. */
export const accountAuthState = (instanceId: ProviderInstanceId): ProviderAuthState => ({
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
  methods: [],
});

/** A connection binds sign-out to its displayed chosen account, never a newly selected default. */
export const makeProviderAccountControls = (
  mend: Pick<MendClient["Service"], "connectedAccounts" | "disconnectAccount">,
  deviceToken: string,
): {
  readonly observe: (accounts: ReadonlyArray<MendConnectedAccount>) => void;
  readonly logout: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
} => {
  const displayed = new Map<string, string>();
  const observe = (accounts: ReadonlyArray<MendConnectedAccount>): void => {
    for (const harness of ["codex", "claude"] as const) {
      const choice = loginChoiceOf(accounts, harness);
      const id = choice._tag === "chosen" ? choice.account.id : undefined;
      if (id === undefined || id === "") displayed.delete(harness);
      else displayed.set(harness, id);
    }
  };
  const logout = Effect.fn("ProviderAccounts.logout")(function* (instanceId: ProviderInstanceId) {
    const harness = harnessOf(instanceId);
    if (harness === null)
      return yield* refusal(
        instanceId,
        "Only your chosen Codex or Claude login can be disconnected here.",
      );
    const expected = displayed.get(harness);
    if (expected === undefined)
      return yield* refusal(
        instanceId,
        "No chosen login was displayed. Refresh provider settings before signing out.",
      );
    const held = yield* mend
      .connectedAccounts(deviceToken)
      .pipe(
        Effect.mapError(() =>
          refusal(
            instanceId,
            "Mend could not read your connected accounts. Refresh provider settings and try again.",
          ),
        ),
      );
    const current = loginChoiceOf(held, harness);
    if (current._tag !== "chosen" || current.account.id !== expected)
      return yield* refusal(
        instanceId,
        "Your chosen login changed. Refresh provider settings before signing out.",
      );
    // Same caller-scoped route as Mend's web disconnect. It owns running-session semantics;
    // the gateway neither interrupts sessions nor falls back to shared or organization logins.
    yield* mend
      .disconnectAccount(deviceToken, expected)
      .pipe(
        Effect.mapError(() =>
          refusal(
            instanceId,
            "Mend could not disconnect your login. Refresh provider settings and try again.",
          ),
        ),
      );
    displayed.delete(harness);
    return accountAuthState(instanceId);
  });
  return { observe, logout };
};
