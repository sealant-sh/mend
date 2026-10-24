import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConnectedAccountDto } from "#/lib/api";
import { makeTrpcProxy, TRPCProvider, trpcClient } from "#/lib/trpc";
import { ConnectedAccountsPanel } from "#/routes/settings";

const account = (
  provider: ConnectedAccountDto["provider"],
  name: string,
  isDefault: boolean,
  login: string,
): ConnectedAccountDto => ({
  id: `account-${provider}-${name}`,
  provider,
  name,
  isDefault,
  kind: "oauth-token",
  status: "active",
  metadata: { login },
  connectedAt: new Date("2026-09-18T00:00:00.000Z"),
  updatedAt: new Date("2026-09-18T00:00:00.000Z"),
  lastUsedAt: null,
});

const rows = (accounts: ReadonlyArray<ConnectedAccountDto>) => {
  const queryClient = new QueryClient();
  const trpc = makeTrpcProxy(queryClient);
  queryClient.setQueryData(trpc.platform.sealantIdentity.queryKey(), {
    sealantUserId: "su-me",
    accounts,
  });
  queryClient.setQueryData(trpc.platform.agentLogins.queryKey(), { selectedOnly: false });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <ConnectedAccountsPanel />
      </TRPCProvider>
    </QueryClientProvider>,
  );
  const lines = html
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  return ["Claude", "Codex", "GitHub"].map((label) => [label, lines[lines.indexOf(label) + 1]]);
};

describe("Settings, Connected accounts", () => {
  it("shows one account per provider as it always has", () => {
    expect(
      rows([
        account("claude", "default", true, "me@example.com"),
        account("github", "default", true, "me"),
      ]),
    ).toEqual([
      ["Claude", "me@example.com"],
      ["Codex", "not connected"],
      ["GitHub", "me"],
    ]);
  });

  it("shows the chosen default whatever its name, and says when none is chosen", () => {
    expect(
      rows([
        account("claude", "default", false, "old@example.com"),
        account("claude", "work", true, "work@example.com"),
        account("codex", "work", false, "work@example.com"),
        account("codex", "home", false, "home@example.com"),
      ]),
    ).toEqual([
      ["Claude", "work@example.com"],
      ["Codex", "No Codex login chosen"],
      ["GitHub", "not connected"],
    ]);
  });
});
