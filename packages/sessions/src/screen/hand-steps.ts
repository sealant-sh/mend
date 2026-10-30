import type { ScreenAction, ScreenPoint } from "@mend/domain/workbench";

import { type Input, type Keys, keyCombo, typeText } from "./rfb-client.ts";

export type Step =
  | { readonly _tag: "Inputs"; readonly inputs: ReadonlyArray<Input> }
  | { readonly _tag: "Wait"; readonly ms: number };

type Unsupported = Extract<Keys, { readonly _tag: "Unsupported" }>;

export type Plan = { readonly _tag: "Plan"; readonly steps: ReadonlyArray<Step> } | Unsupported;

const BUTTON = { left: 1, middle: 2, right: 4 } as const;
const WHEEL = { up: 8, down: 16, left: 32, right: 64 } as const;
const DRAG_MOVES = 8;

const inputs = (sent: ReadonlyArray<Input>): Step => ({ _tag: "Inputs", inputs: sent });

const pointer = (at: ScreenPoint, buttons = 0): Input => ({ _tag: "Pointer", buttons, ...at });

const presses = (at: ScreenPoint, button: number, count: number): ReadonlyArray<Input> =>
  Array.from({ length: count }, () => [pointer(at, button), pointer(at)]).flat();

const between = (from: ScreenPoint, to: ScreenPoint, share: number): ScreenPoint => ({
  x: Math.round(from.x + (to.x - from.x) * share),
  y: Math.round(from.y + (to.y - from.y) * share),
});

const keys = (pressed: Keys): Step | Unsupported =>
  pressed._tag === "Keys" ? inputs(pressed.inputs) : pressed;

const stepOf = (action: ScreenAction): Step | Unsupported => {
  switch (action.kind) {
    case "wait":
      return { _tag: "Wait", ms: action.ms };
    case "type":
      return keys(typeText(action.text));
    case "key":
      return keys(keyCombo(action.combo));
    case "move":
      return inputs([pointer(action.to)]);
    case "click":
      return inputs([
        pointer(action.at),
        ...presses(action.at, BUTTON[action.button ?? "left"], action.count ?? 1),
      ]);
    case "drag":
      return inputs([
        pointer(action.from),
        ...Array.from({ length: DRAG_MOVES + 1 }, (_, move) =>
          pointer(between(action.from, action.to, move / DRAG_MOVES), BUTTON.left),
        ),
        pointer(action.to),
      ]);
    case "scroll":
      return inputs([
        pointer(action.at),
        ...presses(action.at, action.dy < 0 ? WHEEL.up : WHEEL.down, Math.abs(action.dy)),
        ...presses(action.at, action.dx < 0 ? WHEEL.left : WHEEL.right, Math.abs(action.dx)),
      ]);
  }
};

/** The agent's actions as the hand runs them, or the first key no keysym names. */
export const planActions = (actions: ReadonlyArray<ScreenAction>): Plan => {
  const steps: Array<Step> = [];
  for (const action of actions) {
    const step = stepOf(action);
    if (step._tag === "Unsupported") return step;
    steps.push(step);
  }
  return { _tag: "Plan", steps };
};
