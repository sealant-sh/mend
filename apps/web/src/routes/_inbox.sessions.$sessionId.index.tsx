import { createFileRoute } from "@tanstack/react-router";

/** The Conversation tab (screens P1, C1, X6): the session route lays it out and reads its page. */
export const Route = createFileRoute("/_inbox/sessions/$sessionId/")({});
