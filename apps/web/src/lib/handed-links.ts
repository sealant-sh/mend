import { fragmentFormOf, fragmentSecret, type HandedLinkKind } from "@mend/network";
import { type ParsedLocation, redirect, useLocation } from "@tanstack/react-router";

/** `publicHref` as the browser holds it: the router's `pathname` and `hash` are decoded already. */
const raw = (location: ParsedLocation): URL => new URL(location.publicHref, window.location.origin);

/** The secret in the page's fragment, followed as the router's location changes. */
export const useFragmentSecret = (): string | null =>
  useLocation({ select: (location) => fragmentSecret(raw(location).hash) });

export const toFragmentForm =
  (kind: HandedLinkKind) =>
  ({ location }: { readonly location: ParsedLocation }): never => {
    throw redirect({ href: fragmentFormOf(kind, raw(location)), replace: true });
  };
