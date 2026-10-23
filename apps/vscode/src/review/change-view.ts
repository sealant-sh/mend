import * as vscode from "vscode";

import { displaySession } from "../session-lines.js";
import { changeUri } from "./change-content.js";
import { noteUri } from "./change-note.js";
import {
  changeRows,
  diffSides,
  fileRow,
  type ChangeRead,
  type ChangeRow,
  type CheckpointRow,
  type CommentRow,
  type FileRow,
} from "./change-rows.js";
import { OFFLINE_WORDS } from "./instruction.js";
import { recordText } from "./record-text.js";
import type { RecordContent } from "./record.js";
import type { ReviewStore } from "./review-store.js";
import type { Checkpoint } from "./review-wire.js";
import { checkpointName, sliceOffers, type SliceChoice, type SliceOffer } from "./slices.js";
import { evidenceLine } from "./threads.js";

/**
 * The Change section (story d): the review store's read as a tree under the Sessions view, the
 * file rows opening VS Code's own diff editor, and the slice picker. It never opens a window, and
 * only its overflow menu opens the web app (rule 11).
 */

type ChangeNode = ChangeRow | FileRow | CheckpointRow | CommentRow;

const ROW_SCHEME = "mend-change-row";

const LETTER_COLORS: Readonly<Record<string, string>> = {
  A: "gitDecoration.addedResourceForeground",
  D: "gitDecoration.deletedResourceForeground",
  R: "gitDecoration.renamedResourceForeground",
  M: "gitDecoration.modifiedResourceForeground",
};

/** A file row's resource: its path for the file icon, its letter for the decoration. */
const rowUri = (row: FileRow): vscode.Uri =>
  vscode.Uri.from({
    scheme: ROW_SCHEME,
    path: `/${row.folder === "" ? row.name : `${row.folder}/${row.name}`}`,
    query: new URLSearchParams({ letter: row.letter }).toString(),
  });

interface SliceItem extends vscode.QuickPickItem {
  readonly offer: SliceOffer;
}

interface CheckpointItem extends vscode.QuickPickItem {
  readonly checkpoint: Checkpoint;
}

export class ChangeView implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #decorations = new vscode.EventEmitter<undefined>();
  readonly #view: vscode.TreeView<ChangeNode>;
  readonly #disposables: ReadonlyArray<vscode.Disposable>;
  readonly #ticker: NodeJS.Timeout;
  #rows: ReadonlyArray<ChangeRow> = [];
  #drawn = "";

  constructor(
    private readonly store: ReviewStore,
    private readonly record: RecordContent,
    private readonly onError: (cause: unknown) => void,
    private readonly serverUrl: () => Promise<string>,
  ) {
    this.#view = vscode.window.createTreeView("mend.change", { treeDataProvider: this });
    this.#disposables = [
      this.#changed,
      this.#decorations,
      this.#view,
      store.onDidChange(() => this.#draw()),
      vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: this.#decorations.event,
        provideFileDecoration: (uri) => {
          if (uri.scheme !== ROW_SCHEME) return undefined;
          const letter = new URLSearchParams(uri.query).get("letter") ?? "M";
          const color = LETTER_COLORS[letter] ?? "gitDecoration.modifiedResourceForeground";
          return new vscode.FileDecoration(letter, undefined, new vscode.ThemeColor(color));
        },
      }),
      vscode.commands.registerCommand("mend.change.openFile", (row?: FileRow) =>
        this.#openFile(row),
      ),
      vscode.commands.registerCommand("mend.change.openAll", () => this.#openAll()),
      vscode.commands.registerCommand("mend.change.pickSlice", () => this.#pickSlice()),
      vscode.commands.registerCommand("mend.change.openInWeb", () => this.#openInWeb()),
      vscode.commands.registerCommand("mend.change.refresh", () => store.reread()),
      vscode.commands.registerCommand("mend.change.repin", (sinceLastReview?: unknown) =>
        store.repin(sinceLastReview === true).catch((cause: unknown) => this.onError(cause)),
      ),
      vscode.commands.registerCommand("mend.change.readNewer", () => store.readNewer()),
      vscode.commands.registerCommand("mend.change.read", () => store.readChange()),
      vscode.commands.registerCommand("mend.change.openComment", (row?: CommentRow) =>
        this.#openComment(row),
      ),
      vscode.commands.registerCommand(
        "mend.change.showRecord",
        (runId?: unknown, sequence?: unknown, excerpt?: unknown) =>
          this.#showRecord(runId, sequence, excerpt),
      ),
    ];
    // The header's `40 s ago` keeps counting while the section is on screen.
    this.#ticker = setInterval(() => this.#draw(), 10_000);
    this.#draw();
  }

  dispose(): void {
    clearInterval(this.#ticker);
    for (const disposable of this.#disposables) disposable.dispose();
  }

  /** The section on screen (`Mend: Review change`). */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("mend.change.focus");
  }

  #draw(): void {
    const state = this.store.state();
    this.#rows =
      state.kind === "ready"
        ? changeRows(state.read, this.store.review(), this.store.you(), new Date())
        : [];
    const followed = this.store.followed();
    this.#view.description = followed === null ? "" : displaySession(followed.session);
    this.#view.message =
      state.kind === "idle"
        ? "Select a session to see its change."
        : state.kind === "reading"
          ? "Reading the change…"
          : state.kind === "empty" || state.kind === "failed"
            ? state.words
            : "";
    void vscode.commands.executeCommand(
      "setContext",
      "mend.change.files",
      state.kind === "ready" && state.read.diff.files.length > 0,
    );
    void vscode.commands.executeCommand("setContext", "mend.change.ready", state.kind === "ready");
    // Which Send review the title shows: ready, retry, or disabled with why, each its own button.
    const offer = this.store.offer();
    void vscode.commands.executeCommand(
      "setContext",
      "mend.change.send",
      offer.kind === "disabled"
        ? offer.why === OFFLINE_WORDS
          ? "offline"
          : "notHers"
        : offer.kind,
    );
    const drawn = JSON.stringify([this.#view.message, this.#rows]);
    if (drawn === this.#drawn) return;
    this.#drawn = drawn;
    this.#changed.fire(undefined);
    this.#decorations.fire(undefined);
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    switch (node.kind) {
      case "slice": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.description = node.description;
        item.tooltip = "Choose what to review";
        item.command = { command: "mend.change.pickSlice", title: "Choose what to review" };
        item.contextValue = "mend.change.slice";
        return item;
      }
      case "note": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case "action": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.iconPath = new vscode.ThemeIcon("arrow-right");
        item.command = {
          command: node.command,
          title: node.label,
          arguments: [node.sinceLastReview],
        };
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(rowUri(node), vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.label = node.name;
        item.description = node.folder;
        item.tooltip = `${node.folder === "" ? "" : `${node.folder}/`}${node.name} · +${node.file.additions} −${node.file.deletions}`;
        item.command = { command: "mend.change.openFile", title: "Open", arguments: [node] };
        item.contextValue = "mend.change.file";
        return item;
      }
      case "comments": {
        // VS Code keeps the collapsible state it first saw for an id, so the row with comments
        // under it has an id of its own.
        const item = new vscode.TreeItem(
          "Comments",
          node.comments.length === 0
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = node.comments.length === 0 ? `${node.id}:none` : node.id;
        item.description = node.description;
        item.contextValue = "mend.change.comments";
        return item;
      }
      case "comment": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.mend ? "sparkle" : "comment");
        item.command = {
          command: "mend.change.openComment",
          title: "Show the comment",
          arguments: [node],
        };
        return item;
      }
      case "checkpoints": {
        const item = new vscode.TreeItem("Checkpoints", vscode.TreeItemCollapsibleState.Collapsed);
        item.id = node.id;
        item.description = node.description;
        return item;
      }
      case "checkpoint": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon("git-commit");
        return item;
      }
    }
  }

  getChildren(node?: ChangeNode): Array<ChangeNode> {
    if (node === undefined) return [...this.#rows];
    const row = this.#rows.find((candidate) => candidate.id === node.id);
    if (row?.kind === "slice") return [...row.above, ...row.files];
    if (row?.kind === "checkpoints") return [...row.checkpoints];
    if (row?.kind === "comments") return [...row.comments];
    return [];
  }

  /** A comment's row: its file at its line, in the diff of the slice it hangs on. */
  async #openComment(row?: CommentRow): Promise<void> {
    const thread = row?.thread ?? null;
    const read = this.store.ready();
    if (thread === null || read === null) return;
    const selection = new vscode.Range(thread.line - 1, 0, thread.line - 1, 0);
    const at = thread.at;
    if (at === null) {
      await vscode.window.showTextDocument(noteUri(read.changeId), { selection, preview: true });
      return;
    }
    if (at.slice !== read.pinned.id) {
      await vscode.window.showTextDocument(changeUri(at), { selection, preview: true });
      return;
    }
    const file = read.pinnedDiff.files.find((candidate) => candidate.newPath === at.path);
    const { left, right } =
      file === undefined
        ? { left: { ...at, at: read.pinned.base.id, slice: null }, right: at }
        : diffSides(file, at.worktreeId, {
            from: read.pinned.base,
            to: read.pinned.head,
            slice: read.pinned.id,
          });
    await vscode.commands.executeCommand(
      "vscode.diff",
      changeUri(left),
      changeUri(right),
      `${at.path.split("/").at(-1) ?? at.path} (${read.chain.baseName} ↔ checkpoint ${read.pinned.head.ordinal})`,
      { preview: true, selection },
    );
  }

  /**
   * Show record (G9): the whole transcript of the session whose run the evidence cites, the
   * evidence it was asked for on top.
   */
  async #showRecord(runId: unknown, sequence: unknown, excerpt: unknown): Promise<void> {
    try {
      const cited =
        typeof sequence === "string" ? { runId: typeof runId === "string" ? runId : null } : null;
      const shown = await this.store.record(cited);
      if (shown === null) return;
      if (shown.kind === "not-found") {
        void vscode.window.showWarningMessage(shown.words);
        return;
      }
      await this.record.show(
        shown.sessionId,
        shown.name,
        recordText({
          name: shown.name,
          evidence:
            typeof sequence === "string" && typeof excerpt === "string"
              ? evidenceLine({ runId: null, sequence, excerpt })
              : null,
          entries: shown.entries,
        }),
      );
    } catch (cause) {
      this.onError(cause);
    }
  }

  async #openFile(row?: FileRow): Promise<void> {
    if (row === undefined) return;
    await vscode.commands.executeCommand(
      "vscode.diff",
      changeUri(row.left),
      changeUri(row.right),
      row.title,
      { preview: true },
    );
  }

  /** Every file of the slice in one multi-diff editor (`vscode.changes`). */
  async #openAll(): Promise<void> {
    const read = this.store.ready();
    if (read === null || read.diff.files.length === 0) return;
    const rows = read.diff.files.map((file) => fileRow(file, read));
    // VS Code adds the file count to the title itself: `Changes · add-rate-limit (4 files)`.
    await vscode.commands.executeCommand(
      "vscode.changes",
      `Changes · ${read.sessionName}`,
      rows.map((row) => [changeUri(row.right), changeUri(row.left), changeUri(row.right)]),
    );
  }

  async #openInWeb(): Promise<void> {
    const read = this.store.ready();
    if (read === null) return;
    try {
      const url = await this.serverUrl();
      await vscode.env.openExternal(
        vscode.Uri.parse(`${url}/changes/${encodeURIComponent(read.changeId)}`),
      );
    } catch (cause) {
      this.onError(cause);
    }
  }

  /**
   * `Review which slice?` (story d, step 5): each choice says the span it reads, and its file
   * count once read. Between two checkpoints asks for its two ends in two more picks.
   */
  async #pickSlice(): Promise<void> {
    const read = this.store.ready();
    if (read === null) return;
    const offers = sliceOffers({
      pinned: read.pinned,
      chain: read.chain.checkpoints,
      base: read.chain.baseName,
      current: read.slice.choice,
      reviewedHead: read.reviewedHead,
    });
    const pick = vscode.window.createQuickPick<SliceItem>();
    pick.title = `Review which slice? · ${read.sessionName}`;
    pick.placeholder = "Type to filter slices";
    const counts = new Map<string, string>();
    const items = (): ReadonlyArray<SliceItem> =>
      offers.map((offer) => ({
        label: offer.label,
        description: [offer.span, counts.get(offer.label) ?? null, offer.current ? "current" : null]
          .flatMap((part) => (part === null ? [] : [part]))
          .join(" · "),
        ...(offer.current ? { iconPath: new vscode.ThemeIcon("check") } : {}),
        offer,
      }));
    pick.items = items();
    pick.busy = true;
    void Promise.all(
      offers.map(async (offer) => {
        if (offer.choice === "between") return;
        const count = await this.store.fileCount(offer.choice);
        if (count === null) return;
        const files = `${count.files} ${count.files === 1 ? "file" : "files"}`;
        counts.set(offer.label, count.cut ? `listing cut at ${files}` : files);
        pick.items = items();
      }),
    )
      .catch(() => undefined)
      .finally(() => {
        pick.busy = false;
      });
    const chosen = await new Promise<SliceItem | undefined>((resolve) => {
      pick.onDidAccept(() => resolve(pick.selectedItems[0]));
      pick.onDidHide(() => resolve(undefined));
      pick.show();
    });
    pick.dispose();
    if (chosen === undefined) return;
    const choice =
      chosen.offer.choice === "between" ? await this.#pickBetween(read) : chosen.offer.choice;
    if (choice !== null) this.store.choose(read.sessionId, choice);
  }

  async #pickBetween(read: ChangeRead): Promise<SliceChoice | null> {
    const base = read.chain.baseName;
    const item = (checkpoint: Checkpoint): CheckpointItem => ({
      label: checkpointName(checkpoint, base),
      description: checkpoint.createdAt.slice(11, 16),
      checkpoint,
    });
    const from = await vscode.window.showQuickPick<CheckpointItem>(
      read.chain.checkpoints.slice(0, -1).map(item),
      { title: "Between two checkpoints · from which?", ignoreFocusOut: true },
    );
    if (from === undefined) return null;
    const to = await vscode.window.showQuickPick<CheckpointItem>(
      read.chain.checkpoints
        .filter((checkpoint) => checkpoint.ordinal > from.checkpoint.ordinal)
        .map(item),
      { title: `Between ${from.label} and which checkpoint?`, ignoreFocusOut: true },
    );
    return to === undefined ? null : { kind: "between", from: from.checkpoint, to: to.checkpoint };
  }
}
