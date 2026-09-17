import { createFileRoute } from "@tanstack/react-router";

import { SessionTerminal } from "#/components/terminal";

export const Route = createFileRoute("/tty-embed")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    session: typeof search["session"] === "string" ? search["session"] : "",
    process: typeof search["process"] === "string" ? search["process"] : undefined,
    ticket: typeof search["ticket"] === "string" ? search["ticket"] : "",
    token: typeof search["token"] === "string" ? search["token"] : "",
  }),
  component: TtyEmbed,
});

/**
 * The terminal alone, edge to edge — what the mobile app's WebView shows. No shell, no nav: one
 * surface. The app cannot set a header on a page load, so the URL carries an upgrade ticket (single
 * use, thirty seconds, this terminal only) which the page trades for the socket's own ticket
 * (docs/adr/0004, "Upgrade tickets"). `token` is read only for an app build older than tickets.
 */
function TtyEmbed() {
  const { session, process, ticket, token } = Route.useSearch();
  if (session === "") return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--sw-panel)" }}>
      <SessionTerminal
        key={process ?? session}
        sessionId={session}
        {...(process === undefined ? {} : { processId: process })}
        {...(ticket === "" ? { token } : { embedTicket: ticket })}
      />
    </div>
  );
}
