import { createInterface } from "node:readline";

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
const names =
  process.env.MEND_DESKTOP_MODE === "code"
    ? ["screenshot", "execute"]
    : ["screenshot", "click", "type", "key", "scroll", "open_browser"];
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
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
          const response = await fetch("http://127.0.0.1:6090/action", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-mend-pilot": process.env.MEND_DESKTOP_PILOT_TOKEN ?? "",
            },
            body: JSON.stringify({ ...message.params.arguments, name: message.params.name }),
            signal: AbortSignal.timeout(35000),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? "Desktop action failed");
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
