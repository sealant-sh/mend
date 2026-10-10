import { OrganizationView } from "@mend/api-contracts";
import { OrganizationId } from "@mend/domain";
import { Organization } from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { makeTrpcProxy, TRPCProvider, trpcClient } from "#/lib/trpc";
import { useViewerState } from "#/lib/viewer";
import { SharedControl } from "#/routes/sessions.$sessionId";

const at = new Date("2026-10-11T09:00:00Z");
const aliceView = new OrganizationView({
  organization: new Organization({
    id: OrganizationId.make("org-1"),
    name: "Sealant",
    createdByUserId: null,
    createdAt: at,
    updatedAt: at,
  }),
  userId: "alice",
  role: "member",
  memberCount: 2,
  operator: false,
  tenancy: "single",
  mountDelivery: "bind",
});

/** Render with nothing read yet, unless `seed` fills the cache first (what the page already holds). */
const render = (node: ReactNode, seed?: (client: QueryClient) => void) => {
  const queryClient = new QueryClient();
  seed?.(queryClient);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {node}
      </TRPCProvider>
    </QueryClientProvider>,
  );
};

const control = (props: {
  readonly ownerSteers: boolean;
  readonly canToggle: boolean;
  readonly ownerName: string | null | undefined;
}) => (
  <SharedControl
    sessionId="session-1"
    shared
    steer
    turnsOnSendersLogin={false}
    ownerSteers={props.ownerSteers}
    canToggle={props.canToggle}
    ownerName={props.ownerName}
  />
);

const Probe = () => {
  const viewer = useViewerState();
  return <p>{viewer === undefined ? "unread" : (viewer?.userId ?? "nobody")}</p>;
};

describe("who is looking", () => {
  it("is unknown while organization.current is in flight, not nobody", () => {
    expect(render(<Probe />)).toContain("unread");
    expect(
      render(<Probe />, (client) =>
        client.setQueryData(makeTrpcProxy(client).organization.current.queryKey(), aliceView),
      ),
    ).toContain("alice");
  });
});

describe("the shared control line", () => {
  it("gives the owner the switch, whether or not the roster has arrived", () => {
    for (const ownerName of [undefined, "Alice"]) {
      const markup = render(control({ ownerSteers: true, canToggle: true, ownerName }));
      expect(markup).toContain("Shared control");
      expect(markup).not.toContain("shares control of this session");
    }
  });

  it("says nothing to anyone else until the roster names the owner", () => {
    expect(render(control({ ownerSteers: false, canToggle: true, ownerName: undefined }))).toBe("");
    expect(render(control({ ownerSteers: false, canToggle: false, ownerName: undefined }))).toBe(
      "",
    );
    expect(render(control({ ownerSteers: false, canToggle: true, ownerName: "Alice" }))).toContain(
      "Alice shares control of this session.",
    );
  });
});
