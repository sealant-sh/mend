import {
  isOrchestrationV2WorkActive,
  OrchestrationV2CommandOutputError,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2RunStatus,
  type OrchestrationV2SubscribeCommandOutputInput,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@mend/t3-contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  TERMINAL_OUTPUT_TAIL_CHARS,
  terminalOutputResumeText,
} from "@mend/t3-contracts/terminal-output";
import { Effect, Stream } from "effect";

import type { PersonHub, ThreadChange } from "./hub.ts";

type Command = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
const MAX_SOURCE_CHARS = TERMINAL_OUTPUT_TAIL_CHARS * 4;
const MAX_APPEND_CHARS = 16 * 1024;

const stopped = (status: OrchestrationV2RunStatus | undefined): boolean =>
  status === "interrupted" ||
  status === "cancelled" ||
  status === "failed" ||
  status === "rolled_back";

const commandOf = (
  projection: OrchestrationV2ThreadProjection,
  itemId: string,
): Command | undefined => {
  const item = projection.turnItems.find((candidate) => candidate.id === itemId);
  return item?.type === "command_execution" ? item : undefined;
};

/** Bound normalization work before parsing terminal escapes, as T3's persisted-output reader does. */
const terminalState = (output: string) => {
  let source = output;
  if (source.length > MAX_SOURCE_CHARS) {
    source = source.slice(-MAX_SOURCE_CHARS);
    const newline = source.indexOf("\n");
    if (newline !== -1 && newline + 1 < source.length) source = source.slice(newline + 1);
  }
  const state = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, source);
  return { ...state, truncated: state.truncated || source.length < output.length };
};

/**
 * Serve one expanded command from the person's existing thread watch. The watch owns visibility,
 * replay and item reads; this module owns terminal tails and the command stream's lifetime.
 */
export const subscribeCommandOutput = (
  hub: Pick<PersonHub, "subscribeThread" | "threadSnapshot">,
  target: OrchestrationV2SubscribeCommandOutputInput,
): Stream.Stream<OrchestrationV2CommandOutputFrame, OrchestrationV2CommandOutputError> => {
  const failure = (message: string) =>
    new OrchestrationV2CommandOutputError({ threadId: target.threadId, message });
  return Stream.unwrap(
    Effect.gen(function* () {
      const subscribed = yield* hub.subscribeThread(target.threadId);
      if (subscribed === null || subscribed.start.kind !== "snapshot")
        return yield* failure("No such command.");
      const opening = subscribed.start.snapshot.projection;
      const first = commandOf(opening, target.itemId);
      if (first === undefined) return yield* failure("No such command.");
      let command = first;
      let runStatus = opening.runs.find((run) => run.id === first.runId)?.status;
      let previous: string | undefined;
      let terminal = EMPTY_TERMINAL_OUTPUT;

      const observeSnapshot = (projection: OrchestrationV2ThreadProjection) => {
        const item = commandOf(projection, target.itemId);
        if (item === undefined) return false;
        command = item;
        runStatus = projection.runs.find((run) => run.id === item.runId)?.status;
        return true;
      };
      const frame = (): OrchestrationV2CommandOutputFrame | null => {
        const output = command.output ?? previous ?? "";
        const running = isOrchestrationV2WorkActive(command.status) && !stopped(runStatus);
        const initial = previous === undefined;
        if (!initial && output === previous && running) return null;
        const appending = previous !== undefined && output.startsWith(previous);
        const delta = appending ? output.slice(previous?.length) : output;
        const replace = initial || !running || !appending || delta.length > MAX_APPEND_CHARS;
        terminal =
          appending && delta.length <= MAX_APPEND_CHARS
            ? appendTerminalOutput(terminal, delta)
            : terminalState(output);
        previous = output;
        return {
          kind: replace ? "replace" : "append",
          text: replace ? (running ? terminalOutputResumeText(terminal) : terminal.text) : delta,
          truncated: terminal.truncated,
          running,
        };
      };
      const initial = frame();
      const observe = (change: ThreadChange) =>
        Effect.gen(function* () {
          if (change.kind === "snapshot") {
            if (!observeSnapshot(change.projection))
              return yield* failure("The command is no longer available.");
          } else if (
            change.event.type === "turn-item.updated" &&
            change.event.payload.id === target.itemId
          ) {
            if (change.event.payload.type !== "command_execution")
              return yield* failure("The command is no longer available.");
            command = change.event.payload;
          } else if (
            change.event.type === "run.updated" &&
            change.event.payload.id === command.runId
          ) {
            runStatus = change.event.payload.status;
            if (stopped(runStatus)) {
              // A single publish can contain both a terminal run and its final tool output.
              // Read that whole projection before ending, rather than stopping between its events.
              const snapshot = yield* hub.threadSnapshot(target.threadId);
              if (snapshot === null || !observeSnapshot(snapshot.projection))
                return yield* failure("The command is no longer available.");
            }
          } else return null;
          return frame();
        });
      return Stream.fromIterable(initial === null ? [] : [initial]).pipe(
        Stream.concat(
          subscribed.changes.pipe(
            Stream.mapEffect(observe),
            Stream.filter((next) => next !== null),
          ),
        ),
        Stream.takeUntil((next) => !next.running),
      );
    }),
  ).pipe(
    Stream.scoped,
    // A fresh subscription starts with a whole replacement tail, preserving terminal state.
    Stream.catchTag("SubscriberFellBehind", () => subscribeCommandOutput(hub, target)),
    Stream.mapError((error) =>
      error instanceof OrchestrationV2CommandOutputError ? error : failure(error.message),
    ),
  );
};
