import * as vscode from "vscode";

import { changeAddress, changeUri } from "./change-content.js";
import { noteUri } from "./change-note.js";
import { DRAFT_NOT_SHOWN, type Keeping, type ReviewStore } from "./review-store.js";
import { retryDelivery } from "./review-toast.js";
import { commentableLines, evidenceLine, threadsOf, type ThreadView } from "./threads.js";

/**
 * Comment threads on the change's documents (story d, steps 3, 4 and 7), through VS Code's stable
 * Comments API: the `+` on a line of the pinned slice writes a pending comment, Mend's drafts
 * show with their evidence and [Accept] [Dismiss], and the Comments panel lists them all. Every
 * thread is drawn from the review store; a gesture asks the store and the store redraws.
 */

/** A comment as VS Code holds it, and what it shows. */
class ShownComment implements vscode.Comment {
  constructor(
    readonly thread: ThreadView,
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    readonly author: vscode.CommentAuthorInformation,
    readonly label: string,
    readonly contextValue: string,
    readonly timestamp: Date,
  ) {}
}

/** Her words the store did not keep: shown in their thread so a submit never loses them. */
class UnkeptComment implements vscode.Comment {
  readonly mode = vscode.CommentMode.Preview;
  readonly label = "not kept";
  readonly contextValue = "mend.comment.unkept";
  readonly author: vscode.CommentAuthorInformation;

  constructor(
    readonly body: string,
    author: string,
  ) {
    this.author = { name: author };
  }
}

const RECORD_COMMAND = "mend.change.showRecord";

/** The comment's words, its evidence beside them, and Show record when it carries any. */
const bodyOf = (thread: ThreadView): vscode.MarkdownString => {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = { enabledCommands: [RECORD_COMMAND] };
  markdown.appendText(thread.body);
  for (const link of thread.evidence)
    markdown.appendMarkdown(`\n\n\`${evidenceLine(link).replaceAll("`", "'")}\``);
  const [first] = thread.evidence;
  if (first !== undefined) {
    const args = encodeURIComponent(JSON.stringify([first.runId, first.sequence, first.excerpt]));
    markdown.appendMarkdown(`\n\n[Show record](command:${RECORD_COMMAND}?${args})`);
  }
  return markdown;
};

/** A comment as shown; while she edits it, its plain words. */
const shown = (thread: ThreadView, mode = vscode.CommentMode.Preview): ShownComment =>
  new ShownComment(
    thread,
    mode === vscode.CommentMode.Editing ? thread.body : bodyOf(thread),
    mode,
    { name: thread.author },
    thread.label,
    `mend.comment.${thread.kind}`,
    new Date(thread.createdAt),
  );

const sameThread = (left: ThreadView, right: ThreadView): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export class ReviewComments implements vscode.Disposable {
  readonly #controller: vscode.CommentController;
  /**
   * The change's note takes only comments on the whole change, and VS Code words a reply box by its
   * controller alone: the note's threads have a controller of their own.
   */
  readonly #note: vscode.CommentController;
  readonly #threads = new Map<string, { view: ThreadView; thread: vscode.CommentThread }>();
  /** Threads whose Add, Accept or Dismiss is still being kept: a second click waits it out. */
  readonly #busy = new Set<vscode.CommentThread>();
  readonly #disposables: ReadonlyArray<vscode.Disposable>;

  constructor(private readonly store: ReviewStore) {
    this.#controller = vscode.comments.createCommentController("mend.review", "Mend review");
    this.#controller.options = {
      prompt: "Comment on this line",
      placeHolder: "Pending until Send review",
    };
    this.#note = vscode.comments.createCommentController("mend.review.note", "Mend review");
    this.#note.options = {
      prompt: "Comment on the whole change",
      placeHolder: "Pending until Send review",
    };
    this.#controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        const read = store.ready();
        const address = changeAddress(document.uri);
        if (read === null || address === null) return [];
        return commentableLines(read, address).map(
          ({ start, end }) => new vscode.Range(start - 1, 0, end - 1, 0),
        );
      },
    };
    this.#disposables = [
      this.#controller,
      this.#note,
      store.onDidChange(() => this.#draw()),
      vscode.commands.registerCommand("mend.review.addComment", (reply: vscode.CommentReply) =>
        this.#once(reply.thread, () => this.#add(reply)),
      ),
      vscode.commands.registerCommand("mend.review.accept", (reply: vscode.CommentReply) =>
        this.#onDraft(reply, (id, text) => store.accept(id, text)),
      ),
      vscode.commands.registerCommand("mend.review.dismiss", (reply: vscode.CommentReply) =>
        this.#onDraft(reply, (id, text) => store.dismiss(id, text)),
      ),
      vscode.commands.registerCommand("mend.review.edit", (comment: unknown) =>
        this.#mode(comment, vscode.CommentMode.Editing),
      ),
      vscode.commands.registerCommand("mend.review.cancel", (comment: unknown) =>
        this.#mode(comment, vscode.CommentMode.Preview),
      ),
      vscode.commands.registerCommand("mend.review.save", (comment: unknown) =>
        this.#save(comment),
      ),
      vscode.commands.registerCommand("mend.review.delete", (comment: unknown) =>
        comment instanceof ShownComment && comment.thread.pendingId !== null
          ? store.remove(comment.thread.pendingId)
          : undefined,
      ),
      vscode.commands.registerCommand("mend.review.addressed", (comment: unknown) =>
        comment instanceof ShownComment && comment.thread.commentId !== null
          ? store.mark(comment.thread.commentId, "addressed")
          : undefined,
      ),
      vscode.commands.registerCommand("mend.review.reopen", (comment: unknown) =>
        comment instanceof ShownComment && comment.thread.commentId !== null
          ? store.mark(comment.thread.commentId, "open")
          : undefined,
      ),
      vscode.commands.registerCommand("mend.review.retry", (comment: unknown) => {
        const target =
          comment instanceof ShownComment && comment.thread.sendKey !== null
            ? store.retryOf(comment.thread.sendKey)
            : null;
        return target === null ? undefined : retryDelivery(store, target);
      }),
    ];
    this.#draw();
  }

  dispose(): void {
    for (const { thread } of this.#threads.values()) thread.dispose();
    for (const disposable of this.#disposables) disposable.dispose();
  }

  /** Draws every thread the store's read holds; a thread whose document moved is drawn anew. */
  #draw(): void {
    const read = this.store.ready();
    const views = read === null ? [] : threadsOf(read, this.store.review(), this.store.you());
    const wanted = new Map(views.map((view) => [view.key, view]));
    for (const [key, drawn] of this.#threads) {
      const next = wanted.get(key);
      if (next === undefined || JSON.stringify(next.at) !== JSON.stringify(drawn.view.at)) {
        drawn.thread.dispose();
        this.#threads.delete(key);
      }
    }
    for (const view of views) {
      if (read === null) break;
      const drawn = this.#threads.get(view.key);
      if (drawn !== undefined && sameThread(drawn.view, view)) continue;
      const range = new vscode.Range(view.line - 1, 0, view.endLine - 1, 0);
      const thread =
        drawn?.thread ??
        (view.at === null
          ? this.#note.createCommentThread(noteUri(read.changeId), range, [])
          : this.#controller.createCommentThread(changeUri(view.at), range, []));
      thread.range = range;
      thread.label = view.at === null ? "the whole change" : `${view.at.path} · line ${view.line}`;
      thread.contextValue = `mend.thread.${view.kind}`;
      thread.canReply = view.kind === "draft";
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.comments = [shown(view)];
      this.#threads.set(view.key, { view, thread });
    }
  }

  /** The `+` on a line of the pinned slice, and her words: a pending comment, not yet sent. */
  async #add(reply: vscode.CommentReply): Promise<void> {
    const { thread } = reply;
    const address = changeAddress(thread.uri);
    const range = thread.range;
    const [held] = thread.comments;
    const body = reply.text.trim() === "" && held instanceof UnkeptComment ? held.body : reply.text;
    if (address === null || range === undefined) {
      this.#hold(thread, body, "This document takes no comments, so your comment is not kept.");
      return;
    }
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === thread.uri.toString(),
    );
    const lineText =
      document !== undefined && range.start.line < document.lineCount
        ? document.lineAt(range.start.line).text
        : "";
    const kept = await this.store.comment({
      at: address,
      line: range.start.line + 1,
      endLine: range.end.line + 1,
      lineText,
      body,
    });
    if (kept.kept) thread.dispose();
    else this.#hold(thread, body, kept.words);
  }

  /**
   * Words the store did not keep stay in their thread, with why, until she tries again: under a
   * Mend draft, below the draft.
   */
  #hold(thread: vscode.CommentThread, body: string, words: string): void {
    if (body.trim() !== "")
      thread.comments = [
        ...thread.comments.filter((comment) => !(comment instanceof UnkeptComment)),
        new UnkeptComment(body, this.store.you()),
      ];
    thread.canReply = true;
    void vscode.window.showWarningMessage(words);
  }

  async #onDraft(
    reply: vscode.CommentReply,
    act: (draftId: string, text: string) => Promise<Keeping>,
  ): Promise<void> {
    const { thread } = reply;
    const held = thread.comments.find((comment) => comment instanceof UnkeptComment);
    const text = reply.text.trim() === "" && held !== undefined ? held.body : reply.text;
    const drawn = [...this.#threads.values()].find((candidate) => candidate.thread === thread);
    const draftId = drawn?.view.commentId ?? null;
    if (draftId === null) {
      this.#hold(thread, text, DRAFT_NOT_SHOWN);
      return;
    }
    await this.#once(thread, async () => {
      const kept = await act(draftId, text);
      if (!kept.kept) this.#hold(thread, text, kept.words);
    });
  }

  /** One gesture per thread at a time: a double click keeps one comment, not two. */
  async #once(thread: vscode.CommentThread, act: () => Promise<void>): Promise<void> {
    if (this.#busy.has(thread)) return;
    this.#busy.add(thread);
    try {
      await act();
    } finally {
      this.#busy.delete(thread);
    }
  }

  #mode(comment: unknown, mode: vscode.CommentMode): void {
    if (!(comment instanceof ShownComment)) return;
    const drawn = this.#threads.get(comment.thread.key);
    if (drawn === undefined) return;
    drawn.thread.comments = [shown(drawn.view, mode)];
  }

  async #save(comment: unknown): Promise<void> {
    if (!(comment instanceof ShownComment) || comment.thread.pendingId === null) return;
    const body = typeof comment.body === "string" ? comment.body : comment.body.value;
    const kept = await this.store.edit(comment.thread.pendingId, body);
    const drawn = this.#threads.get(comment.thread.key);
    if (kept.kept) {
      if (drawn !== undefined) drawn.thread.comments = [shown(drawn.view)];
      return;
    }
    // The store's redraw replaced the comment she was editing: put her words back in front of her.
    if (drawn !== undefined) drawn.thread.comments = [comment];
    void vscode.window.showWarningMessage(kept.words);
  }
}
