/**
 * Which of a session header's actions show as buttons and which wait behind "more"
 * (`session-header.tsx`). A `menuOnly` action never shows as a button: a destructive one, such as
 * stopping the session, is never one bump away (alpha 2026-10-01: a session stopped while its
 * owner used the shell beside it, its Stop one tap from the Shell toggle).
 */
export const splitHeaderActions = <A extends { readonly menuOnly?: boolean }>(
  actions: ReadonlyArray<A>,
  direct: number,
): { readonly shown: ReadonlyArray<A>; readonly rest: ReadonlyArray<A> } => {
  const buttons = actions.filter((action) => action.menuOnly !== true);
  const menuOnly = actions.filter((action) => action.menuOnly === true);
  // A "more" button that hides one button-able action saves nothing; one it must hold anyway
  // (a menu-only action) already earns it.
  const shown =
    menuOnly.length === 0 && buttons.length <= direct + 1 ? buttons : buttons.slice(0, direct);
  return { shown, rest: [...buttons.slice(shown.length), ...menuOnly] };
};
