export const PAGE_HTML = `<!doctype html><style>.bar{height:24px}</style><div class=bar>${"p99 ".repeat(500)}</div>`;

const jsonl = (entries: ReadonlyArray<unknown>): string =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

const resultText = (attachmentId: string, title: string) =>
  JSON.stringify({
    htmlRender: { attachmentId, title, height: 420 },
    message: "Shown to the reader above your reply.",
  });

export const claudePageTranscript = (attachmentIds: ReadonlyArray<string>): string =>
  jsonl([
    { type: "user", uuid: "u1", message: { role: "user", content: "chart the latency" } },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        id: "msg_1",
        content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } }],
      },
    },
    {
      type: "user",
      uuid: "r1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: "metrics.csv" }],
      },
    },
    ...attachmentIds.flatMap((attachmentId, index) => [
      {
        type: "assistant",
        uuid: `a-page-${index}`,
        message: {
          id: `msg_page_${index}`,
          content: [
            {
              type: "tool_use",
              id: `toolu_page_${index}`,
              name: "mcp__mend__html_render",
              input: { html: PAGE_HTML, title: `Latency ${index}`, height: 420 },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: `r-page-${index}`,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `toolu_page_${index}`,
              content: [{ type: "text", text: resultText(attachmentId, `Latency ${index}`) }],
            },
          ],
        },
      },
    ]),
    {
      type: "assistant",
      uuid: "a-last",
      message: { id: "msg_last", content: [{ type: "text", text: "eu-west is the outlier." }] },
    },
  ]);

const TIMING = "Wall time: 0.0213 seconds\nOutput:";

export const CODEX_OUTPUTS = {
  timed: (result: string): unknown => `${TIMING}\n${result}`,
  items: (result: string): unknown => [
    { type: "input_text", text: TIMING },
    { type: "input_text", text: result },
  ],
  envelope: (result: string): unknown => ({ content: [{ type: "text", text: result }] }),
} as const;

export const codexPageTranscript = (
  attachmentIds: ReadonlyArray<string>,
  output: (result: string) => unknown = CODEX_OUTPUTS.timed,
): string =>
  jsonl([
    { type: "session_meta", payload: { id: "codex-session" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "chart the latency" }],
      },
    },
    ...attachmentIds.flatMap((attachmentId, index) => [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          namespace: "mcp__mend__",
          name: "html_render",
          arguments: JSON.stringify({ html: PAGE_HTML, title: `Latency ${index}`, height: 420 }),
          call_id: `call_page_${index}`,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: `call_page_${index}`,
          output: output(resultText(attachmentId, `Latency ${index}`)),
        },
      },
    ]),
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "eu-west is the outlier." }],
      },
    },
  ]);
