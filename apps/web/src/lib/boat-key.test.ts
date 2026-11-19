import { boatKeyReportFixture } from "@mend/domain/boat-key-fixtures";
import { describe, expect, it } from "vitest";

import {
  ago,
  expiryBanner,
  keyLine,
  keyWarnings,
  lastCheckLine,
  memberKeyLine,
  onDay,
  runtimeLine,
} from "./boat-key.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 19, 12);
const SEP_2 = new Date(2026, 8, 2, 9);

const expiring = (inDays: number) =>
  boatKeyReportFixture(
    {
      expiry: {
        observed: true,
        expiresAt: new Date(NOW.getTime() + inDays * DAY),
        expired: inDays <= 0,
        expiringSoon: inDays <= 14,
      },
    },
    NOW,
  );

describe("the Boat page's words", () => {
  it("says when, in words a person reads", () => {
    expect(onDay(new Date(2026, 10, 19, 8), NOW)).toBe("today");
    expect(onDay(SEP_2, NOW)).toMatch(/^on (2 Sept?|Sept? 2)$/);
    expect(onDay(new Date(2025, 8, 2), NOW)).toMatch(/2025/);
    expect(ago(new Date(NOW.getTime() - 20_000), NOW)).toBe("just now");
    expect(ago(new Date(NOW.getTime() - 60_000), NOW)).toBe("1 minute ago");
    expect(ago(new Date(NOW.getTime() - 2 * 3_600_000), NOW)).toBe("2 hours ago");
    expect(ago(SEP_2, NOW)).toMatch(/^on /);
  });

  it("names who added the key and when it expires, and never any part of the key", () => {
    const details = { connectedByName: "Grace Hopper", connectedAt: SEP_2, keyReplacedAt: null };
    const line = keyLine(details, expiring(9), NOW);
    expect(line).toMatch(/^Grace Hopper added it on .+, and it expires on .+\.$/);
    expect(line).not.toMatch(/ending in/);
    expect(keyLine({ ...details, connectedByName: null }, null, NOW)).toMatch(
      /^A removed account added it on [^,]+\.$/,
    );
    expect(keyLine({ ...details, keyReplacedAt: NOW }, null, NOW)).toMatch(
      /and it was replaced today\.$/,
    );
    expect(keyLine(details, expiring(-3), NOW)).toMatch(/\. It expired on .+\.$/);
  });

  it("raises the banner only within two weeks of expiry, and after it", () => {
    expect(expiryBanner(expiring(200), NOW, "Northwind")).toBeNull();
    expect(expiryBanner(null, NOW, "Northwind")).toBeNull();
    const soon = expiryBanner(expiring(9), NOW, "Northwind");
    expect(soon?.tone).toBe("warning");
    expect(soon?.title).toMatch(/^Northwind's Boat key expires on /);
    expect(expiryBanner(expiring(-1), NOW, "Northwind")?.tone).toBe("error");
  });

  it("leaves expiry out of the warnings under the key, since the banner says it", () => {
    expect(keyWarnings(expiring(9), NOW)).toEqual([]);
    const blocked = boatKeyReportFixture(
      {
        start: {
          observed: true,
          canStart: false,
          blockedReason: "billing suspended",
          billingStatus: "suspended",
          runningVms: 0,
          allowedVms: 5,
        },
      },
      NOW,
    );
    expect(keyWarnings(blocked, NOW).map((warning) => warning.tone)).toEqual(["bad"]);
  });

  it("says what Boat last answered, or that nobody has checked", () => {
    expect(lastCheckLine(null, NOW)).toMatch(/^Not checked yet\./);
    const report = boatKeyReportFixture({}, new Date(NOW.getTime() - 2 * 3_600_000));
    expect(lastCheckLine(report, NOW)).toBe(
      "Boat accepted the key 2 hours ago. The account is active.",
    );
    expect(
      lastCheckLine(
        { ...report, identity: { observed: false, reason: "no-answer", boat: null } },
        NOW,
      ),
    ).toMatch(/didn't say whose key it is/);
  });

  it("tells a member only whether there is a key", () => {
    expect(memberKeyLine(true, "Northwind")).toMatch(/^Northwind has its own Boat key/);
    expect(memberKeyLine(false, "Northwind")).toMatch(/^Northwind has no Boat key/);
  });

  it("says whether the organization's sessions run on Boat now", () => {
    expect(runtimeLine("boat", "Northwind").lead).toMatch(/as it is now\.$/);
    expect(runtimeLine("docker", "Northwind").lead).toMatch(/run on Docker now/);
    expect(runtimeLine(null, "Northwind").lead).toMatch(/^Sealant picks/);
  });
});
