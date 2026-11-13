import { Buffer } from "node:buffer";

import { codexMcpAppTarget, type AgentMcpApps } from "@mend/agent-protocol";
import type { McpAppsRepo } from "@mend/db";
import {
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_MIME_TYPE,
  McpAppCsp,
  McpAppDocument,
  McpAppPermissions,
  type AgentItem,
} from "@mend/domain/workbench";
import { Cause, Effect, Option, Schema } from "effect";

const resource = Schema.Struct({
  uri: Schema.optional(Schema.String),
  mimeType: Schema.String,
  text: Schema.optional(Schema.String),
  blob: Schema.optional(Schema.String),
  _meta: Schema.optional(Schema.Unknown),
});
const parseResource = Schema.decodeUnknownOption(resource);
const domain = (value: unknown) =>
  Option.isSome(Schema.decodeUnknownOption(McpAppCsp)({ connectDomains: [value] }));

const documentOf = (contents: ReadonlyArray<unknown>, uri: string): McpAppDocument | null => {
  for (const raw of contents) {
    const parsed = parseResource(raw);
    if (Option.isNone(parsed)) continue;
    const content = parsed.value;
    if (content.uri !== undefined && content.uri !== uri) continue;
    if (content.mimeType.replace(/\s+/g, "").toLowerCase() !== MCP_APP_MIME_TYPE) continue;
    if (
      content.text !== undefined
        ? content.text.length > MCP_APP_MAX_HTML_BYTES
        : (content.blob?.length ?? 0) > Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4
    )
      return null;
    const html =
      content.text ??
      (content.blob === undefined
        ? undefined
        : Buffer.from(content.blob, "base64").toString("utf8"));
    if (html === undefined || html.trim() === "") continue;
    if (new TextEncoder().encode(html).byteLength > MCP_APP_MAX_HTML_BYTES) return null;
    const meta = Schema.decodeUnknownOption(
      Schema.Struct({ ui: Schema.Record(Schema.String, Schema.Unknown) }),
      // oxlint-disable-next-line no-underscore-dangle -- _meta is the MCP protocol field.
    )(content._meta);
    const ui = Option.isSome(meta) ? meta.value.ui : {};
    const rawCsp = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(ui.csp);
    const csp: Record<string, ReadonlyArray<string>> = {};
    if (Option.isSome(rawCsp))
      for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"]) {
        const values = rawCsp.value[key];
        if (!Array.isArray(values)) continue;
        const allowed = values
          .filter((value): value is string => typeof value === "string" && domain(value))
          .slice(0, 32);
        if (allowed.length > 0) csp[key] = allowed;
      }
    const rawPermissions = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(
      ui.permissions,
    );
    const allowedPermissions: Record<string, Record<string, never>> = {};
    if (Option.isSome(rawPermissions))
      for (const key of Object.keys(McpAppPermissions.fields)) {
        if (
          Option.isSome(
            Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(
              rawPermissions.value[key],
            ),
          )
        )
          allowedPermissions[key] = {};
      }
    const permissions =
      Object.keys(allowedPermissions).length === 0
        ? Option.none()
        : Schema.decodeUnknownOption(McpAppPermissions)(allowedPermissions);
    const document = Schema.decodeUnknownOption(McpAppDocument)({
      html,
      ...(Object.keys(csp).length === 0 ? {} : { csp }),
      ...(Option.isNone(permissions) ? {} : { permissions: permissions.value }),
      ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
    });
    return Option.isSome(document) ? document.value : null;
  }
  return null;
};

/** Captures once, outside protocol ingestion, so the resource response can still be read. */
export const captureMcpApp = (
  repo: McpAppsRepo["Service"],
  item: AgentItem,
  apps: AgentMcpApps,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (item.kind !== "tool-call" || item.status !== "completed") return;
    const target = codexMcpAppTarget(item.data);
    if (target === null) return;
    const result = Schema.decodeUnknownOption(
      Schema.Struct({
        result: Schema.Unknown,
        error: Schema.optional(Schema.NullOr(Schema.Unknown)),
      }),
    )(item.data);
    if (Option.isNone(result) || result.value.result == null || result.value.error != null) return;
    if ((yield* repo.byItem(item.id)) !== null) return;
    const response = yield* apps
      .readResource({ server: target.server, uri: target.resourceUri })
      .pipe(Effect.timeout("20 seconds"));
    const document = documentOf(response.contents, target.resourceUri);
    if (document !== null) yield* repo.save(item.id, target, document);
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      () =>
        Effect.logWarning("MCP app capture failed; showing the tool result.").pipe(
          Effect.annotateLogs({ itemId: item.id, processId: item.processId }),
        ),
    ),
    Effect.orDie,
  );
