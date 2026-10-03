// A pull request in the session's conversation (docs/adr/0007-landing.md): the change is on
// GitHub, and this is the way there. It is the one lifted panel in a stream of flat rows, so it
// reads apart from what the agent said without a tinted ground (DESIGN.md §6): an eyebrow and the
// state as a dot and a word, the number in the display face, the facts in mono, and the one
// consequential action filled.

import { observedAgo } from "@mend/domain/workbench";
import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react-native";
import { Linking, Pressable, StyleSheet, View } from "react-native";

import { EvButton } from "@/components/button";
import { StatusWord } from "@/components/status";
import { Eyebrow, MonoText, UiText } from "@/components/typography";
import { useSession } from "@/data/live";
import { useRefreshPullRequest, useSessionLandings } from "@/data/pull-request-queries";
import {
  changedSinceLanding,
  newestPullRequest,
  pullRequestOrigin,
  pullRequestTone,
  type PullRequestCard as Card,
  type PullRequestStateDto,
} from "@/data/pull-requests";
import { fontFamilies, radius, useEvidenceTheme } from "@/theme/evidence";

const ICONS: Record<PullRequestStateDto, typeof GitPullRequest> = {
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

export const openPullRequest = (url: string): void => {
  void Linking.openURL(url).catch(() => undefined);
};

/** One mono fact under the title, divided by a hairline. */
function Fact({ children, edge }: { readonly children: string; readonly edge?: string }) {
  const { colors } = useEvidenceTheme();
  return (
    <View
      style={{
        paddingVertical: 7,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.faintRule,
        ...(edge === undefined
          ? {}
          : { borderLeftWidth: 2, borderLeftColor: edge, paddingLeft: 10 }),
      }}
    >
      <MonoText size={11.5} tone={edge === undefined ? "ink2" : "warning"} numberOfLines={2}>
        {children}
      </MonoText>
    </View>
  );
}

export function PullRequestCard({
  card,
  changedFiles,
  canRefresh,
  refreshing,
  refreshError,
  onRefresh,
}: {
  readonly card: Card;
  /** Files the worktree changed since the change last landed; null when nothing says so. */
  readonly changedFiles: number | null;
  /** Only the change's owner asks `gh` again. */
  readonly canRefresh: boolean;
  readonly refreshing: boolean;
  readonly refreshError: string | null;
  readonly onRefresh: () => void;
}) {
  const { colors, shadow } = useEvidenceTheme();
  const Icon = ICONS[card.state];
  return (
    <View
      style={{
        backgroundColor: colors.panel,
        borderRadius: radius.xl2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.softRule,
        boxShadow: shadow.md,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 14,
        gap: 12,
        marginVertical: 6,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon size={14} color={colors.ink2} strokeWidth={1.8} />
          <Eyebrow>pull request</Eyebrow>
        </View>
        <StatusWord tone={pullRequestTone(card.state)} word={card.state} size={11.5} />
      </View>

      <View style={{ gap: 4 }}>
        <UiText
          size={24}
          style={{ fontFamily: fontFamilies.display.semibold, letterSpacing: -0.4, lineHeight: 28 }}
        >
          #{card.number}
        </UiText>
        {card.title === null ? null : (
          <UiText weight="medium" size={15} numberOfLines={3} style={{ lineHeight: 21 }}>
            {card.title}
          </UiText>
        )}
      </View>

      <View>
        <Fact>{card.branch}</Fact>
        <Fact>{pullRequestOrigin(card)}</Fact>
        <Fact>{`observed ${observedAgo(new Date(card.observedAt), new Date())}`}</Fact>
        {changedFiles === null || changedFiles === 0 ? null : (
          <Fact edge={colors.amber}>
            {`changed since landing · ${changedFiles} file${changedFiles === 1 ? "" : "s"}`}
          </Fact>
        )}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <EvButton size="sm" label="Open on GitHub" onPress={() => openPullRequest(card.url)} />
        {canRefresh ? (
          <EvButton
            size="sm"
            variant="ghost"
            label={refreshing ? "Asking GitHub…" : "Refresh"}
            disabled={refreshing}
            onPress={onRefresh}
          />
        ) : null}
      </View>
      {refreshError === null ? null : (
        <MonoText tone="danger" size={11} numberOfLines={3}>
          {refreshError}
        </MonoText>
      )}
    </View>
  );
}

/** The card for one of the session's pull requests; Refresh asks `gh` as the change's owner. */
export function SessionPullRequest({
  sessionId,
  card,
}: {
  readonly sessionId: string;
  readonly card: Card;
}) {
  const landings = useSessionLandings(sessionId, true);
  const refresh = useRefreshPullRequest(sessionId);
  return (
    <PullRequestCard
      card={card}
      changedFiles={changedSinceLanding(landings.data?.facts ?? [])}
      canRefresh={landings.data?.land === true}
      refreshing={refresh.isPending}
      refreshError={refresh.error instanceof Error ? refresh.error.message : null}
      onRefresh={() => refresh.mutate(card.landingId)}
    />
  );
}

/**
 * The review's line for the change's newest pull request: what the reviewer reads is on GitHub
 * as this pull request, unless the worktree moved since it landed, which the amber edge says.
 * The whole line opens it.
 */
export function ReviewPullRequest({ sessionId }: { readonly sessionId: string }) {
  const { colors, shadow } = useEvidenceTheme();
  const card = newestPullRequest(useSession(sessionId).data?.landings ?? []);
  const landings = useSessionLandings(sessionId, card !== undefined);
  if (card === undefined) return null;
  const Icon = ICONS[card.state];
  const changedFiles = changedSinceLanding(landings.data?.facts ?? []);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open pull request ${card.number} on GitHub`}
      onPress={() => openPullRequest(card.url)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? colors.sunken : colors.panel,
        borderRadius: radius.xl,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.softRule,
        boxShadow: shadow.sm,
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 6,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon size={14} color={colors.accent} strokeWidth={1.8} />
        <MonoText tone="accent" size={12.5} weight="medium">
          {`#${card.number}`}
        </MonoText>
        <UiText size={13.5} numberOfLines={1} style={{ flex: 1 }}>
          {card.title ?? "pull request"}
        </UiText>
        <StatusWord tone={pullRequestTone(card.state)} word={card.state} size={11} />
      </View>
      <MonoText tone="faint" size={11}>
        {`${pullRequestOrigin(card)} · observed ${observedAgo(new Date(card.observedAt), new Date())}`}
      </MonoText>
      {changedFiles === null || changedFiles === 0 ? null : (
        <View style={{ borderLeftWidth: 2, borderLeftColor: colors.amber, paddingLeft: 8 }}>
          <MonoText tone="warning" size={11}>
            {`changed since landing · ${changedFiles} file${changedFiles === 1 ? "" : "s"}`}
          </MonoText>
        </View>
      )}
    </Pressable>
  );
}
