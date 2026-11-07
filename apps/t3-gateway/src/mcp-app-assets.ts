import type { McpAppSnapshot } from "@mend/domain/workbench";
import {
  readMcpAppCsp,
  injectMcpAppCsp,
  injectMcpAppCookieBootstrap,
  injectMcpAppThemeBootstrap,
  MCP_APP_MAX_HTML_BYTES,
} from "@mend/t3-contracts/mcp-app";

/** The same CSP, cookie and theme bootstrap ordering as T3 v0.1.2's saved captures. */
export const mcpAppDocument = (app: McpAppSnapshot): Uint8Array | null => {
  if (Buffer.byteLength(app.html) > MCP_APP_MAX_HTML_BYTES) return null;
  return new TextEncoder().encode(
    injectMcpAppCookieBootstrap(
      injectMcpAppThemeBootstrap(injectMcpAppCsp(app.html, readMcpAppCsp(app.csp))),
    ),
  );
};

/** A captured app grant keeps identities only and reauthorizes every HTTP read. */
export type McpAppAsset = {
  readonly kind: "mcp-app";
  readonly sessionId: string;
  readonly itemId: string;
};
