import { UNNAMED_SESSION_TITLE } from "@mend/domain/workbench";

/**
 * What a session is called, the server's rule (`sessionTitleFrom`) on whatever is in hand: its inbox
 * row's title (the label, else its first message's first line, else "New session"); before the
 * row arrives, its label, else "New session". Never its worktree's name or branch, which the
 * workspace's other sessions share.
 */
export const sessionTitleOf = (
  row: { readonly title: string } | null | undefined,
  label: string | null | undefined,
): string => row?.title ?? label ?? UNNAMED_SESSION_TITLE;
