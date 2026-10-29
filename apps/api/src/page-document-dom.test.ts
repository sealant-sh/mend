// @vitest-environment jsdom
import { PAGE_LIMITS } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { pageDocument } from "./page-document.ts";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

const bootstrapped = (document: Document) => ({
  theme: document.head.querySelectorAll("style#t3-theme").length,
  scripts: [...document.head.querySelectorAll("script")].filter((script) =>
    script.textContent?.includes('getElementById("t3-theme")'),
  ).length,
  inBody: document.body.querySelectorAll("style#t3-theme, script").length,
});

describe("the page document, as a browser parses it", () => {
  it.each([
    ["a quoted > in the head's attribute", `<head data-label='>'></head><body><p>x</p></body>`],
    ["a double-quoted > in the head's attribute", `<head data-label=">"></head><body><p>x</p>`],
    ["a quoted > in the html's attribute", `<html data-label='>'><body><p>x</p></body></html>`],
    ["a quoted > before the head", `<!doctype html><a title='<head>'></a><p>x</p>`],
    ["an unquoted attribute", `<!doctype html><html lang=en><head class=a><title>t</title></head>`],
    ["a head inside a template", `<template><head></head></template><body><p>x</p></body>`],
  ])("puts the bootstrap in the head once: %s", (_, html) => {
    const document = parse(pageDocument(html, "light"));
    expect(bootstrapped(document)).toEqual({ theme: 1, scripts: 1, inBody: 0 });
    expect(document.body.textContent).not.toContain("'>");
    expect(document.body.textContent).not.toContain('">');
  });

  it("leaves the page's own attributes as it wrote them", () => {
    const document = parse(pageDocument(`<head data-label='>'></head><p>x</p>`, "dark"));
    expect(document.head.getAttribute("data-label")).toBe(">");
    expect(document.body.innerHTML).toBe("<p>x</p>");
  });

  it("adds no second viewport or charset to a page that names its own", () => {
    const html = `<!doctype html><head><meta charset='utf-8'><meta content="width=600" name='viewport'></head>`;
    const document = parse(pageDocument(html, "dark"));
    expect(document.querySelectorAll("meta[charset]")).toHaveLength(1);
    expect(document.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
  });

  it.each([
    ["an unclosed head tag, repeated", "<head "],
    ["an unclosed meta tag, repeated", "<meta "],
    ["an unclosed quote, repeated", "<a b='"],
    ["comment openers", "<!--"],
    ["template openers", "<template>"],
    ["script openers", "<script>"],
    ["closing-tag openers", "</a"],
    ["head tags", "<head>"],
    ["meta tags", "<meta name=viewport>"],
  ])("takes linear time on a page of %s", (_, unit) => {
    const html = unit.repeat(Math.floor(PAGE_LIMITS.htmlChars / unit.length));
    const started = performance.now();
    pageDocument(html, "dark");
    expect(performance.now() - started).toBeLessThan(250);
  });
});
