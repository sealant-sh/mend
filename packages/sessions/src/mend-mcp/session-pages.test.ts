import { SessionPagesRepo } from "@mend/db";
import { SessionId } from "@mend/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { checkPage } from "./page-check.ts";
import { SessionPages, sessionPagesLayer } from "./session-pages.ts";

const refusalOf = (html: string) => checkPage({ html, title: "Page" })?.reason ?? null;

const hostile = (n: number): ReadonlyArray<string> => [
  `<img src="${"/".repeat(n)}`,
  `url(${"/".repeat(n)}`,
  `<img srcset="${" ,".repeat(n / 2)}`,
  " src=".repeat(n / 5),
  `<style>${"1".repeat(n)}`,
  `<style>${"1e".repeat(n / 2)}`,
  "<a ".repeat(Math.floor(n / 3)),
  '<img alt="'.repeat(n / 10),
  `<img src="${"&#".repeat(n / 2)}">`,
  `<svg><image href="${"/".repeat(n)}`,
  `<script>"/${"a".repeat(n)}`,
  `<script>${"'/".repeat(n / 2)}`,
  `<p style="${"url(".repeat(n / 4)}">`,
];

// The work a check does, as the characters it reads and the subject lengths its scans may cover:
// counted, not timed, so a loaded machine cannot pass for growth or hide it.
const workOf = (pages: ReadonlyArray<string>): number => {
  let work = 0;
  const strings = String.prototype;
  const regexps = RegExp.prototype;
  const kept = {
    charAt: strings.charAt,
    charCodeAt: strings.charCodeAt,
    codePointAt: strings.codePointAt,
    indexOf: strings.indexOf,
    exec: regexps.exec,
    matchAll: regexps[Symbol.matchAll],
  };
  strings.charAt = function (this: string, position: number) {
    work += 1;
    return kept.charAt.call(this, position);
  };
  strings.charCodeAt = function (this: string, position: number) {
    work += 1;
    return kept.charCodeAt.call(this, position);
  };
  strings.codePointAt = function (this: string, position: number) {
    work += 1;
    return kept.codePointAt.call(this, position);
  };
  strings.indexOf = function (this: string, search: string, from?: number) {
    work += this.length - (from ?? 0);
    return kept.indexOf.call(this, search, from);
  };
  regexps.exec = function (this: RegExp, subject: string) {
    work += subject.length - (this.global || this.sticky ? this.lastIndex : 0);
    return kept.exec.call(this, subject);
  };
  regexps[Symbol.matchAll] = function (this: RegExp, subject: string) {
    work += subject.length;
    return kept.matchAll.call(this, subject);
  };
  try {
    for (const html of pages) refusalOf(html);
  } finally {
    Object.assign(strings, {
      charAt: kept.charAt,
      charCodeAt: kept.charCodeAt,
      codePointAt: kept.codePointAt,
      indexOf: kept.indexOf,
    });
    regexps.exec = kept.exec;
    regexps[Symbol.matchAll] = kept.matchAll;
  }
  return work;
};

describe("checkPage", () => {
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
    '<link rel="stylesheet" href="/tmp/review.css">',
    "<link rel=icon href=favicon.png>",
    '<link rel=preload href="./a.woff2">',
    '<link rel=preload as=image imagesrcset="/a.png 1x">',
    '<script src="/x.js"></script>',
    '<iframe src="/x"></iframe>',
    '<iframe srcdoc="&lt;img src=/x.png&gt;"></iframe>',
    '<video poster="./p.jpg"></video>',
    '<picture><source srcset="a.png 1x, /b.png 2x"></picture>',
    '<object data="/x.svg"></object>',
    '<table background="/x.png"></table>',
    '<svg><image href="/x.png"/></svg>',
    '<svg><feImage href="/x.png"/></svg>',
    '<svg><script href="/x.js"></script></svg>',
    '<svg><a xlink:href="#a"/><use xlink:href="/sprite.svg#a"/></svg>',
    '<svg><rect fill="url(/x.svg#g)"/></svg>',
    '<div style="background:url(&quot;/x.png&quot;)"></div>',
    '<div style="background:\\75 rl(/x.png)"></div>',
    '<style>@import "/x.css";</style>',
    "<style>@import url(./x.css)</style>",
    "<style>@import 'x.css' screen;</style>",
    "<style>p{content:'/*'}main{background:url(/x.png)}</style>",
    "<style>main{background:url(/*x*/)}</style>",
    '<style>main{background:image-set("/x.png" 1x)}</style>',
    "<svg><style>rect{fill:url(&quot;/x.svg#g&quot;)}</style></svg>",
    "<template><img src=/x.png></template>",
    "<svg><foreignObject><img src=/x.png></foreignObject></svg>",
    '<style>@import url( "x.css" );</style>',
    "<style>main{background:URL( x.png )}</style>",
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
    '<a href="/docs">docs</a>',
    '<form action="/x"><button>go</button></form>',
    '<svg><a href="/docs"><text>docs</text></a></svg>',
    '<div style="fill:url(#grad)"></div>',
    '<style>main{background:url("data:image/png;base64,AAAA")}</style>',
    '<script src="https://cdn.example.com/chart.js"></script>',
    '<script src="//cdn.example/x.js"></script>',
    '<link rel="stylesheet" href="https://cdn.example.com/a.css">',
    "<style>@import url(https://cdn.example.com/a.css);</style>",
    '<img src="blob:https://example.com/1">',
    '<p>Use 100vh for full height, or src="/x.png".</p>',
    '<pre><code>main { height: 100vh }\n&lt;img src="/x.png"&gt;</code></pre>',
    "<!-- <style>main{height:100vh}</style> -->",
    "<style>/* 100vh */ main{height:400px}</style>",
    "<style>main::after{content:'100vh'}</style>",
    "<style>main{height:100/**/vh}</style>",
    "<textarea>main{height:100vh} <img src=/x.png></textarea>",
  ])("publishes %s", (html) => {
    expect(refusalOf(html)).toBeNull();
  });

  it.each([
    "<style>main{height:1e2vh}</style>",
    "<style>main{height:1.5E+1dvh}</style>",
    '<main style="min-height:+100svh">x</main>',
    '<main style="height:100&#118;h">x</main>',
    '<main style="height:100\\76 h">x</main>',
    "<style>main{height:100\\56H}</style>",
    '<main style="height:1e2VH">x</main>',
    '<main style="height:.5dvh">x</main>',
    '<main style="height:100LVH">x</main>',
    '<main style="margin-top:-50vh">x</main>',
    "<svg><style>rect{height:100vh}</style></svg>",
    '<svg><rect style="height:10vh"/></svg>',
  ])("refuses a viewport height unit in %s", (html) => {
    expect(refusalOf(html)).toBe("viewport-height");
  });

  it("refuses a NUL character, which the database cannot store, in the page or its title", () => {
    expect(refusalOf("<p>a\u0000b</p>")).toBe("nul-character");
    expect(checkPage({ html: "<p>x</p>", title: "a\u0000b" })?.reason).toBe("nul-character");
  });

  it("reads units in CSS only, so page text that names one is a page", () => {
    expect(refusalOf("<p>100vh is a CSS unit</p>")).toBeNull();
  });

  it("does linear work on hostile input", () => {
    const small = workOf(hostile(5_000));
    const large = workOf(hostile(20_000));
    expect(small).toBeGreaterThan(5_000);
    // Quadrupling the input quadruples linear work and multiplies quadratic work by 16.
    expect(large / small).toBeLessThan(6);
  });
});

describe("SessionPages", () => {
  it.each([
    ["throws", "throw new Error('the check crashed')"],
    ["exits without an answer", "0"],
  ])("refuses a page, and stores nothing, when its check's worker %s", async (_, program) => {
    const unreachable = Layer.succeed(SessionPagesRepo, {
      publish: () => Effect.die(new Error("a page whose check crashed was stored")),
      byId: () => Effect.succeed(null),
      refById: () => Effect.succeed(null),
      listForSession: () => Effect.succeed([]),
    });
    const refusal = await Effect.runPromise(
      Effect.gen(function* () {
        const pages = yield* SessionPages;
        return yield* pages.publish(
          { sessionId: SessionId.make("s-crash"), accountId: "alice", callKey: "crash" },
          { html: "<p>x</p>", title: "Page", height: 400 },
        );
      }).pipe(
        Effect.flip,
        Effect.provide(
          sessionPagesLayer(new URL(`data:text/javascript,${program}`)).pipe(
            Layer.provide(unreachable),
          ),
        ),
      ),
    );
    expect(refusal).toMatchObject({ _tag: "PageRejectedError", reason: "check-failed" });
  });
});
