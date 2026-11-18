import { fragmentFormOf, fragmentSecret, type HandedLinkKind } from "@mend/network";
import { type ParsedLocation, redirect, useLocation } from "@tanstack/react-router";

/**
 * Links an owner, the operator or Slack hands a person (`@mend/network`'s handed links): the
 * secret rides the fragment, so it never reaches a server log. Copied from the old app.
 */

/** `publicHref` as the browser holds it: the router's `pathname` and `hash` are decoded already. */
const raw = (location: ParsedLocation): URL => new URL(location.publicHref, window.location.origin);

/** The secret in this page's fragment, or null when there is none or it isn't one. */
export const useFragmentSecret = (): string | null =>
  useLocation({ select: (location) => fragmentSecret(raw(location).hash) });

/** A route's `beforeLoad` that moves an older `/<page>/<secret>` link to `/<page>#<secret>`. */
export const toFragmentForm =
  (kind: HandedLinkKind) =>
  ({ location }: { readonly location: ParsedLocation }): never => {
    throw redirect({ href: fragmentFormOf(kind, raw(location)), replace: true });
  };
