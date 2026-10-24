import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import appCss from "../styles.css?url";

const TITLE = "Mend — run your TUI agents anywhere you want";
const DESCRIPTION =
  "Run Claude Code, Codex, OpenCode, Pi or any command on hardware you own. Every session and worktree lives on one machine, each session isolated in its own worktree and workspace, with your dotfiles, secrets, dev servers and a live preview link for every change. Reach it from a terminal, VS Code, a browser, your phone or Slack. Open source, self-hosted.";
const SITE_URL = "https://mend.run/";
const OG_IMAGE = "https://mend.run/og.png";
const OG_IMAGE_ALT = "The mend wordmark with the line: Run your TUI agents anywhere you want.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // cover: the page pads itself by the safe-area insets (standalone, landscape).
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      // Safari 15–18 tint their bars from this; 26 samples the sticky header instead.
      // The light canvas (--sw-canvas); the theme switcher swaps it for the dark one.
      { name: "theme-color", content: "#edeae4" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: SITE_URL },
      { property: "og:image", content: OG_IMAGE },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: OG_IMAGE_ALT },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: OG_IMAGE },
      { name: "twitter:image:alt", content: OG_IMAGE_ALT },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="marketing-body">
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
