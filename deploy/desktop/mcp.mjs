import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const sessionClient = process.argv[2] === "--session";
const harness = process.argv[3];
const lease = randomUUID();
let recording = false;
const exec = promisify(execFile);
async function ensureDesktop() {
  const sessionId = process.env.MEND_SESSION_ID;
  if (!sessionId)
    throw new Error("Desktop tools need a Mend session. Start a session in Mend first.");
  let state;
  try {
    const response = await fetch("http://127.0.0.1:6090/state", {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) state = await response.json();
  } catch {
    /* The recorded Service has not started yet. */
  }
  if (state && state.sessionId !== sessionId)
    throw new Error("The live desktop belongs to another session in this workspace.");
  if (!state) {
    await exec(
      "mend",
      [
        "service",
        "run",
        "--port",
        "6090",
        "--name",
        "desktop",
        "--http",
        "--",
        "env",
        `MEND_DESKTOP_SESSION_ID=${sessionId}`,
        `CODEX_HOME=/home/mend-desktop-${sessionId}/.codex`,
        `CLAUDE_CONFIG_DIR=/home/mend-desktop-${sessionId}/.claude`,
        "/opt/mend-desktop/start",
      ],
      { timeout: 60000, maxBuffer: 64000 },
    );
  }
}
async function controller(path, value) {
  const token = sessionClient
    ? await readFile(`/tmp/mend-desktop-${process.getuid()}.token`, "utf8")
    : (process.env.MEND_DESKTOP_PILOT_TOKEN ?? "");
  const response = await fetch(`http://127.0.0.1:6090${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mend-pilot": token,
      ...(sessionClient ? { "x-mend-desktop-lease": lease } : {}),
    },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(35000),
  });
  const result = await response.json();
  if (!response.ok) {
    if (sessionClient && [403, 409].includes(response.status)) recording = false;
    throw new Error(result.error ?? "Desktop operation failed");
  }
  return result;
}
async function begin(goal) {
  await ensureDesktop();
  const run = await controller("/session/begin", {
    sessionId: process.env.MEND_SESSION_ID,
    lease,
    harness,
    mode: "code",
    model: "",
    goal,
  });
  recording = true;
  return run;
}
async function finish(result, interrupted = false) {
  const run = await controller("/session/finish", { lease, result, interrupted });
  recording = false;
  return run;
}

const actions = {
  screenshot: {
    description: "See the current 1440x900 desktop. Coordinates refer to these exact pixels.",
    properties: {},
    required: [],
  },
  click: {
    description: "Left click and see the resulting screen.",
    properties: {
      x: { type: "integer", minimum: 0, maximum: 1439 },
      y: { type: "integer", minimum: 0, maximum: 899 },
    },
    required: ["x", "y"],
  },
  type: {
    description: "Type literal text into the focused control.",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  key: {
    description: "Press an X11 key or chord, such as Return, ctrl+l, ctrl+a.",
    properties: { keys: { type: "string" } },
    required: ["keys"],
  },
  scroll: {
    description: "Scroll at the current pointer position.",
    properties: {
      direction: { type: "string", enum: ["up", "down"] },
      amount: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["direction", "amount"],
  },
  open_browser: {
    description: "Open an HTTP(S) URL in the visible Chromium on this desktop.",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  execute: {
    description:
      "Execute JavaScript in this disposable Linux workspace. Use await desktop.click(x,y), desktop.type(text), desktop.key(keys), desktop.openBrowser(url), desktop.scroll(direction,amount), desktop.wait(ms). Several actions can run in one call. Returns a final screenshot. No host access is provided.",
    properties: { code: { type: "string" } },
    required: ["code"],
  },
};
actions.begin_recording = {
  description:
    "Begin recording a browser verification task. Starts the session's desktop as a recorded Mend Service when needed. Refuses input while the user controls it.",
  properties: { goal: { type: "string", minLength: 1, maxLength: 8000 } },
  required: ["goal"],
};
actions.finish_recording = {
  description:
    "Finish recording and save video, screenshot, actions and your observed result to this Mend session.",
  properties: { result: { type: "string", maxLength: 8000 } },
  required: ["result"],
};
const names = sessionClient
  ? Object.keys(actions)
  : process.env.MEND_DESKTOP_MODE === "code"
    ? ["screenshot", "execute"]
    : ["screenshot", "click", "type", "key", "scroll", "open_browser"];
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
let queue = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  queue = queue
    .then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === undefined) return;
      if (message.method === "initialize")
        return reply(message.id, {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mend-desktop", version: "0.1.0" },
        });
      if (message.method === "ping") return reply(message.id, {});
      if (message.method === "tools/list")
        return reply(message.id, {
          tools: names.map((name) => ({
            name,
            description: actions[name].description,
            inputSchema: {
              type: "object",
              properties: actions[name].properties,
              required: actions[name].required,
              additionalProperties: false,
            },
          })),
        });
      if (message.method === "tools/call") {
        try {
          if (!names.includes(message.params?.name))
            throw new Error("Tool not available in this mode");
          const name = message.params.name;
          if (sessionClient && ["begin_recording", "finish_recording"].includes(name)) {
            const value =
              name === "begin_recording"
                ? await begin(message.params.arguments?.goal)
                : await finish(message.params.arguments?.result);
            return reply(message.id, { content: [{ type: "text", text: JSON.stringify(value) }] });
          }
          if (sessionClient && !recording)
            await begin("Desktop verification by the terminal agent");
          const result = await controller("/action", { ...message.params.arguments, name });
          return reply(message.id, {
            content: [{ type: "image", mimeType: "image/png", data: result.image }],
          });
        } catch (error) {
          return reply(message.id, {
            isError: true,
            content: [{ type: "text", text: error.message }],
          });
        }
      }
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
    })
    .catch((error) => process.stderr.write(error.message + "\n"));
});

async function disconnected() {
  if (sessionClient && recording)
    await finish(
      "The terminal agent disconnected. Inspect the final screenshot and action log.",
      true,
    ).catch(() => {});
}
input.on("close", () => {
  void queue.then(disconnected);
});
if (sessionClient) {
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void disconnected().finally(() => process.exit(0));
    });
}
