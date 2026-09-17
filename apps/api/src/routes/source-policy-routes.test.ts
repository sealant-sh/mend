import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";

/**
 * The source policy at the routes (docs/adr/0003, "Multi mode gate"): a remote Mend may not reach
 * is refused before any clone, fetch or write.
 */
describe("git remotes Mend may not reach", () => {
  let api: TenancyApi;
  beforeAll(async () => {
    api = await createTenancyApi();
  });
  afterAll(async () => {
    await api.dispose();
  });
  beforeEach(() => {
    api.world.calls.splice(0, api.world.calls.length);
  });

  it.each([
    ["a local path", "/srv/git/secrets.git"],
    ["the metadata service", "https://169.254.169.254/latest/meta-data.git"],
    ["this machine, for someone who is not the operator", "ssh://git@127.0.0.1/acme/api.git"],
  ])("a reference from %s is refused before anything is cloned", async (_label, source) => {
    // bob owns organization B and is not the operator.
    const response = await api.request("bob", "POST", "/api/references", {
      name: "ref",
      source,
      ref: "main",
    });
    expect({ status: response.status, calls: api.world.calls }).toEqual({
      status: 422,
      calls: [],
    });
  });

  it("a dotfiles repository on this machine is refused before it is saved", async () => {
    const response = await api.request("carol", "PUT", "/api/dotfiles/repository", {
      repository: { url: "ssh://git@localhost/carol/dotfiles.git", ref: null },
    });
    expect({ status: response.status, calls: api.world.calls }).toEqual({
      status: 422,
      calls: [],
    });
  });
});
