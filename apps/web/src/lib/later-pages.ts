/**
 * A link to a page whose route a later PR adds, through the signed-in catch-all route
 * (`routes/_inbox.$.tsx`): the address is the page's own, and until its route exists it shows the
 * not-found screen. The PR that adds the route links to it by name instead.
 */
export const laterPage = (path: string) => ({ to: "/$", params: { _splat: path } }) as const;

/** A session's page, until the session route exists. */
export const sessionPage = (sessionId: string) => laterPage(`sessions/${sessionId}`);
