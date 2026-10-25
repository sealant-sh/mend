import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { preparePage } from "./session-pages.ts";

const refusalOf = (html: string) =>
  Effect.runSync(
    preparePage({ html, title: "Page", height: 400 }).pipe(
      Effect.match({ onFailure: (error) => error.reason, onSuccess: () => null }),
    ),
  );

describe("preparePage", () => {
  it.each([
    "<img src=/tmp/shot.png>",
    '<img src="/tmp/no-extension">',
    '<img src="/tmp/shot.png?v=1">',
    "<img src='file:///tmp/shot.png'>",
    '<img src="C:\\shots\\a.png">',
    '<img alt="x" src = " /tmp/a.png ">',
    '<img srcset="data:image/png;base64,AAAA 1x, /tmp/b.png 2x">',
    '<video poster="/tmp/poster"></video>',
    '<div style="background:url(/tmp/bg)"></div>',
    "<style>main{background:url('/tmp/bg.webp?x')}</style>",
    '<img src="./chart.png">',
    '<img src="images/chart.png">',
    "<img src=chart.png>",
    '<svg><image href="/tmp/chart.png"/></svg>',
    '<svg><image xlink:href="chart.png"/></svg>',
    '<svg><use href="sprite.svg#icon"/></svg>',
    '<img src="&#47;tmp/chart.png">',
    '<img src="&#x2F;tmp/chart.png">',
    '<img src="&sol;tmp/chart.png">',
    '<img alt="a > b" src="/tmp/chart.png">',
    '<div style="background:url(&quot;/tmp/bg.png&quot;)"></div>',
    '<script src="app.js"></script>',
    '<script>new Image().src="/tmp/chart.png"</script>',
    "<script>const plot = '/home/me/plot.webp';</script>",
  ])("refuses a local file in %s", (html) => {
    expect(refusalOf(html)).toBe("local-file");
  });

  it.each([
    '<a href="/docs/report.png">report</a>',
    '<img src="//cdn.example.com/a.png">',
    '<img src="https://cdn.example.com/a.png?v=1">',
    '<img src="data:image/jpeg;base64,/9j/4AAQ">',
    '<img srcset="data:image/jpeg;base64,/9j/4AAQ 1x, https://cdn.example.com/b.png 2x">',
    '<svg><rect fill="url(#grad)"/></svg>',
    '<svg><use href="#icon"/><image href="data:image/png;base64,AAAA"/></svg>',
    '<img src="https&colon;//cdn.example.com/a.png">',
    '<img src="HTTPS://cdn.example.com/a.png">',
    '<pre>&lt;img src="/logo.svg"&gt; and &lt;img src=/logo.png&gt;</pre>',
    "<p>Set src=/logo.png, or url(/assets/bg.png) in CSS.</p>",
    '<!-- <img src="/tmp/old.png"> -->',
    '<script>fetch("/api/data"); const tag = "<img src=x>";</script>',
  ])("publishes %s", (html) => {
    expect(refusalOf(html)).toBeNull();
  });

  it.each([
    "<style>main{height:1e2vh}</style>",
    "<style>main{height:1.5E+1dvh}</style>",
    '<main style="min-height:+100svh">x</main>',
  ])("refuses a viewport height unit in %s", (html) => {
    expect(refusalOf(html)).toBe("viewport-height");
  });

  it("refuses a NUL character, which the database cannot store, in the page or its title", () => {
    expect(refusalOf("<p>a\u0000b</p>")).toBe("nul-character");
    expect(
      Effect.runSync(
        preparePage({ html: "<p>x</p>", title: "a\u0000b", height: 400 }).pipe(
          Effect.match({ onFailure: (error) => error.reason, onSuccess: () => null }),
        ),
      ),
    ).toBe("nul-character");
  });

  it("reads units in CSS only, so page text that names one is a page", () => {
    expect(refusalOf("<p>100vh is a CSS unit</p>")).toBeNull();
  });

  it("stays linear on half a megabyte of hostile input", () => {
    const run = "/".repeat(500_000);
    const started = performance.now();
    for (const html of [
      `<img src="${run}`,
      `url(${run}`,
      `<img srcset="${" ,".repeat(250_000)}`,
      " src=".repeat(100_000),
      `<style>${"1".repeat(500_000)}`,
      `<style>${"1e".repeat(250_000)}`,
      "<a ".repeat(170_000),
      '<img alt="'.repeat(50_000),
      `<img src="${"&#".repeat(250_000)}">`,
      `<svg><image href="${run}`,
      `<script>"/${"a".repeat(500_000)}`,
      `<script>${"'/".repeat(250_000)}`,
      `<p style="${"url(".repeat(125_000)}">`,
    ]) {
      refusalOf(html);
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
