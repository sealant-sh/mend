import { fragmentFormOf, fragmentSecret, type HandedLinkKind } from "@mend/network";
import { type ParsedLocation, redirect, useLocation } from "@tanstack/react-router";

/** `publicHref` as the browser holds it: the router's `pathname` and `hash` are decoded already. */
const raw = (location: ParsedLocation): URL => new URL(location.publicHref, window.location.origin);

/** The secret in the page's fragment, followed as the router's location changes. */
export const useFragmentSecret = (): string | null =>
  useLocation({ select: (location) => fragmentSecret(raw(location).hash) });

/** The routes of links issued before 0.37 redirect with this; 0.39 removes them (ADR 0004). */
export const toFragmentForm =
  (kind: HandedLinkKind) =>
  ({ location }: { readonly location: ParsedLocation }): never => {
    throw redirect({ href: fragmentFormOf(kind, raw(location)), replace: true });
  };
