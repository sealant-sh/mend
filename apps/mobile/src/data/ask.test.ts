import { describe, expect, it, vi } from "vitest";

import { createAsker, type AskButton } from "./ask";

const stopButtons = (onStop: () => void, onCancel?: () => void): ReadonlyArray<AskButton> => [
  { text: "Cancel", style: "cancel", ...(onCancel === undefined ? {} : { onPress: onCancel }) },
  { text: "Stop session", style: "destructive", onPress: onStop },
];

describe("ask on a phone", () => {
  it.each(["ios", "android"])("hands %s the platform alert, word for word", (os) => {
    const alert = vi.fn();
    const asker = createAsker({ os, alert });
    const onStop = vi.fn();
    const buttons = stopButtons(onStop);
    asker.ask("Stop this session?", "The agent ends.", buttons, { cancelable: true });

    expect(alert).toHaveBeenCalledWith("Stop this session?", "The agent ends.", buttons, {
      cancelable: true,
    });
    expect(asker.showing()).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("passes a notice without buttons as it came", () => {
    const alert = vi.fn();
    createAsker({ os: "ios", alert }).ask("No image on the clipboard", "Copy one first.");
    expect(alert).toHaveBeenCalledWith(
      "No image on the clipboard",
      "Copy one first.",
      undefined,
      undefined,
    );
  });
});

const web = () => {
  const alert = vi.fn();
  return { alert, asker: createAsker({ os: "web", alert }) };
};

describe("ask on the web build", () => {
  it("shows the question in the app instead of the alert that does nothing", () => {
    const { alert, asker } = web();
    const listener = vi.fn();
    asker.subscribe(listener);
    asker.ask("Stop this session?", "The agent ends.", stopButtons(vi.fn()));

    expect(alert).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(asker.showing()).toMatchObject({
      title: "Stop this session?",
      message: "The agent ends.",
      buttons: [{ text: "Cancel" }, { text: "Stop session" }],
    });
  });

  it("runs the chosen button once, after closing", () => {
    const { asker } = web();
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
    const { asker } = web();
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
    const { asker } = web();
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
    const { asker } = web();
    const onDismiss = vi.fn();
    const onChoice = vi.fn();
    asker.ask("Attach an image", undefined, [{ text: "Photo library", onPress: onChoice }], {
      cancelable: true,
      onDismiss,
    });
    const question = asker.showing();
    if (question === null) throw new Error("no question");

    asker.dismiss(question.id);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onChoice).not.toHaveBeenCalled();
  });

  it("gives a notice the OK a phone would show", () => {
    const { asker } = web();
    asker.ask("No image on the clipboard", "Copy a screenshot or photo first.");
    expect(asker.showing()).toMatchObject({
      title: "No image on the clipboard",
      message: "Copy a screenshot or photo first.",
      buttons: [{ text: "OK" }],
    });
  });

  it("shows questions one at a time, oldest first", () => {
    const { asker } = web();
    asker.ask("First");
    asker.ask("Second");
    const first = asker.showing();
    if (first === null) throw new Error("no question");
    expect(first.title).toBe("First");

    asker.dismiss(first.id);
    expect(asker.showing()?.title).toBe("Second");
  });
});
