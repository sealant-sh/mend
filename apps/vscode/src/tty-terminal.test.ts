import { describe, expect, it, vi } from "vitest";

import { MendTtyTerminal } from "./tty-terminal.js";

const typed = vi.hoisted(() => ({ bytes: new Array<string>() }));

vi.mock("vscode", () => import("./test-vscode.js"));

vi.mock("./tty-attachment.js", () => ({
  TtyAttachment: class {
    isOpen(): boolean {
      return true;
    }
    isClosed(): boolean {
      return false;
    }
    input(data: string): void {
      typed.bytes.push(data);
    }
  },
}));

const terminal = (): MendTtyTerminal =>
  new MendTtyTerminal({
    connection: async () => ({ url: "http://mend", token: "t" }),
    address: { process: "agent-1" },
    banner: "",
    liveness: async () => "live",
  });

describe("a review pasted into a terminal", () => {
  it("is written as one bracketed paste: newlines kept inside, every other control gone", async () => {
    typed.bytes.length = 0;
    const text = [
      "line one\r\n",
      "line two\rthree\n",
      "\ttabbed",
      "\u0000\u0003\u0004\u0007\b\u001a",
      "\u001b[201~escaped\u001b]0;title\u0007",
      "\u007f\u0080\u0085\u009b\u009f",
      "é → ✓",
    ].join("");
    expect(await terminal().paste(text, async () => true)).toBe(true);
    expect(typed.bytes).toEqual([
      "\u001b[200~line one\nline two\nthree\n  tabbed[201~escaped]0;titleé → ✓\u001b[201~",
    ]);
  });

  it("never carries a carriage return a shell would run as Enter", async () => {
    typed.bytes.length = 0;
    await terminal().paste("rm -rf build\r", async () => true);
    const [bytes] = typed.bytes;
    expect(bytes).toBe("\u001b[200~rm -rf build\n\u001b[201~");
    expect(bytes?.includes("\r")).toBe(false);
  });

  it("writes nothing when the check made right before the write refuses it", async () => {
    typed.bytes.length = 0;
    const refused = new Error("VS Code is connected to another Mend server");
    await expect(
      terminal().paste("the review", async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);
    expect(await terminal().paste("the review", async () => false)).toBe(false);
    expect(typed.bytes).toEqual([]);
  });
});
