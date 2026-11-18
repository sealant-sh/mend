import { resumesOwnHarness } from "@mend/domain/workbench";

import type { SessionStatusDto } from "./api.ts";
import { harnessName } from "./session-view.ts";

/**
 * What Mend says around Stop session (docs/adr/0026, decision 7): the Stop dialog, built from the
 * server's `sessions.stopPreview`, and the stopped session's banner and line. The stop decides
 * again when it runs; the dialog says what Mend sees now.
 *
 * Resources (ADR 0019, such as Postgres) are not Services and don't stop with a workspace, so
 * nothing here names them.
 */

/** Another session running in the workspace, as the preview names it. */
export interface RunningSession {
  readonly sessionId: string;
  readonly title: string;
  readonly ownerUserId: string | null;
  readonly ownerName: string | null;
}

/** A live Service in the workspace, as the preview names it. */
export interface PreviewService {
  readonly name: string;
  readonly port: number;
}

/** The preview as the dialog reads it (`SessionStopPreview`). */
export interface StopPreview {
  readonly workspace: "stops" | "keeps-running" | "none";
  readonly runningSessions: ReadonlyArray<RunningSession>;
  readonly services: ReadonlyArray<PreviewService>;
}

/**
 * What runs in the session, as a sentence starts with it: the agent's name ("Claude Code"), or for
 * a `mend run` command or a shell, "The command" and "The shell".
 */
export const actorOf = (harness: string): string =>
  harness === "run" ? "The command" : harness === "shell" ? "The shell" : harnessName(harness);

/**
 * How Resume session brings a stopped session back: on its own harness (an agent with its
 * conversation, or a shell), or as a shell for a `mend run` command, which has nothing to resume
 * (`resumesOwnHarness`, `noResumeLine`).
 */
export const resumeOf = (
  harness: string,
): { readonly harness: string | null; readonly label: string } =>
  resumesOwnHarness(harness)
    ? { harness: null, label: "Resume session" }
    : { harness: "shell", label: "Resume as a shell" };

/** The session being stopped, as the dialog speaks of it. */
export interface StopSubject {
  /** What runs in it, as `actorOf` says it: "Claude Code", "The command". */
  readonly agent: string;
  readonly status: SessionStatusDto;
  /** A conversation's turn runs now, and stops with the session. */
  readonly turnRunning: boolean;
  readonly branch: string;
  /** Files in the change as Mend last counted them; null when not counted yet. */
  readonly fileCount: number | null;
}

/** A sentence part: plain words, or a name set apart (a session's title, a Service, a branch). */
export type Part =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "name"; readonly text: string }
  | { readonly kind: "mono"; readonly text: string };

export type Sentence = ReadonlyArray<Part>;

const text = (value: string): Part => ({ kind: "text", text: value });
const name = (value: string): Part => ({ kind: "name", text: value });
const mono = (value: string): Part => ({ kind: "mono", text: value });

/** "a", "a and b", "a, b and c", each item its own parts. */
const listed = (items: ReadonlyArray<Sentence>): Sentence =>
  items.flatMap((item, index) => [
    ...(index === 0 ? [] : [text(index === items.length - 1 ? " and " : ", ")]),
    ...item,
  ]);

/** A Service as the dialog names it: "api :8080". */
const serviceParts = (service: PreviewService): Sentence => [
  mono(`${service.name} :${service.port}`),
];

/** "Write tests for retry", with its owner when it isn't the viewer's: "(Grace Hopper)". */
const runningParts = (session: RunningSession, viewerId: string): Sentence => [
  name(session.title),
  ...(session.ownerUserId === viewerId || session.ownerName === null
    ? []
    : [text(` (${session.ownerName})`)]),
];

const files = (count: number) => (count === 1 ? "1 file" : `${count} files`);

/** Where the session goes once stopped: To review when its change has files, else Done. */
export const stoppedGroup = (fileCount: number | null): "review" | "done" | null =>
  fileCount === null ? null : fileCount > 0 ? "review" : "done";

/** What the Stop dialog says, from the preview (null while it is read or if it can't be). */
export interface StopWords {
  /** The first line: the agent stops, and what happens to the workspace. */
  readonly lead: Sentence;
  /** A waiting agent's question goes with the stop. */
  readonly waiting: string | null;
  /** Where the session goes and that it can be resumed. */
  readonly after: string;
  /** The workspace's own line, once the preview says what happens to it. */
  readonly workspace: Sentence | null;
  /** What stops, for the "Stops" rows; empty unless the workspace stops too. */
  readonly stops: ReadonlyArray<Sentence>;
  /** What is kept, for the "Kept" rows. */
  readonly kept: ReadonlyArray<Sentence>;
}

export const stopWords = (
  subject: StopSubject,
  preview: StopPreview | null,
  viewerId: string,
): StopWords => {
  const { agent, branch, fileCount } = subject;
  const group = stoppedGroup(fileCount);
  const after =
    group === "review"
      ? `The session moves to To review, because it changed ${files(fileCount ?? 0)}. You can resume it later from the same worktree.`
      : group === "done"
        ? "The session moves to Done, because it changed no files. You can resume it later from the same worktree."
        : "You can resume it later from the same worktree.";
  const waiting =
    subject.status === "waiting"
      ? `${agent} is waiting for your answer. Stopping drops that question.`
      : null;
  const kept: ReadonlyArray<Sentence> = [
    [
      text("The worktree "),
      mono(branch),
      ...(fileCount !== null && fileCount > 0
        ? [text(` and its ${fileCount} changed ${fileCount === 1 ? "file" : "files"}`)]
        : []),
    ],
    [text("This conversation")],
  ];
  const turn: ReadonlyArray<Sentence> = subject.turnRunning ? [[text("The current turn")]] : [];
  if (preview === null)
    return { lead: [text(`${agent} stops.`)], waiting, after, workspace: null, stops: turn, kept };
  switch (preview.workspace) {
    case "stops": {
      const services = preview.services.map(serviceParts);
      const what = services.length === 0 ? "the workspace" : "the workspace and its services";
      return {
        lead: [
          text(
            `${agent} stops. No other session is running in this workspace, so Mend stops ${what} too.`,
          ),
        ],
        waiting,
        after,
        workspace:
          services.length === 0
            ? [
                text(
                  "No other session is running in this workspace, so Mend stops the workspace too.",
                ),
              ]
            : [
                text(
                  "No other session is running in this workspace, so Mend stops the workspace and its services too: ",
                ),
                ...listed(services),
                text("."),
              ],
        stops: [
          ...turn,
          services.length === 0
            ? [text("The workspace")]
            : [text("The workspace and its services: "), ...listed(services)],
        ],
        kept,
      };
    }
    case "keeps-running": {
      const others = listed(preview.runningSessions.map((each) => runningParts(each, viewerId)));
      return {
        lead: [text(`${agent} stops. The workspace keeps running for `), ...others, text(".")],
        waiting,
        after,
        workspace: [
          text("The workspace keeps running for "),
          ...others,
          text(". Its files, services and change stay as they are."),
        ],
        stops: turn,
        kept,
      };
    }
    case "none":
      return {
        lead: [text(`${agent} stops. Nothing else is running in its workspace.`)],
        waiting,
        after,
        workspace: null,
        stops: turn,
        kept,
      };
  }
};

/** The stopped session's banner, after "This session is stopped.". */
export const stoppedWords = (
  preview: StopPreview | null,
  agent: string,
  worktreeName: string,
  viewerId: string,
): Sentence => {
  if (preview?.workspace === "keeps-running" && preview.runningSessions.length > 0)
    return [
      text(`${agent} isn't running. The files and the change stay in `),
      mono(worktreeName),
      text(", which keeps running for "),
      ...listed(preview.runningSessions.map((each) => runningParts(each, viewerId))),
      text("."),
    ];
  return [
    text(
      "The worktree, the change and this conversation are kept. Resuming starts a new workspace from the same worktree.",
    ),
  ];
};

/** What the workspace did after the stop, for the stopped line: still running for others, or not. */
const workspaceAfter = (preview: StopPreview | null): string => {
  if (preview === null) return "";
  if (preview.workspace === "keeps-running" && preview.runningSessions.length > 0)
    return ` The workspace keeps running for ${preview.runningSessions.map((each) => each.title).join(", ")}.`;
  return preview.workspace === "none" ? " The workspace has stopped." : "";
};

/** The toast once Stop session has gone through: where the session went, and who still runs. */
export const stoppedToast = (
  title: string,
  fileCount: number | null,
  preview: StopPreview | null,
): string => {
  const group = stoppedGroup(fileCount);
  const moved =
    group === null
      ? `Stopped "${title}".`
      : `Stopped "${title}" and moved it to ${group === "review" ? "To review" : "Done"}.`;
  if (preview?.workspace !== "keeps-running" || preview.runningSessions.length === 0) return moved;
  const others = preview.runningSessions.map((each) => `"${each.title}"`);
  return `${moved} ${others.join(", ")} ${others.length === 1 ? "is" : "are"} still running.`;
};

/** A stop as the session's control events record it. */
export interface StopEvent {
  readonly actorUserId: string;
  readonly kind: string;
  readonly createdAt: Date;
}

const STOP_KINDS: ReadonlySet<string> = new Set(["stop", "idle-stop", "discard-unsaved-stop"]);

const clock = (at: Date): string =>
  at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Who stopped the session and when, from its newest stop: "You stopped the session at 11:17.",
 * "Grace Hopper stopped the session at 11:20.", or Mend's own stop after the agent sat idle; then
 * what its workspace does now, from the preview. Null when no stop is recorded (an older session,
 * or one that stopped on its own).
 */
export const stoppedLine = (
  events: ReadonlyArray<StopEvent>,
  viewerId: string,
  nameOf: (userId: string) => string | null,
  preview: StopPreview | null,
): string | null => {
  const stop = events.findLast((event) => STOP_KINDS.has(event.kind));
  if (stop === undefined) return null;
  const at = clock(stop.createdAt);
  const workspace = workspaceAfter(preview);
  if (stop.kind === "idle-stop")
    return `Mend stopped the session at ${at}, after it sat idle.${workspace}`;
  const who =
    stop.actorUserId === viewerId ? "You" : (nameOf(stop.actorUserId) ?? "Someone in your team");
  return stop.kind === "discard-unsaved-stop"
    ? `${who} stopped the session at ${at} and discarded what wasn't saved.${workspace}`
    : `${who} stopped the session at ${at}.${workspace}`;
};

/** Whether Stop session is offered: the agent is live, and the viewer may stop it. */
export const offersStop = (agentLive: boolean, status: SessionStatusDto, canStop: boolean) =>
  canStop && agentLive && status !== "stopping";
