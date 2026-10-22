import {
  openFolderOptions,
  reduceOpen,
  workspaceNeed,
  type OpenAction,
  type OpenEvent,
  type OpenFolderOptions,
  type OpenMode,
  type OpenState,
} from "./open-flow.js";
import { notYoursOffer, type NotYoursOffer, type RowCapability } from "./session-capability.js";
import { displaySession } from "./session-lines.js";
import type { Project, Session } from "./types.js";
import type { WindowRole } from "./window-role.js";

export interface OpenTarget {
  readonly session: Session;
  readonly project: Project;
}

export type OpenOutcome = "opened" | "focused" | "cancelled" | "failed" | "refused";

/** Everything an open does to the world, injected so the run itself stays pure. */
export interface OpenEffects {
  /** What the viewer may do with the session, by the row's rule, from a fresh read of who she is. */
  readonly capability: (session: Session) => Promise<RowCapability>;
  /**
   * Says once why the session does not open for this viewer and offers what helps instead. It
   * waits on her, so it runs on its own and the open settles at once.
   */
  readonly refuse: (target: OpenTarget, why: string, offer: NotYoursOffer) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly thisWindow: () => WindowRole;
  /** This window already is the session's workspace: show that session's agent. */
  readonly focusAgentTerminal: (sessionId: string) => Promise<void>;
  /** A second gesture while an open runs shows the first one's progress. */
  readonly focusProgress: (sessionId: string) => void;
  readonly remoteSshInstalled: () => boolean;
  /** Resolves once the extension is present. */
  readonly installRemoteSsh: () => Promise<void>;
  readonly workspaceSsh: () => Promise<"ready" | "needsSetup">;
  /** What she consented to for this server's Host block. */
  readonly sshConsent: () => Promise<"given" | "never">;
  /** The one question an open may ask: first-run setup was skipped for this server. */
  readonly askSshConsent: () => Promise<boolean>;
  /** Registers the key, writes the Host block, records consent, seeds the platform. */
  readonly setUpWorkspaceSsh: () => Promise<void>;
  /** Idempotent; runs before every openFolder so Remote-SSH never asks for the platform. */
  readonly seedRemotePlatform: () => Promise<void>;
  /** POST /sessions/:id/resume {harness:"shell"}. */
  readonly resume: (sessionId: string) => Promise<void>;
  /** The session as the server reads it now: the tree's row may be stale. */
  readonly sessionNow: (sessionId: string) => Promise<Session>;
  /** Opens the workspace's folder; the window it lands in attaches `sessionId`'s agent. */
  readonly openFolder: (
    target: { readonly workspaceId: string; readonly sessionId: string },
    options: OpenFolderOptions,
  ) => Promise<void>;
  readonly render: (sessionId: string, sessionName: string, state: OpenState) => void;
  /**
   * The one error toast; resolves with the action she picked. `cause` is what failed, null when
   * nothing threw: a refused sign-in says so in its own words.
   */
  readonly report: (
    sessionId: string,
    reason: string,
    action: OpenAction | null,
    cause: unknown,
  ) => Promise<OpenAction | undefined>;
}

interface Failure {
  readonly reason: string;
  readonly action: OpenAction | null;
  readonly cause: unknown;
}

interface Settled {
  readonly outcome: OpenOutcome;
  readonly failure: Failure | null;
}

interface Denied {
  readonly kind: "denied";
  readonly session: Session;
  readonly capability: Exclude<RowCapability, { readonly kind: "open" }>;
}

type Read = { readonly kind: "session"; readonly session: Session } | Denied;

type Workspace =
  | { readonly kind: "have"; readonly workspaceId: string }
  | { readonly kind: "timedOut" }
  | Denied;

const RETRY: OpenAction = "Retry";

const reasonOf = (cause: unknown, sessionName: string): string =>
  cause instanceof Error && cause.message !== ""
    ? cause.message
    : `Mend could not open ${sessionName}.`;

/** Opens a session's workspace in VS Code, one open in flight per session. */
export class OpenRunner {
  readonly #inFlight = new Map<string, Promise<OpenOutcome>>();
  readonly #workspaceWaitMs: number;
  readonly #pollMs: number;

  constructor(
    private readonly effects: OpenEffects,
    options: { readonly workspaceWaitMs?: number; readonly pollMs?: number } = {},
  ) {
    this.#workspaceWaitMs = options.workspaceWaitMs ?? 10 * 60 * 1000;
    this.#pollMs = options.pollMs ?? 2000;
  }

  /** A second call for a session whose open runs joins it: never a second resume or window. */
  open(target: OpenTarget, mode: OpenMode): Promise<OpenOutcome> {
    const id = target.session.id;
    const running = this.#inFlight.get(id);
    if (running !== undefined) {
      this.effects.focusProgress(id);
      return running;
    }
    const run = this.#run(target, mode).then(({ outcome, failure }) => {
      this.#inFlight.delete(id);
      // The toast waits on her, so the open settles first and a retry is a run of its own.
      if (failure !== null) void this.#offer(target, mode, failure);
      return outcome;
    });
    this.#inFlight.set(id, run);
    return run;
  }

  async #run(target: OpenTarget, mode: OpenMode): Promise<Settled> {
    const { effects } = this;
    const id = target.session.id;
    const name = displaySession(target.session);
    let state: OpenState = { kind: "idle" };
    const fire = (event: OpenEvent): void => {
      state = reduceOpen(state, event);
      effects.render(id, name, state);
    };
    const deny = ({ session, capability }: Denied): Settled => {
      if (state.kind !== "idle") fire({ kind: "cancelled" });
      if (capability.kind === "notYours") {
        effects.refuse({ ...target, session }, capability.why, notYoursOffer(capability));
        return { outcome: "refused", failure: null };
      }
      const failure = {
        reason: `${capability.why}, so it did not open ${name}`,
        action: RETRY,
        cause: null,
      };
      fire({ kind: "failed", ...failure });
      return { outcome: "failed", failure };
    };
    let action: OpenAction = RETRY;
    try {
      const first = await this.#read(id);
      if (first.kind === "denied") return deny(first);
      // Setting up can take a while; the session is read again after it.
      let prepared = false;
      const needsSetup = (await effects.workspaceSsh()) === "needsSetup";
      if (needsSetup && (await effects.sshConsent()) === "never") {
        fire({ kind: "consent" });
        if (!(await effects.askSshConsent())) {
          fire({ kind: "cancelled" });
          return { outcome: "cancelled", failure: null };
        }
      }
      if (!effects.remoteSshInstalled()) {
        prepared = true;
        fire({ kind: "step", step: { kind: "installingRemoteSsh" }, at: effects.now() });
        await effects.installRemoteSsh();
      }
      if (needsSetup) {
        fire({ kind: "step", step: { kind: "settingUpWorkspaceSsh" }, at: effects.now() });
        prepared = true;
        action = "Set up";
        await effects.setUpWorkspaceSsh();
        action = RETRY;
      }
      await effects.seedRemotePlatform();
      const ready = prepared ? await this.#read(id) : first;
      if (ready.kind === "denied") return deny(ready);
      const workspace = await this.#workspace(ready.session, fire);
      if (workspace.kind === "denied") return deny(workspace);
      if (workspace.kind === "timedOut") {
        const failure = {
          reason: `${name}'s workspace did not start in time`,
          action,
          cause: null,
        };
        fire({ kind: "failed", ...failure });
        return { outcome: "failed", failure };
      }
      const role = effects.thisWindow();
      // VS Code keeps one window per folder: asked for a new window on the folder this window
      // already holds, Open in New Window included, it would only focus this one.
      if (role.kind === "workspace" && role.workspaceId === workspace.workspaceId) {
        fire({ kind: "opened" });
        await effects.focusAgentTerminal(id);
        return { outcome: "focused", failure: null };
      }
      fire({ kind: "workspace", workspaceId: workspace.workspaceId });
      await effects.openFolder(
        { workspaceId: workspace.workspaceId, sessionId: id },
        openFolderOptions(mode),
      );
      fire({ kind: "opened" });
      return { outcome: "opened", failure: null };
    } catch (cause) {
      const failure = { reason: reasonOf(cause, name), action, cause };
      fire({ kind: "failed", ...failure });
      return { outcome: "failed", failure };
    }
  }

  /**
   * The session as the server reads it now, and whether this viewer may still open it: who
   * launched the workspace can change while an open waits, and Remote-SSH admits only them.
   */
  async #read(id: string): Promise<Read> {
    const session = await this.effects.sessionNow(id);
    const capability = await this.effects.capability(session);
    return capability.kind === "open"
      ? { kind: "session", session }
      : { kind: "denied", session, capability };
  }

  /**
   * The session's workspace id, waited for. Each read decides again whether it needs a resume (a
   * session read as stopping is stopped by a later read), and this run sends at most one.
   */
  async #workspace(first: Session, fire: (event: OpenEvent) => void): Promise<Workspace> {
    const { effects } = this;
    let current = first;
    let resumed = false;
    let waiting = false;
    const deadline = effects.now() + this.#workspaceWaitMs;
    for (;;) {
      const need = workspaceNeed(current);
      if (need === "have" && current.sealantWorkspaceId !== null) {
        return { kind: "have", workspaceId: current.sealantWorkspaceId };
      }
      if (need === "resume" && !resumed) {
        fire({ kind: "step", step: { kind: "resuming" }, at: effects.now() });
        await effects.resume(first.id);
        resumed = true;
        waiting = false;
      }
      if (!waiting) {
        fire({ kind: "waiting", at: effects.now() });
        waiting = true;
      }
      if (effects.now() >= deadline) return { kind: "timedOut" };
      await effects.sleep(this.#pollMs);
      const read = await this.#read(first.id);
      if (read.kind === "denied") return read;
      current = read.session;
    }
  }

  async #offer(target: OpenTarget, mode: OpenMode, failure: Failure): Promise<void> {
    const chosen = await this.effects.report(
      target.session.id,
      failure.reason,
      failure.action,
      failure.cause,
    );
    if (chosen === "Set up") {
      try {
        await this.effects.setUpWorkspaceSsh();
      } catch (cause) {
        await this.#offer(target, mode, {
          reason: reasonOf(cause, displaySession(target.session)),
          action: "Set up",
          cause,
        });
        return;
      }
    }
    if (chosen !== undefined) await this.open(target, mode);
  }
}
