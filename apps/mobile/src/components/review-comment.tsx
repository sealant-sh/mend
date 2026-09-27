// A review comment, rendered whole: author · state in mono, the body, the
// verbatim suggestion, evidence into the record, and the disposition
// actions. State words, never verdicts (DESIGN.md §4). A comment already
// sent to the session settles through the follow-up loop — no actions.

import { Pressable, ScrollView, View } from "react-native";

import { MonoText, UiText } from "@/components/typography";
import { useReviewActions, type ReviewCommentDto } from "@/data/review";
import { radius, useEvidenceTheme } from "@/theme/evidence";

type Disposition = "open" | "addressed" | "dismissed";

// Drafts are Mend's findings awaiting the reviewer; accepting one makes it
// an open comment that joins the next follow-up bundle like any other.
const ACTIONS: Record<
  ReviewCommentDto["state"],
  ReadonlyArray<{ readonly state: Disposition; readonly label: string }>
> = {
  draft: [
    { state: "open", label: "Accept" },
    { state: "dismissed", label: "Dismiss" },
  ],
  open: [
    { state: "addressed", label: "Mark addressed" },
    { state: "dismissed", label: "Dismiss" },
  ],
  addressed: [{ state: "open", label: "Reopen" }],
  dismissed: [{ state: "open", label: "Reopen" }],
};

export function CommentCard({
  comment,
  showAnchor = false,
  writtenOn = null,
}: {
  readonly comment: ReviewCommentDto;
  /** Name the anchor when the card renders away from its line. */
  readonly showAnchor?: boolean;
  /** The checkpoint of the slice it was written on, when that is not the slice on screen. */
  readonly writtenOn?: number | null;
}) {
  const { colors } = useEvidenceTheme();
  const { setState } = useReviewActions(comment.changeId);
  const sent = comment.sentToSessionId !== null;
  const author = comment.authorKind === "mend" ? "Mend" : comment.authorName;
  const anchor =
    (showAnchor && comment.file !== null
      ? `${comment.file}${comment.line === null ? "" : `:${comment.line}`} · `
      : "") + (writtenOn === null ? "" : `checkpoint ${writtenOn} · `);
  const actions = sent ? [] : ACTIONS[comment.state];

  return (
    <View style={{ gap: 6, opacity: comment.state === "dismissed" ? 0.6 : 1 }}>
      <MonoText size={10.5} tone="label" numberOfLines={1}>
        {anchor}
        {author} · {sent ? "sent to session" : comment.state}
      </MonoText>
      <UiText size={13.5} style={{ lineHeight: 19 }}>
        {comment.body}
      </UiText>
      {comment.kind === "suggestion" && (
        <View style={{ gap: 4 }}>
          <MonoText size={10.5} tone="label">
            {comment.suggestion === null
              ? "suggested: delete these lines"
              : "suggested replacement"}
          </MonoText>
          {comment.suggestion !== null && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ backgroundColor: colors.sunken, borderRadius: radius.md }}
            >
              <MonoText size={11} style={{ padding: 10 }}>
                {comment.suggestion}
              </MonoText>
            </ScrollView>
          )}
        </View>
      )}
      {comment.evidence.map((link, index) => (
        <MonoText key={index} size={10.5} tone="faint" numberOfLines={1}>
          seq {link.sequence} · {link.excerpt}
        </MonoText>
      ))}
      {actions.length > 0 && (
        <View style={{ flexDirection: "row", gap: 18, paddingTop: 2 }}>
          {actions.map((action) => (
            <Pressable
              key={action.state}
              disabled={setState.isPending}
              onPress={() => setState.mutate({ commentId: comment.id, state: action.state })}
              hitSlop={8}
            >
              <MonoText size={10.5} tone="muted">
                {setState.isPending && setState.variables?.state === action.state
                  ? "…"
                  : action.label}
              </MonoText>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
