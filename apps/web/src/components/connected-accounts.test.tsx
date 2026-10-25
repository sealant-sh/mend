import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConnectedAccountDto } from "#/lib/api";
import { makeTrpcProxy, TRPCProvider, trpcClient } from "#/lib/trpc";

import { ConnectedAccountsPanel } from "./connected-accounts.tsx";

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

const render = (accounts: ReadonlyArray<ConnectedAccountDto>) => {
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
  return html
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
};

const rows = (accounts: ReadonlyArray<ConnectedAccountDto>) => {
  const lines = render(accounts);
  return ["Claude", "Codex", "GitHub"].map((label) => [label, lines[lines.indexOf(label) + 1]]);
};

/** The words a provider's row shows, its detail paragraph left out. */
const section = (accounts: ReadonlyArray<ConnectedAccountDto>, label: string, next: string) => {
  const lines = render(accounts);
  return lines
    .slice(lines.indexOf(label), lines.indexOf(next))
    .filter((line) => !line.startsWith("What ") && !line.startsWith("In a per-person"));
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

  it("offers Replace and Disconnect on the chosen login alone", () => {
    expect(
      section(
        [
          account("claude", "default", false, "old@example.com"),
          account("claude", "work", true, "work@example.com"),
        ],
        "Claude",
        "Codex",
      ),
    ).toEqual(["Claude", "work@example.com", "Replace", "Disconnect"]);
  });

  it("offers Disconnect on each account when none is chosen, and says what to do", () => {
    expect(
      section(
        [
          account("codex", "work", false, "work@example.com"),
          account("codex", "home", false, "home@example.com"),
        ],
        "Codex",
        "GitHub",
      ),
    ).toEqual([
      "Codex",
      "No Codex login chosen",
      "Connect",
      "work · work@example.com",
      "Disconnect",
      "home · home@example.com",
      "Disconnect",
      "Remove the others with mend connect codex --remove &lt;name&gt;, or Disconnect them in Settings → Connected accounts, then connect the one left again to choose it.",
    ]);
  });
});
