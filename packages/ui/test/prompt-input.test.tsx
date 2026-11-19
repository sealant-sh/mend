// @vitest-environment jsdom
import { PromptInput } from "@mend/ui/components/prompt-input";
import { describe, expect, it, vi } from "vitest";

import { click, getByRole, press, render, type } from "./render.tsx";

const field = () => getByRole("textbox", "Reply to Claude Code");

describe("PromptInput", () => {
  it("sends on Enter and empties the field", () => {
    const onSubmit = vi.fn();
    render(<PromptInput placeholder="Reply to Claude Code" onSubmit={onSubmit} />);

    type(field(), "  Add a test for the 409 path  ");
    press(field(), "Enter");

    expect(onSubmit).toHaveBeenCalledWith("Add a test for the 409 path");
    expect(field()).toHaveProperty("value", "");
  });

  it("starts a new line on Shift+Enter instead of sending", () => {
    const onSubmit = vi.fn();
    render(<PromptInput placeholder="Reply to Claude Code" onSubmit={onSubmit} />);

    type(field(), "First line");
    press(field(), "Enter", { shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps send off while the field is empty, unless an empty answer is allowed", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <PromptInput placeholder="Reply to Claude Code" onSubmit={onSubmit} />,
    );
    press(field(), "Enter");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getByRole("button", "Send")).toHaveProperty("disabled", true);

    rerender(<PromptInput placeholder="Reply to Claude Code" allowEmpty onSubmit={onSubmit} />);
    click(getByRole("button", "Send"));
    expect(onSubmit).toHaveBeenCalledWith("");
  });

  it("doesn't send while locked, and shows only the notice", () => {
    const onSubmit = vi.fn();
    const { host } = render(
      <PromptInput
        state="locked"
        notice="Only Grace Hopper can message this session."
        onSubmit={onSubmit}
      />,
    );

    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.textContent).toContain("Only Grace Hopper can message this session.");
    host.querySelector("form")?.requestSubmit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers what the viewer can do instead while locked", () => {
    const onAction = vi.fn();
    const onSubmit = vi.fn();
    const { host } = render(
      <PromptInput
        state="locked"
        notice="Only Grace Hopper can message this session."
        noticeAction={
          <button type="button" onClick={onAction}>
            Start your own session in this workspace
          </button>
        }
        onSubmit={onSubmit}
      />,
    );

    const action = host.querySelector<HTMLButtonElement>(
      '[data-slot="prompt-input-notice-action"] button',
    );
    expect(action?.textContent).toBe("Start your own session in this workspace");
    action?.click();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("steers on Enter while running, and stops the turn", () => {
    const onSubmit = vi.fn();
    const onSteer = vi.fn();
    const onStop = vi.fn();
    render(
      <PromptInput
        state="running"
        placeholder="Reply to Claude Code"
        onSubmit={onSubmit}
        onSteer={onSteer}
        onStop={onStop}
      />,
    );

    expect(getByRole("button", "Steer")).toHaveProperty("disabled", true);
    type(field(), "Use the existing backoff helper");
    press(field(), "Enter");
    click(getByRole("button", "Stop turn"));

    expect(onSteer).toHaveBeenCalledWith("Use the existing backoff helper");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledOnce();
  });
});
