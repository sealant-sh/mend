// @vitest-environment jsdom
import { TraceRow } from "@mend/ui/components/trace-row";
import { describe, expect, it, vi } from "vitest";

import { click, getByRole, render } from "./render.tsx";

describe("TraceRow", () => {
  it("opens and closes the steps under it", () => {
    const onOpenChange = vi.fn();
    const { host } = render(
      <TraceRow title="Worked for 2m 4s" description="1 command failed" onOpenChange={onOpenChange}>
        <p>Read 6 files in src/payments</p>
      </TraceRow>,
    );
    const toggle = getByRole("button", "Worked for 2m 4s");

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("Read 6 files");

    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Read 6 files");
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("is a plain row, not a button, with nothing under it", () => {
    const { host } = render(<TraceRow title="Read 6 files" description="0.8s" />);
    expect(host.querySelector("button")).toBeNull();
  });
});
