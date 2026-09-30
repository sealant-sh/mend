// One session as a conversation under its header: the whole screen on a phone, one pane of a wide
// layout on a foldable or a tablet. Protocol agents render the durable authored turns, ordered
// items, and agent-to-human requests. Older PTY sessions keep their transcript projection and raw
// TTY composer.

import { useRouter } from "expo-router";
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { ProtocolConversation } from "@/components/protocol-conversation";
import { PtyConversation } from "@/components/pty-conversation";
import { StatusWord } from "@/components/status";
import { DisplayTitle, MonoText, UiText } from "@/components/typography";
import { findLastMatching } from "@/data/collections";
import {
  agentIsActive,
  canDeliverFollowUp,
  statusLineOf,
  toneOf,
  usePendingFollowUp,
  useSession,
  useSessionActions,
} from "@/data/live";
import { spacing, useEvidenceTheme } from "@/theme/evidence";

/** What a wide layout shows beside the conversation. */
export type Companion = "terminal" | "diff";

export interface CompanionControl {
  readonly open: Companion | null;
  readonly toggle: (companion: Companion) => void;
}

export function SessionPane({
  sessionId,
  mode,
  topInset,
  tile = false,
  companion,
  trailing,
}: {
  readonly sessionId: string;
  /** `protocol` when the caller knows the session speaks the protocol before its detail loads. */
  readonly mode?: string;
  /** The pane reaches the top edge: leave the status bar's room. */
  readonly topInset: boolean;
  /** A tile of a split: a one-line header and only the tile's own actions. */
  readonly tile?: boolean;
  /** Diff and Shell open beside the conversation instead of on their own screens. */
  readonly companion?: CompanionControl;
  /** Buttons after the session's own. */
  readonly trailing?: ReactNode;
}) {
  const router = useRouter();
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const detail = useSession(sessionId);
  const session = detail.data?.session;
  const change = detail.data?.change ?? null;
  const currentAgent = detail.data?.currentAgent ?? null;
  const agentActive = agentIsActive(session, currentAgent);
  // Only the owner steers unless they share control (docs/adr/0003). A server from before
  // organizations sends no control view; everything stays available there.
  const steer = detail.data?.control?.steer ?? true;
  const canStop = detail.data?.control?.stop ?? true;
  // Handing a session off is the owner's even while control is shared.
  const own = detail.data?.control?.own ?? true;
  const canOpenShell =
    session !== undefined && ["running", "waiting", "idle"].includes(session.status);
  const protocol =
    currentAgent === null ? mode === "protocol" : currentAgent.kind === "agent-protocol";
  const followUp = usePendingFollowUp(sessionId).data ?? null;
  const { resume, stop, openShell, deliverFollowUp, handoff } = useSessionActions();
  const [shellError, setShellError] = useState<string | null>(null);
  // Cross-mode pickup: claude and codex sessions continue here in structured
  // mode; other harnesses keep the raw terminal composer.
  const canPickUp = own && (session?.harness === "claude" || session?.harness === "codex");

  const openTerminal = () => {
    if (session === undefined) {
      return;
    }
    if (companion !== undefined) {
      companion.toggle("terminal");
      return;
    }
    const attach = (processId: string) =>
      router.push({
        pathname: "/terminal/[id]",
        params: { id: session.id, process: processId },
      });
    const reusable = findLastMatching(
      detail.data?.processes ?? [],
      (process) => process.kind === "shell" && process.exitedAt === null,
    );
    if (reusable !== undefined) {
      attach(reusable.id);
      return;
    }
    setShellError(null);
    openShell.mutate(session.id, {
      onSuccess: (process) => attach(process.id),
      onError: (error) => setShellError(error instanceof Error ? error.message : String(error)),
    });
  };
  const openDiff = (changeId: string) => {
    if (companion !== undefined) {
      companion.toggle("diff");
      return;
    }
    router.push({ pathname: "/diff/[id]", params: { id: changeId } });
  };
  // A session that could not be read says so, with the server's words and a
  // retry — never "loading" forever, and never a screen with no Review button
  // and no reason.
  let conversation =
    detail.isError && session === undefined ? (
      <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
        <MonoText tone="danger">session · could not be read</MonoText>
        <MonoText size={11} tone="ink2" numberOfLines={6}>
          {detail.error.message}
        </MonoText>
        <View style={{ flexDirection: "row" }}>
          <EvButton
            size="sm"
            variant="outline"
            label={detail.isFetching ? "retrying…" : "Retry"}
            disabled={detail.isFetching}
            onPress={() => void detail.refetch()}
          />
        </View>
      </View>
    ) : (
      <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8 }}>
        <MonoText tone="faint">loading session…</MonoText>
      </View>
    );
  if (session !== undefined) {
    conversation = protocol ? (
      <ProtocolConversation
        sessionId={session.id}
        active={agentActive && steer}
        starting={session.status === "starting"}
        summary={session.summary}
      />
    ) : (
      <PtyConversation
        sessionId={session.id}
        active={agentActive}
        summary={session.summary}
        {...(canPickUp
          ? {
              pickUp: {
                start: (prompt: string) =>
                  handoff.mutate({ sessionId: session.id, to: "protocol", prompt }),
                pending: handoff.isPending,
                error:
                  handoff.error === null
                    ? null
                    : handoff.error instanceof Error
                      ? handoff.error.message
                      : String(handoff.error),
              },
            }
          : {})}
      />
    );
  }

  if (tile) {
    return (
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingTop: (topInset ? insets.top : 0) + 10,
            paddingBottom: 10,
            paddingHorizontal: 14,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.softRule,
          }}
        >
          <View style={{ flex: 1, gap: 3 }}>
            <UiText weight="semibold" size={14.5} numberOfLines={1}>
              {session?.label ?? session?.harness ?? "…"}
            </UiText>
            {session === undefined ? null : (
              <StatusWord
                tone={toneOf(session.status)}
                word={`${session.harness} · ${statusLineOf(session)}`}
                size={10.5}
              />
            )}
          </View>
          {trailing}
        </View>
        {conversation}
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          paddingTop: (topInset ? insets.top : 0) + 4,
          paddingHorizontal: 16,
          paddingBottom: spacing.xs,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <DisplayTitle style={{ fontSize: 18, lineHeight: 23, letterSpacing: -0.3 }}>
            {session?.harness ?? "…"}
          </DisplayTitle>
          <View style={{ flex: 1 }} />
          {session !== undefined && (
            <StatusWord tone={toneOf(session.status)} word={statusLineOf(session)} />
          )}
        </View>
        {session !== undefined && (
          <MonoText tone="faint" size={10.5} numberOfLines={1}>
            worktree{" "}
            {session.branch.replace(/^mend\/session\//, "session ").replace(/^mend\/(wt\/)?/, "")} ·
            base {session.baseRef ?? session.baseSha.slice(0, 12)}
          </MonoText>
        )}
        {session !== undefined && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {change !== null && (
              <EvButton
                size="sm"
                label="Review"
                onPress={() => router.push({ pathname: "/review/[id]", params: { id: change.id } })}
              />
            )}
            {change !== null && (
              <EvButton
                size="sm"
                variant="outline"
                label={companion?.open === "diff" ? "Hide diff" : "Diff"}
                onPress={() => openDiff(change.id)}
              />
            )}
            {steer && !agentActive && followUp !== null && canDeliverFollowUp(followUp) && (
              <EvButton
                size="sm"
                label={deliverFollowUp.isPending ? "delivering…" : "Deliver follow-up"}
                disabled={deliverFollowUp.isPending}
                onPress={() => deliverFollowUp.mutate(followUp)}
              />
            )}
            {steer && !agentActive && (
              <EvButton
                size="sm"
                variant={change === null && followUp === null ? "primary" : "outline"}
                label={resume.isPending ? "resuming…" : "Resume"}
                onPress={() => resume.mutate({ sessionId: session.id, harness: null })}
              />
            )}
            {steer && canOpenShell && (
              <EvButton
                size="sm"
                variant="outline"
                label={
                  companion?.open === "terminal"
                    ? "Hide shell"
                    : openShell.isPending
                      ? "opening…"
                      : "Shell"
                }
                disabled={openShell.isPending}
                onPress={openTerminal}
              />
            )}
            {trailing}
            <View style={{ flex: 1 }} />
            {agentActive && canStop && (
              <EvButton
                size="sm"
                variant="ghost"
                label={stop.isPending ? "…" : "Stop session"}
                onPress={() => stop.mutate(session.id)}
              />
            )}
          </View>
        )}
        {steer ? null : (
          <MonoText tone="faint" size={11} numberOfLines={2}>
            only the owner steers this session · you can read it and review the change
          </MonoText>
        )}
        {detail.isError && session !== undefined ? (
          <MonoText tone="warning" size={11} numberOfLines={2}>
            last refresh failed · {detail.error.message}
          </MonoText>
        ) : null}
        {shellError === null ? null : (
          <MonoText tone="danger" size={11} numberOfLines={2}>
            {shellError}
          </MonoText>
        )}
      </View>
      {conversation}
    </View>
  );
}
