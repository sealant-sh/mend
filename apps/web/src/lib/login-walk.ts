/**
 * The walk to sign-in, from one place. A refused request (401) and the `access` event both send
 * the page to `/login`; only the event knows why. When an account is removed from its
 * organization the event is sent before anything it asks is refused, but a request already in
 * flight can still come back refused first (live pass 2026-10-10: a removed member's page landed
 * on a plain `/login`). So a refused request waits a beat, and an `access` walk that starts in
 * the meantime decides the page, with its reason.
 */
export const ACCESS_GRACE_MS = 400;

export interface LoginWalkWindow {
  readonly pathname: () => string;
  /** Where a refused request walks: `/login`, with `next` when there is somewhere to return. */
  readonly loginUrl: () => string;
  readonly assign: (url: string) => void;
  readonly later: (run: () => void, ms: number) => void;
}

export const makeLoginWalk = (window: LoginWalkWindow) => {
  let walking: "refused" | "access" | null = null;
  return {
    /** A request answered 401: sign-in, unless the access walk starts within the grace. */
    refused: () => {
      if (walking !== null || window.pathname() === "/login") return;
      walking = "refused";
      const url = window.loginUrl();
      window.later(() => {
        if (walking === "refused") window.assign(url);
      }, ACCESS_GRACE_MS);
    },
    /** This account was removed from its organization (docs/adr/0003): sign-in says so. */
    accessRemoved: () => {
      if (walking === "access") return;
      walking = "access";
      window.assign("/login?reason=access");
    },
  };
};
