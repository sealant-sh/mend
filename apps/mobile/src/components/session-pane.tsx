// One session as a conversation under its header: the whole screen on a phone, one pane of a wide
// layout on a foldable or a tablet. Protocol agents render the durable authored turns, ordered
// items, and agent-to-human requests. Older PTY sessions keep their transcript projection and raw
// TTY composer.

import { useRouter } from "expo-router";
import {
  ClipboardCheck,
  CircleStop,
  FileDiff,
  Play,
  Send,
  SquareTerminal,
} from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { ProtocolConversation } from "@/components/protocol-conversation";
import { PtyConversation } from "@/components/pty-conversation";
import { SessionHeader, type HeaderAction } from "@/components/session-header";
import { StatusWord } from "@/components/status";
import { MonoText } from "@/components/typography";
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
import { usePosture } from "@/data/use-posture";

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
  companion,
  extraActions = [],
  pinnedActions = [],
  direct,
}: {
  readonly sessionId: string;
  /** `protocol` when the caller knows the session speaks the protocol before its detail loads. */
  readonly mode?: string;
  /** The pane reaches the top edge: leave the status bar's room. */
  readonly topInset: boolean;
  /** Diff and Shell open beside the conversation instead of on their own screens. */
  readonly companion?: CompanionControl;
  /** The caller's actions, after the session's own (Expand, Split). */
  readonly extraActions?: ReadonlyArray<HeaderAction>;
  /** Always shown at the end of the row (a split tile's expand and close). */
  readonly pinnedActions?: ReadonlyArray<HeaderAction>;
  /** How many actions show as buttons before the rest go under "more". */
  readonly direct?: number;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const posture = usePosture();
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

  // A resume that failed or was refused says why, where Resume was tapped; the session line
  // alone read `stopped` again with no reason (alpha 2026-09-30).
  const resumeError =
    resume.error === null
      ? null
      : resume.error instanceof Error
        ? resume.error.message
        : String(resume.error);
  const actions: Array<HeaderAction> = [];
  if (session !== undefined && steer && !agentActive) {
    if (followUp !== null && canDeliverFollowUp(followUp)) {
      actions.push({
        key: "deliver",
        label: deliverFollowUp.isPending ? "Delivering the follow-up…" : "Deliver follow-up",
        icon: Send,
        tone: "accent",
        disabled: deliverFollowUp.isPending,
        onPress: () => deliverFollowUp.mutate(followUp),
      });
    }
    actions.push({
      key: "resume",
      label: resume.isPending ? "Resuming…" : "Resume",
      icon: Play,
      tone: "accent",
      disabled: resume.isPending,
      onPress: () => resume.mutate({ sessionId: session.id, harness: null }),
    });
  }
  if (change !== null) {
    actions.push({
      key: "review",
      label: "Review the change",
      icon: ClipboardCheck,
      onPress: () => router.push({ pathname: "/review/[id]", params: { id: change.id } }),
    });
    actions.push({
      key: "diff",
      label: companion?.open === "diff" ? "Hide the diff" : "Diff",
      icon: FileDiff,
      active: companion?.open === "diff",
      onPress: () => openDiff(change.id),
    });
  }
  if (steer && canOpenShell) {
    actions.push({
      key: "shell",
      label: companion?.open === "terminal" ? "Hide the shell" : "Shell",
      icon: SquareTerminal,
      active: companion?.open === "terminal",
      disabled: openShell.isPending,
      onPress: openTerminal,
    });
  }
  actions.push(...extraActions);
  if (session !== undefined && agentActive && canStop) {
    actions.push({
      key: "stop",
      label: stop.isPending ? "Stopping…" : "Stop session",
      icon: CircleStop,
      tone: "danger",
      disabled: stop.isPending,
      // Never a button, and never without asking: it ends the agent (alpha 2026-10-01).
      menuOnly: true,
      onPress: () =>
        Alert.alert(
          "Stop this session?",
          "The agent ends, and Mend saves the session's work before its machine stops.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Stop session",
              style: "destructive",
              onPress: () => stop.mutate(session.id),
            },
          ],
        ),
    });
  }

  const worktree =
    session === undefined
      ? null
      : session.branch.replace(/^mend\/session\//, "session ").replace(/^mend\/(wt\/)?/, "");

  return (
    <View style={{ flex: 1 }}>
      <SessionHeader
        title={session?.label ?? session?.harness ?? "…"}
        subtitle={
          session === undefined ? null : (
            <View style={{ flexDirection: "row", alignItems: "center", overflow: "hidden" }}>
              <StatusWord
                tone={toneOf(session.status)}
                word={`${session.harness}${session.model === null || session.model === undefined ? "" : ` · ${session.model}`} · ${statusLineOf(session)}`}
                size={10.5}
              />
              <MonoText tone="faint" size={10.5} numberOfLines={1} style={{ flexShrink: 1 }}>
                {" "}
                · {worktree}
              </MonoText>
            </View>
          )
        }
        actions={actions}
        pinned={pinnedActions}
        direct={direct ?? (posture === "compact" ? 3 : 4)}
        topInset={topInset ? insets.top : 0}
      />
      {steer &&
      !(detail.isError && session !== undefined) &&
      shellError === null &&
      resumeError === null ? null : (
        <View style={{ paddingHorizontal: 16, paddingVertical: 6, gap: 4 }}>
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
          {resumeError === null ? null : (
            <MonoText tone="danger" size={11} numberOfLines={3}>
              resume · {resumeError}
            </MonoText>
          )}
        </View>
      )}
      {conversation}
    </View>
  );
}
