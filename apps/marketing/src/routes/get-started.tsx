// The walkthrough that lived here moved to the docs. The address stays
// answerable so old links and bookmarks land on the install page.

import { createFileRoute, redirect } from "@tanstack/react-router";

import { DOCS_INSTALL_URL } from "#/components/content";

export const Route = createFileRoute("/get-started")({
  beforeLoad: () => {
    throw redirect({ href: DOCS_INSTALL_URL });
  },
});
