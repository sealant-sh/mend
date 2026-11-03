import type { ErrorComponentProps } from "@tanstack/react-router";
import {
  CatchBoundary,
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useLocation,
} from "@tanstack/react-router";
import { useState } from "react";

import type { RouterAppContext } from "#/router";
import { CRITICAL_CSS_ID } from "#/server/critical-css";

import appCss from "../styles.css?url";

const TITLE = "Mend";
const DESCRIPTION = "Projects, sessions, and the review — the agent workbench, by Sealant.";

export const Route = createRootRouteWithContext<RouterAppContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "noindex" },
    ],
    scripts: [
      {
        // No-flash: resolve the stored theme (or the OS) before first paint.
        // Mirrors lib/theme.ts — same key, same resolution.
        children: `(function(){try{var t=localStorage.getItem("mend-theme");if(t==="dark"||((t===null||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark");}}catch(e){}})();`,
      },
    ],
  }),
  component: RootComponent,
});

// One boundary above every page: a single failing query (one unreachable
// project, one expired session) degrades to this screen instead of a blank
// document. The reset key is the pathname, so navigating away recovers.
function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <main className="mx-auto max-w-lg px-6 py-24">
      <p className="font-mono text-[11px] tracking-wider text-faint uppercase">
        this page failed to load
      </p>
      <p className="mt-3 font-mono text-[12.5px] break-words text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-xl border border-border bg-card px-3 py-1.5 font-sans text-xs font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5"
      >
        Try again
      </button>
    </main>
  );
}

/**
 * The page's inlined sheet: empty as React renders it, filled by the server with the rules the
 * page's HTML uses (`server/critical-css.ts`); the browser hydrates it with what it received.
 */
const criticalSheet = (): string =>
  typeof document === "undefined"
    ? ""
    : (document.getElementById(CRITICAL_CSS_ID)?.textContent ?? "");

/**
 * Once the full sheet has applied, the inlined copy of its rules only adds to every style
 * recalculation: it is switched off then, as the page hydrates or when the sheet arrives after. A
 * full sheet that fails to load leaves it on.
 */
const retireCriticalSheet = (element: HTMLStyleElement | null) => {
  const full = document.querySelector<HTMLLinkElement>(`link[rel="stylesheet"][href="${appCss}"]`);
  if (element === null || full === null) return;
  // A media query no screen matches, not `sheet.disabled`: the browser rebuilds the sheet object.
  const retire = () => {
    element.media = "not all";
  };
  if (full.sheet !== null) retire();
  else full.addEventListener("load", retire, { once: true });
};

function RootComponent() {
  const pathname = useLocation({ select: (location) => location.pathname });
  // Read once: the sheet stays as the page was served.
  const [critical] = useState(criticalSheet);
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style
          id={CRITICAL_CSS_ID}
          ref={retireCriticalSheet}
          dangerouslySetInnerHTML={{ __html: critical }}
        />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground">
        <CatchBoundary getResetKey={() => pathname} errorComponent={RouteError}>
          <Outlet />
        </CatchBoundary>
        <Scripts />
        {/* After everything it would hold up: the page paints from the inlined sheet. */}
        <link rel="stylesheet" href={appCss} />
      </body>
    </html>
  );
}
