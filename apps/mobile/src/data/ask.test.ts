import { describe, expect, it, vi } from "vitest";

import { createAsker, type AskButton } from "./ask";

const stopButtons = (onStop: () => void, onCancel?: () => void): ReadonlyArray<AskButton> => [
  { text: "Cancel", style: "cancel", ...(onCancel === undefined ? {} : { onPress: onCancel }) },
  { text: "Stop session", style: "destructive", onPress: onStop },
];

describe("ask before the dialog shows", () => {
  it("runs beforeAsk first, then queues the question word for word", () => {
    const asker = createAsker({ beforeAsk: vi.fn(() => expect(asker.showing()).toBeNull()) });
    const listener = vi.fn();
    asker.subscribe(listener);
    asker.ask("Stop this session?", "The agent ends.", stopButtons(vi.fn()));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(asker.showing()).toMatchObject({
      title: "Stop this session?",
      message: "The agent ends.",
      buttons: [{ text: "Cancel" }, { text: "Stop session" }],
    });
  });
});

describe("ask in the app's own dialog", () => {
  it("runs the chosen button once, after closing", () => {
    const asker = createAsker();
    const onStop = vi.fn(() => expect(asker.showing()).toBeNull());
    asker.ask("Stop this session?", undefined, stopButtons(onStop));
    const question = asker.showing();
    if (question === null) throw new Error("no question");
    const stop = question.buttons[1];
    if (stop === undefined) throw new Error("no stop button");

    asker.answer(question.id, stop);
    asker.answer(question.id, stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Cancel", () => {
    const asker = createAsker();
    const onStop = vi.fn();
    asker.ask("Stop this session?", undefined, stopButtons(onStop));
    const question = asker.showing();
    if (question === null) throw new Error("no question");
    const cancel = question.buttons[0];
    if (cancel === undefined) throw new Error("no cancel button");

    asker.answer(question.id, cancel);
    expect(onStop).not.toHaveBeenCalled();
    expect(asker.showing()).toBeNull();
  });

  it("treats a dismissal as Cancel, never as the action", () => {
    const asker = createAsker();
    const onStop = vi.fn();
    const onCancel = vi.fn();
    asker.ask("Stop this session?", undefined, stopButtons(onStop, onCancel));
    const question = asker.showing();
    if (question === null) throw new Error("no question");

    asker.dismiss(question.id);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    expect(asker.showing()).toBeNull();
  });

  it("calls onDismiss when the question has no Cancel", () => {
    const asker = createAsker();
    const onDismiss = vi.fn();
    const onChoice = vi.fn();
    asker.ask("Attach an image", undefined, [{ text: "Photo library", onPress: onChoice }], {
      onDismiss,
    });
    const question = asker.showing();
    if (question === null) throw new Error("no question");

    asker.dismiss(question.id);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onChoice).not.toHaveBeenCalled();
  });

  it("gives a notice without buttons an OK", () => {
    const asker = createAsker();
    asker.ask("No image on the clipboard", "Copy a screenshot or photo first.");
    expect(asker.showing()).toMatchObject({
      title: "No image on the clipboard",
      message: "Copy a screenshot or photo first.",
      buttons: [{ text: "OK" }],
    });
  });

  it("shows questions one at a time, oldest first", () => {
    const asker = createAsker();
    asker.ask("First");
    asker.ask("Second");
    const first = asker.showing();
    if (first === null) throw new Error("no question");
    expect(first.title).toBe("First");

    asker.dismiss(first.id);
    expect(asker.showing()?.title).toBe("Second");
  });
});
