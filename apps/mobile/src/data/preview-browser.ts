import { openBrowserAsync } from "expo-web-browser";

import { browserFailureOf, browserRefusalOf, type ReservePreviewBrowser } from "@/data/previews";

export const reservePreviewBrowser: ReservePreviewBrowser = () => ({
  show: (url) => openBrowserAsync(url).then(browserRefusalOf, browserFailureOf),
  abandon: () => undefined,
});
