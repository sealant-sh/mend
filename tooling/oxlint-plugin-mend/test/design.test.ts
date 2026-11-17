import { noArbitraryTypeOrRadius } from "../src/rules/no-arbitrary-type-or-radius.ts";
import { noRawColors } from "../src/rules/no-raw-colors.ts";
import { noUseClient } from "../src/rules/no-use-client.ts";
import { tester } from "./tester.ts";

tester.run("no-raw-colors", noRawColors, {
  valid: [
    { name: "token classes", code: `<div className="bg-surface text-muted border-line" />;` },
    { name: "a CSS variable", code: `<div style={{ color: "var(--mend-text)" }} />;` },
    { name: "an in-page link", code: `<a href="#add">Add</a>;` },
    {
      name: "a palette in a .ts file, which a library may need",
      filename: "terminal-theme.ts",
      code: `export const theme = { background: "#0a0a0a", foreground: "rgb(240 240 240)" };`,
    },
    { name: "an import path", code: `import icon from "./#fff.svg";` },
    { name: "a word that ends in a colour function's name", code: `const label = "collab(s)";` },
  ],
  invalid: [
    {
      name: "a Tailwind arbitrary hex",
      code: `<div className="p-2 bg-[#0a0a0a]" />;`,
      errors: [{ messageId: "raw", data: { color: "#0a0a0a" } }],
    },
    {
      name: "rgb() in an inline style",
      code: `<div style={{ color: "rgb(10 10 10)" }} />;`,
      errors: [{ messageId: "raw", data: { color: "rgb()" } }],
    },
    {
      name: "oklch() in a template class",
      code: "const tone = (on) => `text-[oklch(0.7_0.1_200)] ${on ? 'ring' : ''}`;",
      errors: [{ messageId: "raw" }],
    },
    {
      name: "a hex fill on an inline SVG",
      code: `<path fill="#fff" d="M0 0" />;`,
      errors: [{ messageId: "raw", data: { color: "#fff" } }],
    },
    {
      name: "a Tailwind arbitrary colour in a .ts file",
      filename: "button-variants.ts",
      code: `export const danger = "bg-[hsl(0_80%_50%)] text-white";`,
      errors: [{ messageId: "raw" }],
    },
  ],
});

tester.run("no-arbitrary-type-or-radius", noArbitraryTypeOrRadius, {
  valid: [
    { name: "scale classes", code: `<p className="text-sm rounded-md" />;` },
    {
      name: "arbitrary widths and heights",
      code: `<div className="w-[37px] h-[calc(100vh-3rem)]" />;`,
    },
    {
      name: "a token through var()",
      code: `<p className="text-[var(--mend-size-meta)] rounded-[var(--r)]" />;`,
    },
    {
      name: "a radius worked out from a token, and a keyword",
      code: `<div className="rounded-[min(var(--radius-md),10px)] rounded-[calc(var(--radius)-3px)] rounded-[inherit]" />;`,
    },
    {
      name: "an arbitrary text colour is no-raw-colors' to judge",
      code: `<p className="text-[color:var(--x)]" />;`,
    },
    {
      name: "a CSS-variable shorthand",
      code: `<p className="text-(length:--meta) rounded-(--r)" />;`,
    },
  ],
  invalid: [
    {
      name: "an off-scale type size",
      code: `<p className="text-[12.5px] font-medium" />;`,
      errors: [{ messageId: "type", data: { utility: "text-[12.5px]" } }],
    },
    {
      name: "an off-scale type size behind variants",
      code: `<p className="md:hover:text-[length:0.8rem]" />;`,
      errors: [{ messageId: "type", data: { utility: "text-[length:0.8rem]" } }],
    },
    {
      name: "an off-scale radius, on one corner",
      code: `const card = cn("p-4", "rounded-tl-[7px]");`,
      errors: [{ messageId: "radius", data: { utility: "rounded-tl-[7px]" } }],
    },
  ],
});

tester.run("no-use-client", noUseClient, {
  valid: [
    { name: "no directive", code: `export const a = 1;` },
    { code: `"use strict";\nexport const a = 1;` },
  ],
  invalid: [
    {
      name: "a use client directive",
      code: `"use client";\nexport function A() { return null; }`,
      errors: [{ messageId: "directive" }],
    },
  ],
});
