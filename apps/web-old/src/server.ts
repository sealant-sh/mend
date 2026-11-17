import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { fillCriticalCss, makeCriticalCss } from "./server/critical-css.ts";

import fullCss from "./styles.css?inline";

/** The page's own subset of the full sheet, inlined as it is served (`server/critical-css.ts`). */
const criticalCss = makeCriticalCss(fullCss);

export default createServerEntry({
  fetch: async (request, options) => {
    const response = await handler.fetch(request, options);
    if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(fillCriticalCss(await response.text(), criticalCss), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
});
