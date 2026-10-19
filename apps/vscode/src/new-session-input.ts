import * as path from "node:path";

import * as vscode from "vscode";

import { MendApiError, normalizeProjectName, type MendClient } from "./client.js";
import { checkoutFact } from "./git.js";
import type { Launches } from "./launches.js";
import {
  isRememberedOptions,
  keptAfter,
  keptPromptKey,
  openFlow,
  remember,
  render,
  REMEMBERED_OPTIONS_KEY,
  step,
  type CheckoutFact,
  type FlowEffect,
  type FlowEvent,
  type FlowFacts,
  type FlowState,
  type JoinTarget,
  type QuickInputView,
  type RememberedOptions,
} from "./new-session.js";
import { joinLineOf } from "./session-lines.js";
import type { SessionStore } from "./session-store.js";
import type { Project } from "./types.js";

interface Item extends vscode.QuickPickItem {
  readonly id: string;
}

const CHANGE_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("settings-gear"),
  tooltip: "Change…",
};

const ELSEWHERE: CheckoutFact = { kind: "elsewhere" };

const words = (cause: unknown): string =>
  cause instanceof MendApiError || cause instanceof Error
    ? cause.message
    : "Mend could not complete that action.";

/** Where New session opens: a project a row named (or none), and the worktree it joins. */
export interface NewSessionOpening {
  readonly project: Project | null;
  readonly join: JoinTarget | null;
}

/**
 * Mend: New session's one quick input. It maps `render`'s view onto a `vscode.QuickPick` and the
 * QuickPick's events into `step`, and carries out the effects: remember a pick, adopt, start.
 */
export class NewSessionInput implements vscode.Disposable {
  /** Prompts typed and not started, per server URL: they live as long as this window. */
  readonly #kept = new Map<string, ReadonlyMap<string, string>>();
  #open: vscode.Disposable | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: MendClient,
    private readonly store: SessionStore,
    private readonly launches: Launches,
  ) {}

  dispose(): void {
    this.#open?.dispose();
  }

  #remembered(): RememberedOptions {
    const stored = this.context.globalState.get<unknown>(REMEMBERED_OPTIONS_KEY);
    return isRememberedOptions(stored) ? stored : {};
  }

  async open(opening: NewSessionOpening): Promise<void> {
    this.#open?.dispose();
    const server = (await this.client.connection()).url;
    const matched = this.store.windowProject();
    const unmatched = this.store.unmatchedRepository();
    const project = opening.project ?? matched?.project ?? null;
    const windowCheckout =
      matched !== null
        ? await checkoutFact(matched.folder)
        : unmatched !== null
          ? await checkoutFact(unmatched.folder)
          : ELSEWHERE;
    const details = this.store.details();
    const joined =
      opening.join === null || project === null
        ? []
        : (details.find((detail) => detail.project.id === project.id)?.sessions ?? []);
    let facts: FlowFacts = {
      projects: details.map((detail) => detail.project),
      adoptable:
        project === null && unmatched !== null
          ? {
              origin: unmatched.originUrl,
              name: normalizeProjectName(
                path.posix.basename(unmatched.originUrl.replace(/\.git$/, "").replace(/:/g, "/")),
              ),
            }
          : null,
      checkout: windowCheckout,
      catalogs: [],
      remembered: this.#remembered()[server] ?? {},
      kept: this.#kept.get(server) ?? new Map(),
      joinLine:
        opening.join === null
          ? null
          : await joinLineOf(joined, opening.join.worktreeId, this.store.viewer(), this.client),
    };
    let state: FlowState = openFlow(
      {
        project,
        join: opening.join,
        checkout:
          opening.join === null && project !== null && project.id === matched?.project.id
            ? windowCheckout
            : ELSEWHERE,
        offline: this.store.model()?.offline ?? false,
      },
      facts,
    );

    const input = vscode.window.createQuickPick<Item>();
    input.ignoreFocusOut = true;
    let shownItems = "";
    const show = (view: QuickInputView): void => {
      input.title = view.title;
      input.step = view.step?.n;
      input.totalSteps = view.step?.total;
      input.placeholder = view.placeholder;
      input.busy = view.busy;
      input.enabled = !view.busy;
      input.buttons = view.back ? [vscode.QuickInputButtons.Back] : [];
      if (input.value !== view.value) input.value = view.value;
      const items = JSON.stringify(view.items);
      if (items === shownItems) return;
      shownItems = items;
      input.items = view.items.map((item) => ({
        id: item.id,
        label: item.label,
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.alwaysShow === true ? { alwaysShow: true } : {}),
        ...(item.change === true ? { buttons: [CHANGE_BUTTON] } : {}),
      }));
      const current = input.items.filter((_item, index) => view.items[index]?.current === true);
      if (current.length > 0) input.activeItems = current;
    };

    const dispatch = (event: FlowEvent): void => {
      const next = step(state, event, facts);
      state = next.state;
      const kept = keptAfter(facts.kept, state, next.effect);
      this.#kept.set(server, kept);
      facts = { ...facts, kept };
      facts = this.#carryOut(next.effect, facts, server, dispatch);
      if (next.effect.kind === "start") input.hide();
      else show(render(state, facts));
    };

    const subscriptions = [
      input,
      input.onDidChangeValue((value) => dispatch({ kind: "typed", value })),
      input.onDidAccept(() => {
        if (input.value !== render(state, facts).value)
          dispatch({ kind: "typed", value: input.value });
        dispatch({
          kind: "accept",
          item: input.activeItems[0]?.id ?? input.selectedItems[0]?.id ?? "",
        });
      }),
      input.onDidTriggerItemButton(() => dispatch({ kind: "change" })),
      input.onDidTriggerButton((button) => {
        if (button === vscode.QuickInputButtons.Back) dispatch({ kind: "back" });
      }),
      this.store.onDidChange(({ next }) => {
        if (next.offline !== state.offline) dispatch({ kind: "connection", offline: next.offline });
      }),
      input.onDidHide(() => close.dispose()),
    ];
    const close = new vscode.Disposable(() => {
      for (const subscription of subscriptions) subscription.dispose();
      if (this.#open === close) this.#open = null;
    });
    this.#open = close;
    show(render(state, facts));
    input.show();
    // The model and thinking steps wait for the catalog; the prompt does not.
    const catalogs = await this.client.harnessModels().catch(() => null);
    if (catalogs === null || this.#open !== close) return;
    facts = { ...facts, catalogs };
    show(render(state, facts));
  }

  /** The effect's work; the facts it changed come back. */
  #carryOut(
    effect: FlowEffect,
    facts: FlowFacts,
    server: string,
    dispatch: (event: FlowEvent) => void,
  ): FlowFacts {
    switch (effect.kind) {
      case "none":
        return facts;
      case "remember": {
        const all = remember(this.#remembered(), server, effect.projectId, effect.options);
        void this.context.globalState.update(REMEMBERED_OPTIONS_KEY, all);
        return { ...facts, remembered: all[server] ?? {} };
      }
      case "adopt":
        void this.#adopt(effect, dispatch);
        return facts;
      case "start":
        void this.#start(effect, server);
        return facts;
    }
  }

  /** `POST /projects` clones while the input is busy, then New session goes on in the project. */
  async #adopt(
    effect: Extract<FlowEffect, { readonly kind: "adopt" }>,
    dispatch: (event: FlowEvent) => void,
  ): Promise<void> {
    try {
      const project = await this.client.adoptProject(effect.name, effect.origin);
      this.store.refresh();
      dispatch({ kind: "adopted", project });
    } catch (cause) {
      dispatch({ kind: "adoptFailed" });
      void vscode.window.showErrorMessage(`Mend could not adopt ${effect.name} · ${words(cause)}`);
    }
  }

  /** Create, show the row, launch without waiting: the server holds a launch up to 30 s. */
  async #start(
    effect: Extract<FlowEffect, { readonly kind: "start" }>,
    server: string,
  ): Promise<void> {
    const { draft } = effect;
    try {
      const created = await this.client.createSession(draft.project.id, effect.create);
      this.store.showCreated(created);
      void this.launches.launch(created.id, effect.launch);
    } catch (cause) {
      // Nothing started: her prompt waits for the next New session.
      const kept = new Map(this.#kept.get(server) ?? []);
      kept.set(keptPromptKey(draft.project.id, draft.join), draft.prompt);
      this.#kept.set(server, kept);
      const picked = await vscode.window.showErrorMessage(
        `Mend could not create the session · ${words(cause)}`,
        "Try again",
      );
      if (picked === "Try again") await this.open({ project: draft.project, join: draft.join });
    }
  }
}
