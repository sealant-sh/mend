// The verify skill's leak paths for frames: readable frames, and frames inside shadow roots. Each
// case needs the skill's Playwright (see leaks.test.mjs) and is skipped, with that reason, where it
// is not installed.
//
//   node --test .claude/skills/verify/scripts/leaks.frames.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  here,
  noBrowser,
  TOKEN,
  fresh,
  everything,
  privateWithAccount,
  node,
  drive,
} from "./leaks.helpers.mjs";

for (const { nested, shadow } of [
  { nested: false, shadow: false },
  { nested: true, shadow: false },
  { nested: false, shadow: true },
]) {
  test(
    `readable ${shadow ? "open shadow" : nested ? "nested" : "direct"} frames withhold images while retaining parent snapshots`,
    { skip: noBrowser },
    () => {
      const privateDir = privateWithAccount();
      const snapshots = [];
      for (const [shown, parent] of [
        [TOKEN, "parent evidence"],
        ["ordinary frame text", "parent evidence"],
        ["ordinary frame text", "changed parent evidence"],
      ]) {
        const out = fresh("frame-evidence");
        const run = drive(
          privateDir,
          out,
          `export default async ({ page, capture }) => {
        await page.setContent('<p>${parent}</p><div id="host"></div>');
        await page.evaluate(shadow => {
          const host = document.getElementById("host");
          const root = shadow ? host.attachShadow({ mode: "open" }) : host;
          const frame = document.createElement("iframe");
          frame.name = "outer"; frame.setAttribute("aria-hidden", "true"); frame.style = "width:800px;height:200px";
          root.appendChild(frame);
        }, ${shadow});
        const outer = page.frame({ name: "outer" });
        if (!outer) throw new Error("outer frame did not attach");
        if (${nested}) await outer.setContent('<iframe name="inner" style="width:700px;height:150px"></iframe>');
        const target = ${nested} ? page.frame({ name: "inner" }) : outer;
        if (!target) throw new Error("content frame did not attach");
        await target.setContent('<p style="font:24px monospace">' + ${JSON.stringify(shown)} + '</p>');
        if (await target.locator("p").textContent() !== ${JSON.stringify(shown)}) throw new Error("frame fixture text was not readable");
        await capture("frame");
      };`,
        );
        assert.equal(run.status, 0, run.stderr);
        const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
        assert.equal(scan.status, 0, scan.stdout);
        assert.equal(existsSync(join(out, "frame.png")), false);
        assert.equal(existsSync(join(out, "frame.png.checked")), false);
        assert.match(
          readFileSync(join(out, "frame.png.withheld"), "utf8"),
          /opaque content requiring screenshot masking/,
        );
        const snapshot = readFileSync(join(out, "frame.aria.yml"), "utf8");
        assert.ok(snapshot.includes(parent), "parent snapshot evidence was lost");
        snapshots.push(snapshot);
        assert.ok(!everything(out).includes(TOKEN), "credential reached text or metadata evidence");
      }
      assert.equal(snapshots[0], snapshots[1], "frame content entered the snapshot");
      assert.notEqual(snapshots[1], snapshots[2], "changed parent snapshot evidence was lost");
    },
  );
}

for (const openInsideClosed of [false, true]) {
  test(
    `a frame inside a closed shadow root with open descendant ${openInsideClosed} withholds its image`,
    { skip: noBrowser },
    () => {
      const privateDir = privateWithAccount();
      const out = fresh("closed-frame-evidence");
      const run = drive(
        privateDir,
        out,
        `export default async ({ page, capture }) => {
      await page.setContent('<p>parent evidence</p><div id="host" aria-hidden="true"></div>');
      await page.evaluate(openInsideClosed => {
        let root = document.getElementById("host").attachShadow({ mode: "closed" });
        if (openInsideClosed) {
          const inner = document.createElement("div"); root.appendChild(inner);
          root = inner.attachShadow({ mode: "open" });
        }
        const frame = document.createElement("iframe"); frame.name = "closed";
        frame.style = "width:800px;height:200px"; root.appendChild(frame);
      }, ${openInsideClosed});
      const target = page.frame({ name: "closed" });
      if (!target) throw new Error("closed-shadow frame did not attach");
      await target.setContent('<p>${TOKEN}</p>');
      if (await target.locator("p").textContent() !== ${JSON.stringify(TOKEN)}) throw new Error("closed frame fixture was not readable");
      await capture("closed");
    };`,
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(existsSync(join(out, "closed.png")), false, "unmaskable frame image was kept");
      assert.equal(existsSync(join(out, "closed.png.checked")), false);
      assert.match(
        readFileSync(join(out, "closed.png.withheld"), "utf8"),
        /frame that cannot be masked/,
      );
      assert.ok(!everything(out).includes(TOKEN));
      const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
      assert.equal(scan.status, 0, scan.stdout);
    },
  );
}
