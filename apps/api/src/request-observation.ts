import { requestPathOf, routedPath } from "@mend/network";
import type { ObservationPolicy } from "@mend/network/http-observation";

import { routesToPageView } from "./routes/pages.ts";

const RAW_FILE_READ = /^\/api\/worktrees\/.+\/raw$/;
const UNREGISTER_NAMING_PUSH_TOKEN = /^\/api\/devices\/./;

/** What the API leaves out of its request log and traces: a raw file read, a device, a page view. */
export const apiObservation: ObservationPolicy = {
  unobserved: (request) => {
    const path = routedPath(requestPathOf(request.url)).replace(/\/+$/, "");
    return (
      RAW_FILE_READ.test(path) ||
      UNREGISTER_NAMING_PUSH_TOKEN.test(path) ||
      routesToPageView(request)
    );
  },
};
