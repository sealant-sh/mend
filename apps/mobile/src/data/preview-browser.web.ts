import type { ReservePreviewBrowser } from "@/data/previews";

export const reservePreviewBrowser: ReservePreviewBrowser = () => {
  const tab = window.open("", "_blank");
  if (tab !== null) tab.opener = null;
  return {
    show: (url) => {
      if (tab === null) return Promise.resolve("the browser blocked the new tab");
      tab.location.replace(url);
      return Promise.resolve(null);
    },
    abandon: () => tab?.close(),
  };
};
