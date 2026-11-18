// @vitest-environment jsdom
import { CopyField } from "@mend/ui/components/copy-field";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getByRole, render } from "./render.tsx";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7 mend:linus@northwind.dev";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

/** Clicks the button and lets the clipboard's promise settle. */
async function clickAndSettle(button: HTMLElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CopyField", () => {
  it("copies the value, says Copied, then goes back to its label", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn((_text: string) => Promise.resolve());
    stubClipboard(writeText);
    const onCopied = vi.fn();
    render(<CopyField value={KEY} label="Copy key" onCopied={onCopied} />);

    await clickAndSettle(getByRole("button", "Copy key"));

    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(onCopied).toHaveBeenCalledOnce();
    expect(getByRole("button", "Copied")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(getByRole("button", "Copy key")).toBeTruthy();
  });

  it("selects the value for the person when the browser refuses the clipboard", async () => {
    stubClipboard(() => Promise.reject(new Error("NotAllowedError")));
    const onCopied = vi.fn();
    render(<CopyField value={KEY} onCopied={onCopied} />);

    await clickAndSettle(getByRole("button", "Copy"));

    expect(onCopied).not.toHaveBeenCalled();
    expect(getByRole("button", "Copy")).toBeTruthy();
    expect(window.getSelection()?.toString()).toBe(KEY);
  });
});
