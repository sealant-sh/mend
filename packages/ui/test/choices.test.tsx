// @vitest-environment jsdom
import { Approval } from "@mend/ui/components/approval";
import { Question } from "@mend/ui/components/question";
import { describe, expect, it, vi } from "vitest";

import { click, getByRole, press, render } from "./render.tsx";

const choices = [
  { value: "final", label: "Treat 409 as final", description: "Return the error." },
  { value: "retry", label: "Back off and retry", description: "Retry 3 times." },
];

describe("Question", () => {
  it("reports the choice picked by click or by its number key", () => {
    const onValueChange = vi.fn();
    render(
      <Question
        title="Should the retry back off on a 409?"
        choices={choices}
        other={{ value: "other", label: "Something else…" }}
        onValueChange={onValueChange}
      />,
    );

    click(getByRole("radio", "Back off and retry"));
    expect(onValueChange).toHaveBeenLastCalledWith("retry");
    expect(getByRole("radio", "Back off and retry")).toHaveProperty("checked", true);

    press(getByRole("radio", "Back off and retry"), "1");
    expect(onValueChange).toHaveBeenLastCalledWith("final");

    press(getByRole("radio", "Treat 409 as final"), "3");
    expect(onValueChange).toHaveBeenLastCalledWith("other");
  });

  it("submits the picked choice on Enter", () => {
    const onSubmit = vi.fn();
    render(
      <Question
        title="Should the retry back off on a 409?"
        choices={choices}
        defaultValue="retry"
        onSubmit={onSubmit}
      />,
    );

    press(getByRole("radio", "Back off and retry"), "Enter");
    expect(onSubmit).toHaveBeenCalledWith("retry");
  });
});

describe("Approval", () => {
  it("reports the choice picked", () => {
    const onValueChange = vi.fn();
    render(
      <Approval
        title="Claude Code wants to run a command"
        choices={[
          { value: "once", label: "Approve once" },
          { value: "always", label: "Always allow terraform apply in this session" },
        ]}
        defaultValue="once"
        onValueChange={onValueChange}
      />,
    );

    expect(getByRole("radio", "Approve once").getAttribute("aria-checked")).toBe("true");
    click(getByRole("radio", "Always allow"));
    expect(onValueChange).toHaveBeenCalledWith("always");
    expect(getByRole("radio", "Always allow").getAttribute("aria-checked")).toBe("true");
  });

  it("hides the choices when there are none", () => {
    const { host } = render(<Approval title="Claude Code wants to use a tool" />);
    expect(host.querySelector('[role="radio"]')).toBeNull();
    expect(getByRole("group", "Claude Code wants to use a tool")).toBeTruthy();
  });
});
