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
    readonly authority = "",
  ) {}
  get path(): string {
    return this.fsPath;
  }
  static file(fsPath: string): Uri {
    return new Uri("file", fsPath);
  }
  static from(parts: {
    readonly scheme: string;
    readonly authority?: string;
    readonly path?: string;
  }): Uri {
    return new Uri(parts.scheme, parts.path ?? "", parts.authority);
  }
  static joinPath(base: Uri, ...parts: ReadonlyArray<string>): Uri {
    return new Uri(base.scheme, [base.fsPath, ...parts].join("/"));
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}

export class FileSystemError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
  static FileNotFound(): FileSystemError {
    return new FileSystemError("FileNotFound");
  }
}

export class RelativePattern {
  constructor(
    readonly base: Uri,
    readonly pattern: string,
  ) {}
}

export const ExtensionKind = { UI: 1, Workspace: 2 };
export const StatusBarAlignment = { Left: 1, Right: 2 };

export const QuickInputButtons = { Back: { iconPath: new ThemeIcon("arrow-left") } };
export const InputBoxValidationSeverity = { Info: 1, Warning: 2, Error: 3 };
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
const quickPicks: Array<FakeQuickInput> = [];

const windowState = new EventEmitter<{ readonly focused: boolean }>();
const configurationChanged = new EventEmitter<{
  affectsConfiguration(section: string): boolean;
}>();
const extensionsChanged = new EventEmitter<void>();
const settings = new Map<string, unknown>();

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
  createQuickPick: (): FakeQuickInput => {
    const pick = new FakeQuickInput();
    quickPicks.push(pick);
    return pick;
  },
  withProgress: <T>(
    _options: unknown,
    task: (progress: { report(value: unknown): void }) => Promise<T>,
  ): Promise<T> => task({ report: () => undefined }),
  createOutputChannel: (_name: string) => ({
    appendLine: (_line: string) => undefined,
    show: (_preserveFocus?: boolean) => undefined,
    dispose: () => undefined,
  }),
  createStatusBarItem: (..._: ReadonlyArray<unknown>) => ({
    name: "",
    text: "",
    tooltip: "",
    command: "",
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
};

export const workspace: {
  workspaceFolders:
    | ReadonlyArray<{ readonly uri: Uri; readonly name: string; readonly index: number }>
    | undefined;
  onDidChangeWorkspaceFolders: EventEmitter<unknown>["event"];
  onDidChangeConfiguration: (typeof configurationChanged)["event"];
  getConfiguration(section?: string): { get(key: string): unknown };
  createFileSystemWatcher(pattern: RelativePattern): {
    onDidChange: EventEmitter<Uri>["event"];
    onDidCreate: EventEmitter<Uri>["event"];
    onDidDelete: EventEmitter<Uri>["event"];
    dispose(): void;
  };
  fs: { readFile(uri: Uri): Promise<Uint8Array> };
} = {
  workspaceFolders: undefined,
  onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
  onDidChangeConfiguration: configurationChanged.event,
  getConfiguration: (section) => ({
    get: (key) => settings.get(section === undefined ? key : `${section}.${key}`),
  }),
  createFileSystemWatcher: () => ({
    onDidChange: new EventEmitter<Uri>().event,
    onDidCreate: new EventEmitter<Uri>().event,
    onDidDelete: new EventEmitter<Uri>().event,
    dispose: () => undefined,
  }),
  fs: {
    readFile: async () => {
      throw FileSystemError.FileNotFound();
    },
  },
};

export const env: { remoteName: string | undefined } = { remoteName: undefined };
export const extensions = {
  getExtension: (_id: string) => undefined,
  onDidChange: extensionsChanged.event,
};

export const commands = {
  executeCommand: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
  registerCommand: (_command: string, _callback: (...args: ReadonlyArray<unknown>) => unknown) =>
    new Disposable(() => undefined),
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
  lastQuickPick(): FakeQuickInput {
    const pick = quickPicks.at(-1);
    if (pick === undefined) throw new Error("no quick pick was made");
    return pick;
  },
  focus(focused: boolean): void {
    window.state.focused = focused;
    windowState.fire({ focused });
  },
  /** Sets a setting by its full key, then tells every listener it changed. */
  configure(key: string, value: unknown): void {
    settings.set(key, value);
    configurationChanged.fire({
      affectsConfiguration: (section) => key === section || key.startsWith(`${section}.`),
    });
  },
  extensionsChanged(): void {
    extensionsChanged.fire();
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
    quickPicks.length = 0;
    settings.clear();
  },
};
