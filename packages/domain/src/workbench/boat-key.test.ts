import { describe, expect, it } from "vitest";

import {
  BOAT_KEY_COMMAND_PERMISSIONS,
  BOAT_KEY_REQUIRED_PERMISSIONS,
  boatKeyCreateCommand,
  boatKeyLine,
  missingBoatKeyPermissions,
} from "./boat-key.ts";

describe("the Boat key's permissions", () => {
  it("asks for every required permission and account.read in the command, in both forms", () => {
    const actions = BOAT_KEY_COMMAND_PERMISSIONS.join(",");
    expect(boatKeyCreateCommand(null)).toBe(
      `boat --org personal api-key create mend --ttl 365d --actions ${actions}`,
    );
    expect(boatKeyCreateCommand("acme")).toBe(
      `boat --org acme api-key create mend --ttl 365d --actions ${actions}`,
    );
    expect(missingBoatKeyPermissions(BOAT_KEY_COMMAND_PERMISSIONS)).toEqual([]);
  });

  it("does not take sandbox.delete-own for sandbox.delete, and takes * for everything", () => {
    const ci = BOAT_KEY_REQUIRED_PERMISSIONS.filter(
      (permission) => permission !== "sandbox.delete",
    );
    expect(missingBoatKeyPermissions([...ci, "sandbox.delete-own"])).toEqual(["sandbox.delete"]);
    expect(missingBoatKeyPermissions(["*"])).toEqual([]);
    expect(missingBoatKeyPermissions([])).toEqual(BOAT_KEY_REQUIRED_PERMISSIONS);
  });
});

describe("boatKeyLine (SLNT-797)", () => {
  it("says which key a Boat session runs on, from where the reader stands", () => {
    expect(boatKeyLine("person", "your")).toBe("Boat · your own Boat key");
    expect(boatKeyLine("person", "Carol's")).toBe("Boat · Carol's own Boat key");
    expect(boatKeyLine("person")).toBe("Boat · its owner's own Boat key");
    expect(boatKeyLine("organization")).toBe("Boat · the organization's Boat key");
    expect(boatKeyLine("server")).toBe("Boat · the server's Boat key");
  });
});
