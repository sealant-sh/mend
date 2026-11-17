// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { keyIsTaken, sessionBoatKeyLine } from "./session-view";

describe("page shortcuts", () => {
  it("leave a key typed in a comment box inside a shadow root to the box", () => {
    const host = document.createElement("diffs-container");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const box = document.createElement("textarea");
    shadow.append(box);
    let seen: { target: EventTarget | null; taken: boolean } | null = null;
    const listen = (event: KeyboardEvent) => {
      seen = { target: event.target, taken: keyIsTaken(event) };
    };
    document.addEventListener("keydown", listen);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, composed: true }));
    document.removeEventListener("keydown", listen);
    // The document sees the shadow host as the target, never the textarea.
    expect(seen).toEqual({ target: host, taken: true });
    host.remove();
  });

  it("take a key pressed on the page itself", () => {
    const button = document.createElement("button");
    document.body.append(button);
    let seen: boolean | null = null;
    const listen = (event: KeyboardEvent) => {
      seen = keyIsTaken(event);
    };
    document.addEventListener("keydown", listen);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    document.removeEventListener("keydown", listen);
    expect(seen).toBe(false);
    button.remove();
  });
});

describe("sessionBoatKeyLine (SLNT-797)", () => {
  it("says which key the session runs on from where the viewer stands", () => {
    expect(sessionBoatKeyLine("person", true, "Carol")).toBe("Boat · your own Boat key");
    // Anyone else, someone steering with shared control included, reads the owner's name.
    expect(sessionBoatKeyLine("person", false, "Carol")).toBe("Boat · Carol's own Boat key");
    expect(sessionBoatKeyLine("person", false, null)).toBe("Boat · its owner's own Boat key");
    expect(sessionBoatKeyLine("organization", false, "Carol")).toBe(
      "Boat · the organization's Boat key",
    );
    expect(sessionBoatKeyLine("server", true, null)).toBe("Boat · the server's Boat key");
    expect(sessionBoatKeyLine(null, true, "Carol")).toBeNull();
  });
});
