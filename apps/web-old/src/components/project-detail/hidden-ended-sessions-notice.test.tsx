import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HiddenEndedSessionsNotice } from "./hidden-ended-sessions-notice";

describe("HiddenEndedSessionsNotice", () => {
  it("renders nothing when every session is visible", () => {
    expect(renderToStaticMarkup(<HiddenEndedSessionsNotice count={0} />)).toBe("");
  });

  it("states the captured fact for one ended session", () => {
    expect(renderToStaticMarkup(<HiddenEndedSessionsNotice count={1} />)).toContain(
      "1 ended session hidden because Mend did not capture a transcript.",
    );
  });

  it("renders the multiple-session count", () => {
    expect(renderToStaticMarkup(<HiddenEndedSessionsNotice count={2} />)).toContain(
      "2 ended sessions hidden because Mend did not capture a transcript.",
    );
  });
});
