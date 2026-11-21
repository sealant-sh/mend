// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeText } from "./code-text.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Every piece of code the real highlighter was asked to colour, in order. */
const coloured: Array<string> = [];

vi.mock("#/lib/code-highlighter", async (importOriginal) => {
  const real = await importOriginal<typeof import("#/lib/code-highlighter")>();
  return {
    ...real,
    loadTokenizer: async (language: string) => {
      const tokenizer = await real.loadTokenizer(language);
      if (tokenizer === null) return null;
      return (code: string, after?: Parameters<typeof tokenizer>[1]) => {
        coloured.push(code);
        return tokenizer(code, after);
      };
    },
  };
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  coloured.length = 0;
});

const render = (code: string, language: string) => {
  const host = document.createElement("code");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<CodeText code={code} language={language} />));
  return {
    host,
    grow: (next: string) => act(() => root?.render(<CodeText code={next} language={language} />)),
  };
};

/** Waits for the highlighter to load and colour the code. */
const loaded = (host: HTMLElement) =>
  vi.waitFor(() => expect(host.querySelector("span[style]")).not.toBeNull(), { timeout: 5_000 });

/** The colour of the first coloured piece holding `text`. */
const colourOf = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll<HTMLElement>("span[style]")].find((span) =>
    span.textContent.includes(text),
  )?.style.color ?? "";

describe("CodeText", () => {
  it("colours TypeScript with the review's syntax colours, and keeps the text as it was", async () => {
    const code = 'const name = "mend";\n// a comment\nexport { name };';
    const { host } = render(code, "ts");
    await loaded(host);
    expect(host.textContent).toBe(code);
    expect(colourOf(host, "const")).toContain("--color-syntax-keyword");
    expect(colourOf(host, "mend")).toContain("--color-syntax-string");
    expect(colourOf(host, "// a comment")).toContain("--color-muted-foreground");
  });

  it("colours a shell block by an alias of its language", async () => {
    const { host } = render('echo "hi" | grep h', "sh");
    await loaded(host);
    expect(host.textContent).toBe('echo "hi" | grep h');
    expect(colourOf(host, "hi")).toContain("--color-syntax-string");
  });

  it("leaves a language the highlighter doesn't know, and plain text, plain", async () => {
    const unknown = render("some words", "no-such-language");
    const text = render("more words", "text");
    // Give a load the time it would take, then look again.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(unknown.host.innerHTML).toBe("some words");
    expect(text.host.innerHTML).toBe("more words");
  });

  it("while the code grows, colours each finished line once and only the last line again", async () => {
    const { host, grow } = render("const a = 1;\n", "ts");
    await loaded(host);
    coloured.length = 0;
    grow("const a = 1;\nconst b");
    grow("const a = 1;\nconst b = 2;");
    grow("const a = 1;\nconst b = 2;\nlet c");
    // The first line is never coloured again; the second, as the last line while it grew, then
    // once when it was finished.
    expect(coloured.filter((code) => code.includes("const a"))).toEqual([]);
    expect(coloured.filter((code) => code === "const b = 2;")).toHaveLength(2);
    expect(coloured).toEqual(["const b", "const b = 2;", "const b = 2;", "let c"]);
    expect(host.textContent).toBe("const a = 1;\nconst b = 2;\nlet c");
    expect(colourOf(host, "let")).toContain("--color-syntax-keyword");
  });
});
