import { beforeEach, describe, expect, it, vi } from "vitest";

import { showErrorToast } from "./error-toast.js";
import { MendApiError } from "./mend-http.js";
import { sayAdoptFailed, sayCreateFailed } from "./new-session-input.js";
import { reportOpenFailure } from "./open-command.js";
import { commands, fake, window } from "./test-vscode.js";

vi.mock("vscode", () => import("./test-vscode.js"));

const signedOut = new MendApiError("Signed out — sign in again.", 401, "Unauthorized");

describe("showErrorToast", () => {
  beforeEach(() => fake.reset());

  it("says a refused sign-in in Mend's words alone, with Connect, whoever met it", async () => {
    window.showErrorMessage.mockResolvedValueOnce("Connect to server");
    const retried = await showErrorToast(
      signedOut,
      "Mend could not adopt api · Signed out — sign in again.",
      "Try again",
    );
    expect(retried).toBe(false);
    await showErrorToast(signedOut, "Signed out — sign in again.");
    expect(window.showErrorMessage.mock.calls).toEqual([
      ["Signed out — sign in again.", "Connect to server"],
      ["Signed out — sign in again.", "Connect to server"],
    ]);
    expect(commands.executeCommand.mock.calls).toEqual([["mend.connect"]]);
  });

  it("says a refused sign-in once while its toast shows, when a read and a click meet it at once", async () => {
    const toast = Promise.withResolvers<string | undefined>();
    window.showErrorMessage.mockImplementationOnce(() => toast.promise);
    const read = showErrorToast(signedOut, "Signed out — sign in again.");
    const click = showErrorToast(signedOut, "Mend could not create the session · …", "Try again");
    toast.resolve(undefined);
    expect(await Promise.all([read, click])).toEqual([false, false]);
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
  });

  it("offers Try again for any other failure, and says whether she picked it", async () => {
    const unreachable = new MendApiError("The Mend server did not answer.", null);
    window.showErrorMessage.mockResolvedValueOnce("Try again");
    expect(await showErrorToast(unreachable, "Could not set up · no answer", "Try again")).toBe(
      true,
    );
    expect(await showErrorToast(new Error("boom"), "boom", "Try again")).toBe(false);
    expect(window.showErrorMessage.mock.calls).toEqual([
      ["Could not set up · no answer", "Try again"],
      ["boom", "Try again"],
    ]);
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });
});

describe("the toasts that go through it", () => {
  beforeEach(() => fake.reset());

  it("an Open that failed: a refused sign-in reads Mend's words, with Connect", async () => {
    expect(await reportOpenFailure("Could not open add-rate-limit · …", "Retry", signedOut)).toBe(
      undefined,
    );
    window.showErrorMessage.mockResolvedValueOnce("Retry");
    const unreached = new MendApiError("Cannot reach Mend at http://mend-mini:3105.", null);
    expect(await reportOpenFailure("Could not open add-rate-limit", "Retry", unreached)).toBe(
      "Retry",
    );
    expect(window.showErrorMessage.mock.calls).toEqual([
      ["Signed out — sign in again.", "Connect to server"],
      ["Could not open add-rate-limit", "Retry"],
    ]);
  });

  it("an adopt that failed: a refused sign-in reads Mend's words, with Connect", async () => {
    await sayAdoptFailed("newsroom-api", signedOut);
    await sayAdoptFailed("newsroom-api", new MendApiError("That repository is private.", 422));
    expect(window.showErrorMessage.mock.calls).toEqual([
      ["Signed out — sign in again.", "Connect to server"],
      ["Mend could not adopt newsroom-api · That repository is private."],
    ]);
  });

  it("a create that failed offers Try again, and a refused sign-in reads Mend's words", async () => {
    window.showErrorMessage.mockResolvedValueOnce("Try again");
    expect(await sayCreateFailed(new MendApiError("The store is full.", 507))).toBe(true);
    expect(await sayCreateFailed(signedOut)).toBe(false);
    expect(window.showErrorMessage.mock.calls).toEqual([
      ["Mend could not create the session · The store is full.", "Try again"],
      ["Signed out — sign in again.", "Connect to server"],
    ]);
  });
});
