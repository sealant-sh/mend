// Code executes only in the disposable workspace. This is not a JavaScript security sandbox.
import { readFile } from "node:fs/promises";

import { performAction, parseAction } from "./control.mjs";

const code = await readFile(process.argv[2], "utf8");
const desktop = {
  click: (x, y) => performAction(parseAction({ name: "click", x, y })),
  type: (text) => performAction(parseAction({ name: "type", text })),
  key: (keys) => performAction(parseAction({ name: "key", keys })),
  scroll: (direction, amount = 3) =>
    performAction(parseAction({ name: "scroll", direction, amount })),
  openBrowser: (url) => performAction(parseAction({ name: "open_browser", url })),
  screenshot: () => performAction({ name: "screenshot" }),
  wait: (ms) =>
    new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 5000))),
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
await new AsyncFunction("desktop", code)(desktop);
