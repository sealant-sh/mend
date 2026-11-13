import { describe, expect, it } from "vitest";

import {
  BOAT_KEY_COMMAND_PERMISSIONS,
  BOAT_KEY_REQUIRED_PERMISSIONS,
  boatKeyCreateCommand,
  missingBoatKeyPermissions,
} from "./boat-key.ts";

describe("the Boat key's permissions", () => {
  it("asks for every required permission and account.read in the command, in both forms", () => {
    const actions = BOAT_KEY_COMMAND_PERMISSIONS.join(",");
    expect(boatKeyCreateCommand(null)).toBe(
      `boat api-key create mend --ttl 365d --actions ${actions}`,
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
