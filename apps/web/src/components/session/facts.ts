import { startsInTerminal, takesReviewFollowUp } from "@mend/domain/workbench";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import type { Tone } from "#/components/kit/status";
import { agentIsLive, type SessionStatusDto } from "#/lib/api";
import { sessionTitle } from "#/lib/inbox";
import { harnessName } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";
import { useViewerState } from "#/lib/viewer";

/** Who holds a screen's input has no event of its own, so a session whose screen runs reads it often. */
const SCREEN_READ_MS = 3_000;

/** The session's status as a dot and a word (DESIGN.md §4): what Mend observed, never a verdict. */
export const sessionStatusWord = (
  status: SessionStatusDto,
): { readonly tone: Tone; readonly word: string } => {
  switch (status) {
    case "starting":
      return { tone: "off", word: "starting" };
    case "running":
      return { tone: "run", word: "running" };
    case "waiting":
      return { tone: "wait", word: "waiting for input" };
    case "idle":
      return { tone: "off", word: "idle" };
    case "stopping":
      return { tone: "off", word: "stopping" };
    case "completed":
      return { tone: "ok", word: "completed" };
    case "failed":
      return { tone: "bad", word: "failed" };
    case "stopped":
      return { tone: "off", word: "stopped" };
  }
};

/**
 * What every part of the session view reads about the session: the detail the route loaded, who
 * is looking, and what the agent is. Each read is a cached query, so any part may call this.
 * The roster arrives on its own; until it has, `names` is undefined and a line that needs a name
 * says nothing yet, never the not-the-owner view.
 */
export const useSessionFacts = (sessionId: string) => {
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.sessions.detail.queryOptions({ id: sessionId })).data;
  const { session, control, currentAgent } = detail;
  const viewer = useViewerState();
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { retry: false }));
  const names = members.isPending
    ? undefined
    : new Map((members.data ?? []).map((member) => [member.userId, member.name]));
  const ownerName =
    session.ownerUserId === null ? null : (names?.get(session.ownerUserId) ?? "its owner");
  const project = useQuery(
    trpc.projects.list.queryOptions(undefined, {
      select: (projects) => projects.find((row) => row.id === session.projectId) ?? null,
    }),
  ).data;
  const projectDetail = useQuery(trpc.projects.detail.queryOptions({ id: session.projectId })).data;
  // Anyone who can see the session watches its screen (docs/adr/0020, D2). A session without one
  // has none to show, and its session events read the answer again.
  const screenRead = useQuery(
    trpc.screens.read.queryOptions(
      { id: sessionId },
      {
        retry: false,
        // Only a screen that runs (or starts) changes hands; an ended one waits for the session
        // events that say it woke.
        refetchInterval: (query) => {
          const read = query.state.data;
          return read?._tag === "Screen" &&
            (read.life._tag === "Live" || read.life._tag === "Starting")
            ? SCREEN_READ_MS
            : false;
        },
      },
    ),
  );
  const screen = screenRead.data?._tag === "Screen" ? screenRead.data : null;
  // Why this session's own workspace image has no screen, when it has none: a custom image never
  // has one, one of Mend's images only when it was built with Screen on. Null when it can have
  // one, or before the image is recorded. It is the session's image, which may predate the
  // project's settings now.
  const image = session.workspaceImage;
  const imageWithoutScreen: "custom" | "built-without" | null =
    image === null
      ? null
      : image.mode === "custom"
        ? "custom"
        : image.screen
          ? null
          : "built-without";
  // The agent's liveness, not the session fold: a shell holding the workspace keeps the session
  // `idle`, but the terminal, stop, and resume controls are about the AGENT.
  const agentLive = agentIsLive(session, currentAgent);
  const agentPty = currentAgent?.sealantSessionId ?? session.sealantSessionId;
  // A live conversation (agent-protocol) has no terminal of its own; its messages go in the input.
  const conversationLive = agentLive && !startsInTerminal(currentAgent?.kind ?? null);
  // A stopped conversation the next message brings back: its agent ran as a conversation and
  // its harness is an agent's. The server resumes it as it takes the message.
  const conversationResumes =
    !agentLive &&
    currentAgent !== null &&
    !startsInTerminal(currentAgent.kind) &&
    takesReviewFollowUp(session.harness) &&
    session.status !== "starting" &&
    session.status !== "stopping";
  return {
    detail,
    session,
    control,
    viewer,
    names,
    ownerName,
    project: project ?? null,
    projectDetail,
    title: sessionTitle(session, projectDetail),
    agent: harnessName(session.harness),
    /** An agent runs here (codex, claude…), not a command of `mend run` or a shell. */
    agentHarness: takesReviewFollowUp(session.harness),
    screen,
    screenRead,
    imageWithoutScreen,
    agentLive,
    agentPty,
    conversationLive,
    conversationResumes,
    status: sessionStatusWord(session.status),
    nameOf: (userId: string) => names?.get(userId) ?? "a member",
  };
};

export type SessionFacts = ReturnType<typeof useSessionFacts>;

/**
 * Who has the screen's input, in words (screens P4 and P4b): the agent, this viewer, another
 * person, or nobody while it is paused. Null when the session has no live screen.
 */
export const screenDriver = (
  facts: Pick<SessionFacts, "screen" | "agent" | "viewer" | "nameOf">,
): string | null => {
  const screen = facts.screen;
  if (screen === null || screen.life._tag !== "Live") return null;
  switch (screen.holder._tag) {
    case "Agent":
      return screen.holder.awaiting
        ? `${facts.agent} takes the input at its next look`
        : `${facts.agent} is driving`;
    case "Person":
      return screen.holder.userId === facts.viewer?.userId
        ? "You are driving"
        : `${facts.nameOf(screen.holder.userId)} is driving`;
    case "Paused":
      return "Input paused";
  }
};
