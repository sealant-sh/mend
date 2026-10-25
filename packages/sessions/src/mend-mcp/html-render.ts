import { HTML_RENDER_TOOL, PAGE_LIMITS } from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { asCaller } from "./caller.ts";
import { SessionPages } from "./session-pages.ts";

export const MendMcpFailure = Schema.TaggedStruct("MendMcpFailure", {
  code: Schema.Literals([
    "invalid_request",
    "call_reused",
    "session_not_found",
    "storage_unavailable",
  ]),
  message: Schema.String,
});
export type MendMcpFailure = typeof MendMcpFailure.Type;

const failure = (code: MendMcpFailure["code"], message: string): MendMcpFailure =>
  MendMcpFailure.make({ code, message });

const PUBLISHED_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

const PAGE_RULES = [
  "Write one self-contained document with inline <style> and <script>.",
  `Embed images as data: URIs and put scripts and styles inline: a page that names a local file (src="/abs/shot.png", src="chart.png", CSS url(bg.webp)) is refused. Remote http(s) URLs, such as a CDN chart library, load as they are.`,
  "Use a fluid width and leave html, body and the outermost element without a background, so the page sits on the conversation's own background.",
  "Let content set the page's height: vh, svh, lvh and dvh units are refused, and height:100% on html or body grows the frame without end. Give charts fixed pixel heights.",
].join(" ");

// Codex asks no approval for a tool with `readOnlyHint` (`requires_mcp_tool_approval`).
export const HtmlRenderTool = Tool.make(HTML_RENDER_TOOL, {
  description: `Show a finished HTML page (chart, table, diagram, mockup) inline in this Mend session's conversation, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. ${PAGE_RULES}`,
  parameters: Schema.Struct({
    html: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PAGE_LIMITS.htmlChars),
    ).annotate({ description: "A complete, self-contained HTML document." }),
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PAGE_LIMITS.titleChars),
    ).annotate({ description: "Short name for the page." }),
    height: Schema.Int.annotate({
      description: `The frame height in CSS pixels, ${PAGE_LIMITS.minHeight}-${PAGE_LIMITS.maxHeight}: the height the page needs at about 728px wide.`,
    }),
  }),
  success: Schema.Struct({
    htmlRender: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      height: Schema.Number,
    }),
    message: Schema.String,
  }),
  failure: MendMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Title, "Render HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HtmlRenderToolkit = Toolkit.make(HtmlRenderTool);

const HtmlRenderHandlers = HtmlRenderToolkit.toLayer(
  Effect.gen(function* () {
    const pages = yield* SessionPages;
    return {
      html_render: asCaller((input, caller) =>
        Effect.gen(function* () {
          const page = yield* pages.publish(caller, input).pipe(
            Effect.catchTags({
              PageRejectedError: (error) => Effect.fail(failure("invalid_request", error.message)),
              SessionPageConflictError: () =>
                Effect.fail(
                  failure(
                    "call_reused",
                    "This call's key already published another page in this session; call the tool again.",
                  ),
                ),
              SessionPageSessionNotFoundError: () =>
                Effect.fail(
                  failure(
                    "session_not_found",
                    "Mend no longer has this session, so the page cannot be stored in it.",
                  ),
                ),
              SessionPageStorageError: () =>
                Effect.fail(
                  failure(
                    "storage_unavailable",
                    "Mend could not reach its database to store the page. Call the tool again in a moment.",
                  ),
                ),
            }),
          );
          return {
            htmlRender: { attachmentId: page.id, title: page.title, height: page.height },
            message: PUBLISHED_MESSAGE,
          };
        }),
      ),
    };
  }),
);

export const HtmlRenderToolkitLive: Layer.Layer<never, never, SessionPages> = McpServer.toolkit(
  HtmlRenderToolkit,
).pipe(Layer.provide(HtmlRenderHandlers));
