import { dockerReady, fixtureImage } from "@mend/sessions/testing";

/**
 * Builds the Xvnc image the screen tests start, once, before any file runs, so no file's budget
 * pays for apt (SLNT-991). A failed build is left to the files that need the image, which build it
 * again and report it.
 */
export default function setup(): void {
  if (!dockerReady) return;
  try {
    fixtureImage("xvnc");
  } catch {}
}
