import { vi } from "vitest";

/**
 * The part of the `vscode` module the store and the notifier touch, for unit tests:
 * `vi.mock("vscode", () => import("./test-vscode.js"))`. Tests drive focus and the active
 * terminal through `fake`, and read the toasts off `window`'s spies.
 */

type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
  readonly #listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

const windowState = new EventEmitter<{ readonly focused: boolean }>();
const activeTerminal = new EventEmitter<unknown>();

export const window = {
  state: { focused: true },
  onDidChangeWindowState: windowState.event,
  onDidChangeActiveTerminal: activeTerminal.event,
  showInformationMessage: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
  showErrorMessage: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
  setStatusBarMessage: vi.fn(),
};

export const workspace = {
  workspaceFolders: undefined,
  onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
};

export const commands = {
  executeCommand: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
};

export const fake = {
  focus(focused: boolean): void {
    window.state.focused = focused;
    windowState.fire({ focused });
  },
  /** The active terminal changed; tests say which session's it is through the window's fake. */
  terminalChanged(): void {
    activeTerminal.fire(undefined);
  },
  reset(): void {
    window.state.focused = true;
    window.showInformationMessage.mockClear();
    window.showErrorMessage.mockClear();
    window.setStatusBarMessage.mockClear();
    commands.executeCommand.mockClear();
  },
};
