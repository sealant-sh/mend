import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max = 10000) => typeof value === "string" && value.length <= max;

/** Parse the desktop command boundary before any input or code executes. */
export function parseAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a desktop action");
  const { name, ...args } = value;
  if (name === "screenshot") return { name };
  if (name === "click" && integer(args.x, 0, 1439) && integer(args.y, 0, 899))
    return { name, x: args.x, y: args.y };
  if (name === "type" && text(args.text)) return { name, text: args.text };
  if (name === "key" && text(args.keys, 100) && /^[a-zA-Z0-9_+ -]+$/.test(args.keys))
    return { name, keys: args.keys };
  if (name === "scroll" && ["up", "down"].includes(args.direction) && integer(args.amount, 1, 20))
    return { name, direction: args.direction, amount: args.amount };
  if (name === "open_browser" && text(args.url, 2048)) {
    const url = new URL(args.url);
    if (["http:", "https:"].includes(url.protocol)) return { name, url: url.href };
  }
  if (name === "execute" && text(args.code, 20000) && args.code.trim())
    return { name, code: args.code };
  throw new Error("Invalid desktop action or parameters");
}

/** Run one input operation without shell interpolation. */
export async function performAction(action) {
  const options = {
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DISPLAY: ":1" },
  };
  switch (action.name) {
    case "screenshot":
      break;
    case "click":
      await exec(
        "xdotool",
        ["mousemove", String(action.x), String(action.y), "click", "1"],
        options,
      );
      break;
    case "type":
      await exec(
        "xdotool",
        ["type", "--clearmodifiers", "--delay", "10", "--", action.text],
        options,
      );
      break;
    case "key":
      await exec("xdotool", ["key", "--clearmodifiers", "--", action.keys], options);
      break;
    case "scroll":
      await exec(
        "xdotool",
        ["click", "--repeat", String(action.amount), action.direction === "up" ? "4" : "5"],
        options,
      );
      break;
    case "open_browser": {
      // chromium's wrapper detaches into its existing instance after the first launch.
      const { spawn } = await import("node:child_process");
      const browser = spawn(
        "chromium",
        [
          "--no-sandbox",
          "--no-first-run",
          "--test-type",
          "--disable-dev-shm-usage",
          "--start-maximized",
          action.url,
        ],
        { env: options.env, stdio: "ignore" },
      );
      browser.on("error", () => {});
      browser.unref();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      break;
    }
    default:
      throw new Error("Unsupported input operation");
  }
  if (action.name !== "screenshot") await new Promise((resolve) => setTimeout(resolve, 250));
  const { stdout } = await exec("import", ["-window", "root", "png:-"], {
    ...options,
    encoding: "buffer",
  });
  return stdout.toString("base64");
}
