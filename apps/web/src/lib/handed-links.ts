import { canonicalHandedLinkPath, type HandedLinkKind } from "@mend/network";
import { redirect } from "@tanstack/react-router";

export const toFragmentForm = (kind: HandedLinkKind) => (): never => {
  throw redirect({ href: canonicalHandedLinkPath(kind, window.location), replace: true });
};
