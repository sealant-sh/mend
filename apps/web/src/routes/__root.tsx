import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";

import { textSize } from "#/lib/appearance";
import { requireSignedIn } from "#/lib/sign-in";
import { browserTelemetryOf, pageTelemetry, telemetryScript } from "#/lib/telemetry-config";
import { THEME_KEY } from "#/lib/theme";
import type { RouterAppContext } from "#/router";
import { CRITICAL_CSS_ID } from "#/server/critical-css";

import appCss from "../styles.css?url";

const TITLE = "Mend";
const DESCRIPTION = "Projects, sessions, and the review — the agent workbench, by Sealant.";

/**
 * No-flash: resolve the stored theme (or the OS) before first paint. Mirrors lib/theme.ts, with
 * the old app's key, so a person's choice there holds here.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="dark"||((t===null||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark");}}catch(e){}})();`;

/**
 * Whether this page reports to Sentry, and where (`lib/telemetry-config.ts`): from the web
 * server's environment as it renders the page, and in the browser from what the page was served
 * with, so the head React hydrates is the head the server sent.
 */
const telemetryOfPage = createIsomorphicFn()
  .server(() => browserTelemetryOf(process.env))
  .client(pageTelemetry);

const telemetryScripts = (): Array<{ readonly children: string }> => {
  const script = telemetryScript(telemetryOfPage());
  return script === null ? [] : [{ children: script }];
};

export const Route = createRootRouteWithContext<RouterAppContext>()({
  // Every page needs a signed-in person, except the few a signed-out one opens (lib/sign-in.ts).
  beforeLoad: ({ context, location }) => requireSignedIn({ context, location }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // The on-screen keyboard shrinks the layout (and `dvh`) where browsers support it (Chrome on
      // Android), so a composer pinned at the foot of the screen stays above it.
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, interactive-widget=resizes-content",
      },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "noindex" },
    ],
    scripts: [{ children: THEME_SCRIPT }, ...telemetryScripts()],
  }),
  // The document is the shell, so the default pending, error and not-found screens render inside
  // it even when the root route itself is what failed.
  shellComponent: RootDocument,
});

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

function RootDocument({ children }: { readonly children: ReactNode }) {
  // Read once: the sheet stays as the page was served.
  const [critical] = useState(criticalSheet);
  // This browser's text size, from its cookie: the server draws the page at it, so nothing jumps.
  const size = textSize.use();
  return (
    // The theme script sets `.dark` on <html> before React hydrates it.
    <html lang="en" data-text-size={size === "default" ? undefined : size} suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Text, not markup: the server writes the rules into the empty tag after React renders
            it (server.ts), and the browser hydrates the text it received. */}
        <style id={CRITICAL_CSS_ID} ref={retireCriticalSheet}>
          {critical}
        </style>
      </head>
      {/* The desk: the colour behind every sheet. */}
      <body className="min-h-dvh bg-canvas font-sans text-foreground antialiased">
        {children}
        <Scripts />
        {/* After everything it would hold up: the page paints from the inlined sheet. */}
        <link rel="stylesheet" href={appCss} />
      </body>
    </html>
  );
}
