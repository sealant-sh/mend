import { dockerReady, fixtureImage } from "./xvnc.ts";

/**
 * Builds the Docker fixtures once, before any file runs, so no file's budget pays for apt. A
 * failed build is left to the files that need the image, which build it again and report it.
 */
export default function setup(): void {
  if (!dockerReady) return;
  try {
    fixtureImage("screen");
    fixtureImage("xvnc");
  } catch {}
}
