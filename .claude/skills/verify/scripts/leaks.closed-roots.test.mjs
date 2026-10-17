// The verify skill's leak paths for image evidence: content in closed shadow roots, ordinary media,
// and what changes while a capture is rasterized. Each case needs the skill's Playwright (see
// leaks.test.mjs) and is skipped, with that reason, where it is not installed.
//
//   node --test .claude/skills/verify/scripts/leaks.closed-roots.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import {
  here,
  playwright,
  noBrowser,
  TOKEN,
  fresh,
  everything,
  privateWithAccount,
  node,
  drive,
  closedContent,
} from "./leaks.helpers.mjs";

for (const kind of ["text", "canvas"]) {
  for (const nested of [false, true]) {
    test(
      `main-document closed ${kind}, nested in open root ${nested}, withholds secret and ordinary pixels`,
      { skip: noBrowser },
      () => {
        for (const shown of [TOKEN, "ordinary shadow content"]) {
          const privateDir = privateWithAccount();
          const out = fresh("closed-main-evidence");
          const run = drive(
            privateDir,
            out,
            `export default async ({ page, capture }) => {
            await page.setContent('<p>parent evidence</p><div id="host" aria-hidden="true"></div>');
            await capture("closed-main");
            await page.evaluate(() => { ${closedContent(kind, shown, nested)} });
            await capture("closed-main");
          };`,
          );
          assert.equal(run.status, 0, run.stderr);
          assert.equal(
            existsSync(join(out, "closed-main.png")),
            false,
            "closed pixels or stale image were kept",
          );
          assert.equal(
            existsSync(join(out, "closed-main.png.checked")),
            false,
            "stale checked sidecar was kept",
          );
          assert.match(
            readFileSync(join(out, "closed-main.png.withheld"), "utf8"),
            /closed shadow root/,
          );
          assert.ok(!everything(out).includes(TOKEN));
          const scan = node([
            join(here, "scan-evidence.mjs"),
            "--dir",
            out,
            "--secrets",
            privateDir,
          ]);
          assert.equal(scan.status, 0, scan.stdout);
        }
      },
    );
  }
}

test(
  "plain, open-shadow and native-input controls retain changed parent evidence",
  { skip: noBrowser },
  () => {
    for (const mode of ["plain", "open", "input"]) {
      const privateDir = privateWithAccount();
      const out = fresh("shadow-controls");
      const run = drive(
        privateDir,
        out,
        `export default async ({ page, capture }) => {
      await page.setContent('<p id="parent">parent evidence</p><div id="host"></div>');
      await page.evaluate(mode => {
        const host = document.getElementById("host");
        if (mode === "input") host.innerHTML = '<label>Search <input value="ordinary query"></label>';
        else (mode === "open" ? host.attachShadow({ mode: "open" }) : host).textContent = "ordinary content";
      }, ${JSON.stringify(mode)});
      await capture("before");
      await page.locator("#parent").evaluate(node => node.textContent = "changed parent evidence");
      await capture("after");
    };`,
      );
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(out, "before.png.checked")));
      assert.ok(existsSync(join(out, "after.png.checked")));
      assert.ok(
        !readFileSync(join(out, "before.png")).equals(readFileSync(join(out, "after.png"))),
        "parent pixels were withheld or hidden",
      );
      const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
      assert.equal(scan.status, 0, scan.stdout);
    }
  },
);

test(
  "a later readable capture reuses a withheld name without a stale marker or guard latch",
  { skip: noBrowser },
  () => {
    const privateDir = privateWithAccount();
    const out = fresh("reused-readable-evidence");
    const run = drive(
      privateDir,
      out,
      `export default async ({ page, capture }) => {
    await page.setContent('<p>parent evidence</p><div id="host" aria-hidden="true"></div>');
    await page.evaluate(() => { ${closedContent("text", TOKEN)} });
    await capture("reused");
    await page.locator("#host").evaluate(host => host.remove());
    await capture("reused");
  };`,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(out, "reused.png")));
    assert.ok(existsSync(join(out, "reused.png.checked")));
    assert.equal(existsSync(join(out, "reused.png.withheld")), false);
    assert.ok(!everything(out).includes(TOKEN));
    const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
    assert.equal(scan.status, 0, scan.stdout);
  },
);

for (const tag of ["video", "embed", "object"]) {
  test(
    `ordinary ${tag} content in an open root withholds image evidence`,
    { skip: noBrowser },
    () => {
      const privateDir = privateWithAccount();
      const out = fresh("opaque-element-evidence");
      const run = drive(
        privateDir,
        out,
        `export default async ({ page, capture }) => {
      await page.setContent('<p>parent evidence</p><div id="host"></div>');
      await page.evaluate(tag => {
        const root = document.getElementById("host").attachShadow({ mode: "open" });
        root.appendChild(document.createElement(tag));
      }, ${JSON.stringify(tag)});
      await capture("opaque");
    };`,
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(existsSync(join(out, "opaque.png")), false);
      assert.equal(existsSync(join(out, "opaque.png.checked")), false);
      assert.match(
        readFileSync(join(out, "opaque.png.withheld"), "utf8"),
        /opaque content requiring screenshot masking/,
      );
      assert.match(readFileSync(join(out, "opaque.aria.yml"), "utf8"), /parent evidence/);
      const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
      assert.equal(scan.status, 0, scan.stdout);
    },
  );
}

test(
  "opaque canvas pixels appearing only during rasterization are withheld",
  { skip: noBrowser },
  () => {
    const privateDir = privateWithAccount();
    const out = fresh("transient-canvas-evidence");
    const run = drive(
      privateDir,
      out,
      `export default async ({ page, capture }) => {
    await page.setContent('<p>parent evidence</p>');
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async options => {
      await page.evaluate(shown => {
        const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 100;
        canvas.id = "transient-canvas"; canvas.setAttribute("aria-hidden", "true");
        const context = canvas.getContext("2d"); context.font = "24px monospace"; context.fillText(shown, 10, 40);
        document.body.appendChild(canvas);
      }, ${JSON.stringify(TOKEN)});
      const png = await screenshot(options);
      await page.locator("#transient-canvas").evaluate(canvas => canvas.remove());
      return png;
    };
    await capture("transient-canvas");
  };`,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(out, "transient-canvas.png")), false);
    assert.equal(existsSync(join(out, "transient-canvas.png.checked")), false);
    assert.match(
      readFileSync(join(out, "transient-canvas.png.withheld"), "utf8"),
      /opaque content requiring screenshot masking/,
    );
    assert.ok(!everything(out).includes(TOKEN));
    const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
    assert.equal(scan.status, 0, scan.stdout);
  },
);

test(
  "a closed root present before CDP attachment withholds its image",
  { skip: noBrowser },
  async (t) => {
    const { chromium } = createRequire(join(playwright, "package.json"))("playwright-core");
    const userData = fresh("cdp-browser");
    const context = await chromium.launchPersistentContext(userData, {
      args: ["--remote-debugging-port=0"],
    });
    try {
      const page = context.pages()[0];
      await page.setContent('<p>parent evidence</p><div id="host" aria-hidden="true"></div>');
      await page.evaluate(() => {
        const root = document.getElementById("host").attachShadow({ mode: "closed" });
        root.textContent = "tok-8b1d2e3f4a5c6b7d8e9f";
      });
      // Chromium publishes this file asynchronously, even after the context is usable.
      const port = await t.waitFor(
        () => {
          const value = readFileSync(join(userData, "DevToolsActivePort"), "utf8").split("\n")[0];
          assert.match(value, /^[1-9]\d{0,4}$/);
          assert.ok(Number(value) <= 65535);
          return value;
        },
        { timeout: 5000, interval: 25 },
      );
      const privateDir = privateWithAccount();
      const out = fresh("cdp-shadow-evidence");
      const run = drive(
        privateDir,
        out,
        'export default async ({ capture }) => { await capture("preexisting"); };',
        ["--cdp", `http://127.0.0.1:${port}`],
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(existsSync(join(out, "preexisting.png")), false);
      assert.equal(existsSync(join(out, "preexisting.png.checked")), false);
      assert.match(
        readFileSync(join(out, "preexisting.png.withheld"), "utf8"),
        /closed shadow root/,
      );
      assert.ok(!everything(out).includes(TOKEN));
      const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
      assert.equal(scan.status, 0, scan.stdout);
    } finally {
      await context.close();
    }
  },
);

for (const placement of ["existing host", "prebuilt host", "prebuilt subtree"]) {
  test(
    `a real ${placement} closed root added and removed during rasterization cannot receive a checked image`,
    { skip: noBrowser },
    () => {
      const privateDir = privateWithAccount();
      const out = fresh("transient-shadow-evidence");
      const run = drive(
        privateDir,
        out,
        `export default async ({ page, capture }) => {
    await page.setContent('<p>parent evidence</p><div id="host" aria-hidden="true"></div>');
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async options => {
      await page.evaluate(() => {
        if (${placement !== "existing host"}) {
          document.getElementById("host").remove();
          const subtree = document.createElement("section");
          const host = document.createElement("div"); host.id = "host"; host.setAttribute("aria-hidden", "true");
          host.attachShadow({ mode: "closed" }).textContent = ${JSON.stringify(TOKEN)};
          subtree.appendChild(host); document.body.appendChild(${placement === "prebuilt host" ? "host" : "subtree"});
        } else { ${closedContent("text", TOKEN)} }
      });
      const png = await screenshot(options);
      await page.locator("#host").evaluate(host => host.remove());
      return png;
    };
    await capture("transient");
    if (await page.locator("#host").count() !== 0) throw new Error("transient fixture remained attached");
  };`,
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        existsSync(join(out, "transient.png")),
        false,
        "transient closed pixels were kept",
      );
      assert.equal(existsSync(join(out, "transient.png.checked")), false);
      assert.match(
        readFileSync(join(out, "transient.png.withheld"), "utf8"),
        /closed shadow root|inspection unavailable/,
      );
      assert.ok(!everything(out).includes(TOKEN));
      const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
      assert.equal(scan.status, 0, scan.stdout);
    },
  );
}

test(
  "a document reset during rasterization invalidates the closed-root inspection",
  { skip: noBrowser },
  () => {
    const privateDir = privateWithAccount();
    const out = fresh("reset-shadow-evidence");
    const run = drive(
      privateDir,
      out,
      `export default async ({ page, capture }) => {
    await page.setContent('<p>ordinary parent evidence</p>');
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async options => {
      await page.setContent('<p>replacement document</p><div id="host" aria-hidden="true"></div>');
      await page.evaluate(() => { ${closedContent("canvas", TOKEN)} });
      const png = await screenshot(options);
      await page.setContent('<p>ordinary final document</p>');
      return png;
    };
    await capture("reset");
  };`,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(out, "reset.png")), false);
    assert.equal(existsSync(join(out, "reset.png.checked")), false);
    assert.match(readFileSync(join(out, "reset.png.withheld"), "utf8"), /inspection unavailable/);
    assert.ok(!everything(out).includes(TOKEN));
    const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
    assert.equal(scan.status, 0, scan.stdout);
  },
);

for (const phase of ["before", "after"]) {
  test(
    `unavailable closed-root inspection ${phase} rasterization withholds without leaking protocol errors`,
    { skip: noBrowser },
    () => {
      const privateDir = privateWithAccount();
      const out = fresh("unavailable-shadow-inspection");
      const run = drive(
        privateDir,
        out,
        `export default async ({ page, capture }) => {
      await page.setContent('<p>ordinary parent evidence</p>');
      await capture("unavailable");
      const context = page.context();
      const createSession = context.newCDPSession.bind(context);
      context.newCDPSession = async page => {
        const session = await createSession(page);
        const send = session.send.bind(session);
        let documents = 0;
        session.send = async (method, params) => {
          if (method === "DOM.getDocument" && ++documents === ${phase === "before" ? 1 : 2})
            throw new Error(${JSON.stringify(TOKEN)});
          return send(method, params);
        };
        return session;
      };
      await capture("unavailable");
    };`,
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(existsSync(join(out, "unavailable.png")), false);
      assert.equal(existsSync(join(out, "unavailable.png.checked")), false);
      assert.match(
        readFileSync(join(out, "unavailable.png.withheld"), "utf8"),
        /inspection unavailable/,
      );
      assert.ok(!everything(out).includes(TOKEN));
      assert.ok(!run.stderr.includes(TOKEN));
      const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
      assert.equal(scan.status, 0, scan.stdout);
    },
  );
}
