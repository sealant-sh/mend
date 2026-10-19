import * as vscode from "vscode";

import { MendApiError, type MendClient } from "./client.js";
import { showErrorToast } from "./error-toast.js";
import { TRY_AGAIN } from "./first-run.js";
import { checkoutFact } from "./git.js";
import type { Launches } from "./launches.js";
import {
  isRememberedOptions,
  keptAfter,
  keptPromptKey,
  movesToDefault,
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
import { originProjectName } from "./project-match.js";
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

/** The quick input an effect works on, while it may still be open. */
interface OpenInput {
  readonly dispatch: (event: FlowEvent) => void;
  readonly hide: () => void;
  readonly isOpen: () => boolean;
}

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
    const origin = unmatched?.originUrl ?? null;
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
        project === null && origin !== null && unmatched?.candidates.length === 0
          ? { origin, name: originProjectName(origin) }
          : null,
      candidates: project === null ? (unmatched?.candidates ?? []) : [],
      checkout: windowCheckout,
      catalogs: null,
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

    // The prompt is typed into an InputBox, every list into a QuickPick (`QuickInputView`): one
    // shows at a time, and showing one hides the other.
    const pick = vscode.window.createQuickPick<Item>();
    const box = vscode.window.createInputBox();
    pick.ignoreFocusOut = true;
    box.ignoreFocusOut = true;
    let showing: vscode.QuickPick<Item> | vscode.InputBox | null = null;
    let shownItems = "";
    const showPick = (view: Extract<QuickInputView, { readonly kind: "pick" }>): void => {
      pick.step = view.step?.n;
      pick.totalSteps = view.step?.total;
      pick.buttons = view.back ? [vscode.QuickInputButtons.Back] : [];
      if (pick.value !== view.value) pick.value = view.value;
      const items = JSON.stringify(view.items);
      if (items === shownItems) return;
      shownItems = items;
      pick.items = view.items.map((item) => ({
        id: item.id,
        label: item.label,
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.alwaysShow === true ? { alwaysShow: true } : {}),
      }));
      const current = pick.items.filter((_item, index) => view.items[index]?.current === true);
      if (current.length > 0) pick.activeItems = current;
    };
    const showPrompt = (view: Extract<QuickInputView, { readonly kind: "prompt" }>): void => {
      box.buttons = [...(view.back ? [vscode.QuickInputButtons.Back] : []), CHANGE_BUTTON];
      box.prompt = view.line;
      box.validationMessage = view.warned
        ? { message: view.line, severity: vscode.InputBoxValidationSeverity.Warning }
        : undefined;
      if (box.value !== view.value) {
        box.value = view.value;
        // A kept prompt is not selected, so her next keystroke adds to it.
        box.valueSelection = [view.value.length, view.value.length];
      }
    };
    const show = (view: QuickInputView): void => {
      const target = view.kind === "pick" ? pick : box;
      target.title = view.title;
      target.placeholder = view.placeholder;
      target.busy = view.busy;
      target.enabled = !view.busy;
      if (view.kind === "pick") showPick(view);
      else showPrompt(view);
      if (showing === target) return;
      showing = target;
      target.show();
    };

    const dispatch = (event: FlowEvent): void => {
      const next = step(state, event, facts);
      state = next.state;
      const kept = keptAfter(facts.kept, state, next.effect);
      this.#kept.set(server, kept);
      facts = { ...facts, kept };
      facts = this.#carryOut(next.effect, facts, server, here);
      show(render(state, facts));
    };
    const here: OpenInput = {
      dispatch,
      hide: () => showing?.hide(),
      isOpen: () => this.#open === close,
    };
    /** What a widget says counts only while it is the one showing. */
    const from =
      <T>(widget: vscode.QuickPick<Item> | vscode.InputBox, handle: (value: T) => void) =>
      (value: T): void => {
        if (showing === widget) handle(value);
      };
    const accepted = (widget: vscode.QuickPick<Item> | vscode.InputBox, item: string): void => {
      if (widget.value !== render(state, facts).value)
        dispatch({ kind: "typed", value: widget.value });
      dispatch({ kind: "accept", item });
    };
    const pressed = (button: vscode.QuickInputButton): void => {
      if (button === vscode.QuickInputButtons.Back) dispatch({ kind: "back" });
      else if (button === CHANGE_BUTTON) dispatch({ kind: "change" });
    };

    const subscriptions = [
      pick,
      box,
      pick.onDidChangeValue(from(pick, (value: string) => dispatch({ kind: "typed", value }))),
      box.onDidChangeValue(from(box, (value: string) => dispatch({ kind: "typed", value }))),
      pick.onDidAccept(
        from(pick, () =>
          accepted(pick, pick.activeItems[0]?.id ?? pick.selectedItems[0]?.id ?? ""),
        ),
      ),
      box.onDidAccept(from(box, () => accepted(box, ""))),
      pick.onDidTriggerButton(from(pick, pressed)),
      box.onDidTriggerButton(from(box, pressed)),
      this.store.onDidChange(({ next }) => {
        if (next.offline !== state.offline) dispatch({ kind: "connection", offline: next.offline });
      }),
      // Showing the other widget hides this one: only hiding the one showing closes New session.
      pick.onDidHide(from(pick, () => close.dispose())),
      box.onDidHide(from(box, () => close.dispose())),
    ];
    const close = new vscode.Disposable(() => {
      for (const subscription of subscriptions) subscription.dispose();
      if (this.#open === close) this.#open = null;
    });
    this.#open = close;
    show(render(state, facts));
    // The catalog checks the remembered model and fills the model step; the prompt does not wait.
    const catalogs = await this.client.harnessModels().catch(() => null);
    if (catalogs === null || this.#open !== close) return;
    facts = { ...facts, catalogs };
    dispatch({ kind: "catalogsRead" });
  }

  /** The effect's work; the facts it changed come back. */
  #carryOut(effect: FlowEffect, facts: FlowFacts, server: string, here: OpenInput): FlowFacts {
    switch (effect.kind) {
      case "none":
        return facts;
      case "remember": {
        const all = remember(this.#remembered(), server, effect.projectId, effect.options);
        void this.context.globalState.update(REMEMBERED_OPTIONS_KEY, all);
        return { ...facts, remembered: all[server] ?? {} };
      }
      case "adopt":
        void this.#adopt(effect, here.dispatch);
        return facts;
      case "start":
        void this.#start(effect, server, here);
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
      void showErrorToast(cause, `Mend could not adopt ${effect.name} · ${words(cause)}`);
    }
  }

  /**
   * Create while the input waits, then show the row and launch without waiting: the server holds
   * a launch up to 30 s.
   */
  async #start(
    effect: Extract<FlowEffect, { readonly kind: "start" }>,
    server: string,
    here: OpenInput,
  ): Promise<void> {
    const { draft } = effect;
    try {
      const created = await this.client.createSession(draft.project.id, effect.create);
      here.hide();
      this.store.showCreated(created);
      void this.launches.launch(created.id, effect.launch);
    } catch (cause) {
      const unknownBase = cause instanceof MendApiError ? cause.unknownBase : null;
      if (unknownBase !== null && movesToDefault(draft, unknownBase) && here.isOpen()) {
        here.dispatch({ kind: "baseRefused", base: unknownBase });
        return;
      }
      here.hide();
      // Nothing started: her prompt waits for the next New session.
      const kept = new Map(this.#kept.get(server) ?? []);
      kept.set(keptPromptKey(draft.project.id, draft.join), draft.prompt);
      this.#kept.set(server, kept);
      if (
        await showErrorToast(
          cause,
          `Mend could not create the session · ${words(cause)}`,
          TRY_AGAIN,
        )
      )
        await this.open({ project: draft.project, join: draft.join });
    }
  }
}
