import { createFileRoute } from "@tanstack/react-router";

import { SessionTerminal } from "#/components/terminal/session-terminal";

/**
 * The terminal alone, edge to edge: the page the phone app's WebView loads
 * (`apps/mobile/src/components/ghostty-terminal.tsx`), at the address and with the parameters it
 * has always had: `session`, `process` (a shell), `ticket`, `token` (a phone build older than
 * tickets) and `readOnly=1`. The app can't set a header on a page load, so the URL carries an
 * upgrade ticket (single use, thirty seconds, this terminal only) which the page trades for the
 * socket's own ticket (docs/adr/0004, "Upgrade tickets"). It is opened with no sign-in cookie, so
 * it is one of the signed-out pages (`lib/sign-in.ts`), and drawn only in the browser.
 */
export const Route = createFileRoute("/tty-embed")({
  validateSearch: (search: Record<string, unknown>) => ({
    session: typeof search["session"] === "string" ? search["session"] : "",
    process: typeof search["process"] === "string" ? search["process"] : undefined,
    ticket: typeof search["ticket"] === "string" ? search["ticket"] : "",
    token: typeof search["token"] === "string" ? search["token"] : "",
    // The app that embeds the page says when its viewer only reads (docs/adr/0013).
    readOnly: search["readOnly"] === "1" || search["readOnly"] === 1,
  }),
  ssr: false,
  component: TtyEmbed,
});

function TtyEmbed() {
  const { session, process, ticket, token, readOnly } = Route.useSearch();
  if (session === "") return null;
  return (
    <div className="fixed inset-0 flex flex-col bg-muted">
      <SessionTerminal
        key={process ?? session}
        sessionId={session}
        {...(process === undefined ? {} : { processId: process })}
        {...(ticket === "" ? { token } : { embedTicket: ticket })}
        readOnly={readOnly}
        autoFocus
        className="px-2 py-1"
      />
    </div>
  );
}
