import { describe, expect, it } from "vitest";

import { sizeWords } from "./byte-size.ts";
import { keptRows, orphanLine, takenOverWords, takeOverNote } from "./organization-projects.ts";

const NOV_2 = new Date(2026, 10, 2, 9);
const SEP_9 = new Date(2026, 8, 9, 9);

describe("the organization's Projects page", () => {
  it("says sizes as disks are sold", () => {
    expect(sizeWords(512)).toBe("512 B");
    expect(sizeWords(48_000_000)).toBe("48 MB");
    expect(sizeWords(1_200_000_000)).toBe("1.2 GB");
    expect(sizeWords(4_500)).toBe("4.5 KB");
  });

  it("says what a project without a creator is, and what taking it over leaves", () => {
    expect(orphanLine("private", "Northwind")).toBe("Private. Only its creator could open it.");
    expect(orphanLine("shared", "Northwind")).toBe("Shared with everyone in Northwind.");
    expect(takeOverNote({ name: "billing-dashboard", visibility: "private" }, "Northwind")).toBe(
      "billing-dashboard stays private, so only you can open it until you share it with Northwind.",
    );
    expect(takeOverNote({ name: "web", visibility: "shared" }, "Northwind")).toBe(
      "web stays shared with everyone in Northwind.",
    );
    expect(takenOverWords("billing-dashboard")).toBe(
      "You're now the creator of billing-dashboard. It's in your projects.",
    );
  });

  it("lists one row per kept volume, newest removal first, and one for a project with none", () => {
    const rows = keptRows([
      {
        projectId: "p-invoice",
        projectName: "invoice-renderer",
        archivedAt: SEP_9,
        volumes: [
          {
            resourceName: "minio",
            name: "objects",
            dockerName: "mend-invoice-renderer-minio-objects",
            bytes: null,
          },
        ],
      },
      { projectId: "p-search", projectName: "search-spike", archivedAt: SEP_9, volumes: [] },
      {
        projectId: "p-fax",
        projectName: "fax-gateway",
        archivedAt: NOV_2,
        volumes: [
          {
            resourceName: "db",
            name: "pgdata",
            dockerName: "mend-fax-gateway-db-pgdata",
            bytes: 1_200_000_000,
          },
          {
            resourceName: "redis",
            name: "data",
            dockerName: "mend-fax-gateway-redis-data",
            bytes: 48_000_000,
          },
        ],
      },
    ]);
    expect(rows.map((row) => [row.project, row.volume, row.size])).toEqual([
      ["fax-gateway", "@db · pgdata", "1.2 GB"],
      ["fax-gateway", "@redis · data", "48 MB"],
      ["invoice-renderer", "@minio · objects", "Not measured"],
      ["search-spike", null, null],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});
