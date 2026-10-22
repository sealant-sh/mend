import { vi } from "vitest";

/**
 * The part of the `vscode` module unit tests reach: `vi.mock("vscode", () => import("./test-vscode.js"))`.
 * Tests drive it through `fake` and read the toasts off `window`'s spies.
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

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class Uri {
  constructor(
    readonly scheme: string,
    readonly fsPath: string,
  ) {}
  static file(fsPath: string): Uri {
    return new Uri("file", fsPath);
  }
  static joinPath(base: Uri, ...parts: ReadonlyArray<string>): Uri {
    return new Uri(base.scheme, [base.fsPath, ...parts].join("/"));
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export const QuickInputButtons = { Back: { iconPath: new ThemeIcon("arrow-left") } };
export const ProgressLocation = { Notification: 15 };

class FakeQuickInput {
  title = "";
  placeholder = "";
  prompt = "";
  value = "";
  busy = false;
  enabled = true;
  ignoreFocusOut = false;
  validationMessage: string | undefined = undefined;
  valueSelection: unknown = undefined;
  buttons: ReadonlyArray<unknown> = [];
  items: ReadonlyArray<unknown> = [];
  activeItems: ReadonlyArray<unknown> = [];
  visible = false;
  readonly #changed = new EventEmitter<string>();
  readonly #accepted = new EventEmitter<void>();
  readonly #button = new EventEmitter<unknown>();
  readonly #hidden = new EventEmitter<void>();
  readonly onDidChangeValue = this.#changed.event;
  readonly onDidAccept = this.#accepted.event;
  readonly onDidTriggerButton = this.#button.event;
  readonly onDidHide = this.#hidden.event;
  show(): void {
    this.visible = true;
  }
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.#hidden.fire();
  }
  dispose(): void {
    this.hide();
  }
  type(value: string): void {
    this.value = value;
    this.#changed.fire(value);
  }
  accept(): void {
    this.#accepted.fire();
  }
}

const inputBoxes: Array<FakeQuickInput> = [];

const windowState = new EventEmitter<{ readonly focused: boolean }>();

export const window = {
  state: { focused: true },
  onDidChangeWindowState: windowState.event,
  onDidChangeActiveTerminal: new EventEmitter<unknown>().event,
  showInformationMessage: vi.fn(
    async (..._: ReadonlyArray<unknown>): Promise<string | undefined> => undefined,
  ),
  showErrorMessage: vi.fn(
    async (..._: ReadonlyArray<unknown>): Promise<string | undefined> => undefined,
  ),
  showWarningMessage: vi.fn(
    async (..._: ReadonlyArray<unknown>): Promise<string | undefined> => undefined,
  ),
  setStatusBarMessage: vi.fn(),
  showQuickPick: vi.fn(async (..._: ReadonlyArray<unknown>): Promise<unknown> => undefined),
  showInputBox: vi.fn(
    async (..._: ReadonlyArray<unknown>): Promise<string | undefined> => undefined,
  ),
  activeTextEditor: undefined,
  createInputBox: (): FakeQuickInput => {
    const box = new FakeQuickInput();
    inputBoxes.push(box);
    return box;
  },
  createQuickPick: (): FakeQuickInput => new FakeQuickInput(),
  withProgress: <T>(
    _options: unknown,
    task: (progress: { report(value: unknown): void }) => Promise<T>,
  ): Promise<T> => task({ report: () => undefined }),
};

export const workspace: {
  workspaceFolders:
    | ReadonlyArray<{ readonly uri: Uri; readonly name: string; readonly index: number }>
    | undefined;
  onDidChangeWorkspaceFolders: EventEmitter<unknown>["event"];
  onDidChangeConfiguration: EventEmitter<unknown>["event"];
  getConfiguration(section?: string): { get(key: string): unknown };
} = {
  workspaceFolders: undefined,
  onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
  onDidChangeConfiguration: new EventEmitter<unknown>().event,
  getConfiguration: () => ({ get: () => undefined }),
};

export const env = { remoteName: undefined };
export const extensions = { getExtension: () => undefined };

export const commands = {
  executeCommand: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
};

export const fake = {
  inputBoxes(): ReadonlyArray<FakeQuickInput> {
    return inputBoxes;
  },
  lastInputBox(): FakeQuickInput {
    const box = inputBoxes.at(-1);
    if (box === undefined) throw new Error("no input box was made");
    return box;
  },
  focus(focused: boolean): void {
    window.state.focused = focused;
    windowState.fire({ focused });
  },
  reset(): void {
    window.state.focused = true;
    window.showInformationMessage.mockClear();
    window.showErrorMessage.mockClear();
    window.showWarningMessage.mockClear();
    window.setStatusBarMessage.mockClear();
    window.showQuickPick.mockReset();
    window.showInputBox.mockReset();
    window.showWarningMessage.mockReset();
    commands.executeCommand.mockClear();
    inputBoxes.length = 0;
  },
};
