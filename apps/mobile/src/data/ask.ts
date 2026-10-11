// One way to ask a person something, or tell them: the same title, message and buttons as
// `Alert.alert`. A phone keeps the platform's own alert. react-native-web's `Alert.alert` does
// nothing, so on the web build every confirm-first action did nothing; there the question waits
// here, oldest first, for the app's own dialog (components/ask.tsx) to show it.

export interface AskButton {
  readonly text?: string;
  readonly style?: "default" | "cancel" | "destructive";
  readonly onPress?: () => void;
}

export interface AskOptions {
  /** Android: a tap outside dismisses. The web dialog always dismisses on one. */
  readonly cancelable?: boolean;
  readonly onDismiss?: () => void;
}

export type Ask = (
  title: string,
  message?: string,
  buttons?: ReadonlyArray<AskButton>,
  options?: AskOptions,
) => void;

/** A question the web dialog shows. */
export interface Question {
  readonly id: number;
  readonly title: string;
  readonly message: string | null;
  readonly buttons: ReadonlyArray<AskButton>;
  readonly onDismiss: (() => void) | null;
}

export interface Asker {
  readonly ask: Ask;
  readonly subscribe: (listener: () => void) => () => void;
  /** The question on screen: the oldest not yet answered. Always null off the web. */
  readonly showing: () => Question | null;
  /** Close the question, then run the button's action. Once: a second press finds it gone. */
  readonly answer: (id: number, button: AskButton) => void;
  /**
   * Escape, or a tap outside: what Cancel does when the question has one, else `onDismiss`. Never
   * a button that does something.
   */
  readonly dismiss: (id: number) => void;
}

/** A question with no buttons gets the one native alerts show. */
const OK: ReadonlyArray<AskButton> = [{ text: "OK" }];

export const createAsker = ({
  os,
  alert,
}: {
  readonly os: string;
  /** The platform's alert; `Alert.alert` in the app. */
  readonly alert: (
    title: string,
    message?: string,
    buttons?: Array<AskButton>,
    options?: AskOptions,
  ) => void;
}): Asker => {
  let waiting: ReadonlyArray<Question> = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const take = (id: number): Question | null => {
    const question = waiting.find((entry) => entry.id === id) ?? null;
    if (question === null) return null;
    waiting = waiting.filter((entry) => entry.id !== id);
    notify();
    return question;
  };

  const ask: Ask = (title, message, buttons, options) => {
    if (os !== "web") {
      alert(title, message, buttons === undefined ? undefined : [...buttons], options);
      return;
    }
    waiting = [
      ...waiting,
      {
        id: next++,
        title,
        message: message === undefined || message === "" ? null : message,
        buttons: buttons === undefined || buttons.length === 0 ? OK : buttons,
        onDismiss: options?.onDismiss ?? null,
      },
    ];
    notify();
  };

  return {
    ask,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    showing: () => waiting[0] ?? null,
    answer: (id, button) => {
      if (take(id) !== null) button.onPress?.();
    },
    dismiss: (id) => {
      const question = take(id);
      if (question === null) return;
      const cancel = question.buttons.find((button) => button.style === "cancel");
      if (cancel !== undefined) cancel.onPress?.();
      else question.onDismiss?.();
    },
  };
};
