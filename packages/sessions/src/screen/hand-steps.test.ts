import { describe, expect, it } from "vitest";

import { planActions } from "./hand-steps.ts";

const pointer = (x: number, y: number, buttons = 0) => ({ _tag: "Pointer", buttons, x, y });
const key = (keysym: number, down: boolean) => ({ _tag: "Key", down, keysym });

describe("the agent's actions as the hand's steps", () => {
  it("clicks by moving there and pressing the button as often as asked", () => {
    expect(
      planActions([{ kind: "click", at: { x: 10, y: 20 }, button: "right", count: 2 }]),
    ).toEqual({
      _tag: "Plan",
      steps: [
        {
          _tag: "Inputs",
          inputs: [
            pointer(10, 20),
            pointer(10, 20, 4),
            pointer(10, 20),
            pointer(10, 20, 4),
            pointer(10, 20),
          ],
        },
      ],
    });
  });

  it("drags with the left button down from the start to the end, and lets go there", () => {
    const plan = planActions([{ kind: "drag", from: { x: 0, y: 0 }, to: { x: 80, y: 40 } }]);
    const inputs =
      plan._tag === "Plan" && plan.steps[0]?._tag === "Inputs" ? plan.steps[0].inputs : [];
    expect(inputs[0]).toEqual(pointer(0, 0));
    expect(inputs[1]).toEqual(pointer(0, 0, 1));
    expect(inputs.at(-2)).toEqual(pointer(80, 40, 1));
    expect(inputs.at(-1)).toEqual(pointer(80, 40));
    expect(
      inputs.slice(1, -1).every((input) => input._tag === "Pointer" && input.buttons === 1),
    ).toBe(true);
  });

  it("scrolls with a wheel click per step, up and left for negative steps", () => {
    expect(planActions([{ kind: "scroll", at: { x: 5, y: 5 }, dx: -1, dy: 2 }])).toEqual({
      _tag: "Plan",
      steps: [
        {
          _tag: "Inputs",
          inputs: [
            pointer(5, 5),
            pointer(5, 5, 16),
            pointer(5, 5),
            pointer(5, 5, 16),
            pointer(5, 5),
            pointer(5, 5, 32),
            pointer(5, 5),
          ],
        },
      ],
    });
  });

  it("types text and presses combos, and waits as a step of its own", () => {
    expect(
      planActions([
        { kind: "type", text: "é" },
        { kind: "key", combo: "ctrl+l" },
        { kind: "wait", ms: 250 },
      ]),
    ).toEqual({
      _tag: "Plan",
      steps: [
        { _tag: "Inputs", inputs: [key(0xe9, true), key(0xe9, false)] },
        {
          _tag: "Inputs",
          inputs: [key(0xffe3, true), key(0x6c, true), key(0x6c, false), key(0xffe3, false)],
        },
        { _tag: "Wait", ms: 250 },
      ],
    });
  });

  it("names the first key no keysym stands for, and plans nothing", () => {
    expect(
      planActions([
        { kind: "click", at: { x: 1, y: 1 } },
        { kind: "key", combo: "ctrl+nosuchkey" },
        { kind: "type", text: "\u0007" },
      ]),
    ).toEqual({ _tag: "Unsupported", key: "nosuchkey" });
  });
});
