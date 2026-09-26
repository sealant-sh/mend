import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import appCss from "../styles.css?url";

const TITLE = "Mend — run your TUI agents anywhere you want";
const DESCRIPTION =
  "Run Claude Code, Codex, OpenCode, Pi or any command on hardware you own. Every session and worktree lives on one machine, each session isolated in its own worktree and workspace, with your dotfiles, secrets, dev servers and a live preview link for every change. Reach it from a terminal, VS Code, a browser, your phone or Slack. Open source, self-hosted.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
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
