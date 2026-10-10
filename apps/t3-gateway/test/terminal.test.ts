import { assert, describe, it } from "@effect/vitest";
import {
  WS_METHODS,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import { ttyUrlOf } from "../src/terminals.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * The terminal (ADR 0012, phase 3): Mend's shell beside the agent, over `/api/tty`, opened with a
 * single-use `tty` ticket, as the person and under Mend's rules.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

type Attach = TerminalAttachStreamEvent;
const CWD = "/var/lib/mend/store/project-1/worktrees/wt-session-1";

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const tagOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;
};

const setup = (
  mend: FakeMend,
  options: { readonly steer?: boolean; readonly live?: boolean } = {},
) => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({
    id: "session-1",
    projectId: "project-1",
    ...(options.steer === undefined ? {} : { steer: options.steer }),
    ...(options.live === undefined ? {} : { live: options.live }),
  });
};

describe("the terminal", () => {
  it.live("opens Mend's shell with a ticket spent once, and carries what is typed and shown", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "TERMINAL");
        const metadata = yield* feed(rpc[WS_METHODS.subscribeTerminalMetadata]({}));
        yield* metadata.next(
          (event): event is Extract<TerminalMetadataStreamEvent, { type: "snapshot" }> =>
            event.type === "snapshot",
        );

        const opened = yield* rpc[WS_METHODS.terminalOpen]({
          threadId: "session-1",
          terminalId: "term-1",
          cwd: CWD,
          cols: 120,
          rows: 30,
        });
        assert.strictEqual(opened.status, "running");
        assert.strictEqual(mend.tty.shells.size, 1);
        assert.deepStrictEqual(mend.tty.upgrades, ["accepted"]);
        assert.isTrue(Array.from(mend.tty.tickets.values()).every((ticket) => ticket.spent));
        yield* eventually(() => mend.tty.resizes.length === 1, "the first resize");
        assert.deepStrictEqual(mend.tty.resizes[0], { cols: 120, rows: 30 });
        yield* metadata.next(
          (event): event is Extract<TerminalMetadataStreamEvent, { type: "upsert" }> =>
            event.type === "upsert" && event.terminal.status === "running",
        );

        const attached = yield* feed(
          rpc[WS_METHODS.terminalAttach]({ threadId: "session-1", terminalId: "term-1" }),
        );
        yield* attached.next(
          (event): event is Extract<Attach, { type: "snapshot" }> => event.type === "snapshot",
        );
        yield* rpc[WS_METHODS.terminalWrite]({
          threadId: "session-1",
          terminalId: "term-1",
          data: "ls\n",
        });
        yield* attached.next(
          (event): event is Extract<Attach, { type: "output" }> =>
            event.type === "output" && event.data === "ls\n",
        );
        assert.deepStrictEqual(mend.tty.typed, ["ls\n"]);
        yield* rpc[WS_METHODS.terminalResize]({
          threadId: "session-1",
          terminalId: "term-1",
          cols: 80,
          rows: 24,
        });
        yield* eventually(() => mend.tty.resizes.length === 2, "the resize");

        // A restart is a new shell, and a new ticket: none is ever used twice.
        yield* rpc[WS_METHODS.terminalRestart]({
          threadId: "session-1",
          terminalId: "term-1",
          cwd: CWD,
          cols: 80,
          rows: 24,
        });
        assert.strictEqual(mend.tty.tickets.size, 2);
        assert.deepStrictEqual(mend.tty.upgrades, ["accepted", "accepted"]);

        // Mend ends the shell: the terminal has exited.
        mend.tty.end("shell-2");
        yield* attached.next(
          (event): event is Extract<Attach, { type: "exited" }> => event.type === "exited",
        );

        yield* rpc[WS_METHODS.terminalClose]({
          threadId: "session-1",
          terminalId: "term-1",
          deleteHistory: true,
        });
        yield* metadata.next(
          (event): event is Extract<TerminalMetadataStreamEvent, { type: "remove" }> =>
            event.type === "remove",
        );
        const gone = yield* Effect.exit(
          rpc[WS_METHODS.terminalWrite]({ threadId: "session-1", terminalId: "term-1", data: "x" }),
        );
        assert.strictEqual(tagOf(gone), "TerminalSessionLookupError");
      }),
    ),
  );

  it.live(
    "opens one shell for two opens of one terminal at once, and close ends it (607-R2-1)",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "TTY-TWICE");
          const open = () =>
            rpc[WS_METHODS.terminalOpen]({ threadId: "session-1", terminalId: "term", cwd: CWD });
          // Before, the second replaced the first's acquisition and its shell ran on untracked.
          yield* Effect.all([open(), open()], { concurrency: 2 });
          assert.strictEqual(mend.tty.shells.size, 1);
          yield* rpc[WS_METHODS.terminalClose]({
            threadId: "session-1",
            terminalId: "term",
            deleteHistory: true,
          });
          yield* eventually(
            () => Array.from(mend.tty.shells.values()).every((shell) => !shell.running),
            "every shell stopped",
          );
        }),
      ),
  );

  it.live("a close that comes while a terminal is opening ends what the open brings up", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "TTY-CLOSE-EARLY");
        const opening = yield* Effect.forkChild(
          rpc[WS_METHODS.terminalOpen]({ threadId: "session-1", terminalId: "term", cwd: CWD }),
        );
        yield* eventually(() => mend.tty.shells.size === 1, "the shell asked for");
        yield* rpc[WS_METHODS.terminalClose]({ threadId: "session-1", terminalId: "term" });
        yield* Fiber.await(opening);
        yield* eventually(
          () => Array.from(mend.tty.shells.values()).every((shell) => !shell.running),
          "every shell stopped",
        );
      }),
    ),
  );

  it.live("is refused, as Mend refuses it, to whoever does not own the session", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend, { steer: false });
        const { rpc } = yield* pairAndConnect(mend, "NOT-OWNER");
        const exit = yield* Effect.exit(
          rpc[WS_METHODS.terminalOpen]({ threadId: "session-1", terminalId: "term-1", cwd: CWD }),
        );
        assert.strictEqual(tagOf(exit), "EnvironmentAuthorizationError");
        assert.strictEqual(mend.tty.tickets.size, 0);
      }),
    ),
  );

  it.live("says the terminal is not running when the session's workspace is not", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend, { live: false });
        const { rpc } = yield* pairAndConnect(mend, "STOPPED");
        const exit = yield* Effect.exit(
          rpc[WS_METHODS.terminalOpen]({ threadId: "session-1", terminalId: "term-1", cwd: CWD }),
        );
        assert.strictEqual(tagOf(exit), "TerminalNotRunningError");
        const unknown = yield* Effect.exit(
          rpc[WS_METHODS.terminalOpen]({ threadId: "nobody", terminalId: "term-1", cwd: CWD }),
        );
        assert.strictEqual(tagOf(unknown), "TerminalSessionLookupError");
      }),
    ),
  );
});

describe("the terminal socket", () => {
  it.live("stops the shell it opened when the ticket fails, and keeps no terminal of it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        mend.tty.ticketFailures = 1;
        const { rpc } = yield* pairAndConnect(mend, "TICKET-DOWN");
        const exit = yield* Effect.exit(
          rpc[WS_METHODS.terminalOpen]({ threadId: "session-1", terminalId: "term-1", cwd: CWD }),
        );
        assert.isTrue(Exit.isFailure(exit));
        // Mend opened the shell before the ticket failed: it is stopped, not left running.
        assert.strictEqual(mend.tty.shells.size, 1);
        assert.isFalse(Array.from(mend.tty.shells.values()).some((shell) => shell.running));
        // A second try opens a fresh shell, and only that one runs.
        const opened = yield* rpc[WS_METHODS.terminalOpen]({
          threadId: "session-1",
          terminalId: "term-1",
          cwd: CWD,
        });
        assert.strictEqual(opened.status, "running");
        assert.strictEqual(
          Array.from(mend.tty.shells.values()).filter((shell) => shell.running).length,
          1,
        );
      }),
    ),
  );

  it.live("stops every shell and socket of the person's terminals when their hub goes", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      yield* Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "HUB-GOES");
            const opened = yield* rpc[WS_METHODS.terminalOpen]({
              threadId: "session-1",
              terminalId: "term-1",
              cwd: CWD,
            });
            assert.strictEqual(opened.status, "running");
          }),
        );
        // The client is gone; the hub outlives it briefly, then goes, and its terminals with it.
        yield* eventually(
          () => !Array.from(mend.tty.shells.values()).some((shell) => shell.running),
          "the shell to be stopped",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayTestLayer(mend.url, ":memory:", { hubIdleTimeToLive: "100 millis" })),
      );
    }),
  );

  it("is Mend's /api/tty on its origin, as a WebSocket URL, for exactly the process", () => {
    assert.strictEqual(
      ttyUrlOf(new URL("https://mend.example/"), "shell-1", "tkt"),
      "wss://mend.example/api/tty?ticket=tkt&process=shell-1",
    );
    assert.strictEqual(
      ttyUrlOf(new URL("http://127.0.0.1:3101"), "shell-1", "tkt"),
      "ws://127.0.0.1:3101/api/tty?ticket=tkt&process=shell-1",
    );
  });
});
