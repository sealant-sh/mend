import { describe, expect, it } from "vitest";

import {
  emptyBook,
  extensionId,
  holds,
  parsePickBook,
  projectId,
  storedBook,
  wantedBy,
  withEntries,
  type ExtensionId,
  type PickBook,
  type PickEntry,
  type ProjectId,
  type ProjectPicks,
} from "./editor-picks.js";

const id = (raw: string): ExtensionId => {
  const parsed = extensionId(raw);
  if (parsed === null) throw new Error(`not an extension id: ${raw}`);
  return parsed;
};

const project = (raw: string): ProjectId => {
  const parsed = projectId(raw);
  if (parsed === null) throw new Error(`not a project id: ${raw}`);
  return parsed;
};

const picked = (at: number, preRelease = false): PickEntry => ({ kind: "picked", at, preRelease });
const removed = (at: number): PickEntry => ({ kind: "removed", at });
const entries = (...pairs: ReadonlyArray<[string, PickEntry]>): ProjectPicks =>
  new Map(pairs.map(([raw, entry]) => [id(raw), entry]));

const P = project("project-1");
const Q = project("project-2");

/** A book as plain JSON with sorted keys, so two books compare by content. */
const canonical = (book: PickBook): string =>
  JSON.stringify(storedBook(book), (_key, value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)))
      : value,
  );

const apply = (book: PickBook, ...journals: ReadonlyArray<[ProjectId, ProjectPicks]>) =>
  journals.reduce((acc, [p, picks]) => withEntries(acc, p, picks), book);

describe("extensionId and projectId", () => {
  it("lowercases a publisher.name id and refuses anything else", () => {
    expect(extensionId("EamodIO.GitLens")).toBe("eamodio.gitlens");
    for (const raw of ["", "gitlens", "a.b.c", ".gitlens", "eamodio.", "a b.c", "../x.y"]) {
      expect(extensionId(raw)).toBeNull();
    }
    expect(projectId("")).toBeNull();
    expect(projectId("project-1")).toBe("project-1");
  });
});

describe("parsePickBook", () => {
  it("reads nothing stored as the empty book", () => {
    expect(parsePickBook(undefined)).toEqual(emptyBook);
  });

  it("calls a newer version, a malformed entry or a bad id unreadable", () => {
    for (const stored of [
      null,
      "picks",
      { version: 2, projects: {} },
      { version: 1 },
      { version: 1, projects: { "project-1": { "eamodio.gitlens": { kind: "picked", at: 1 } } } },
      { version: 1, projects: { "project-1": { "eamodio.gitlens": { kind: "gone", at: 1 } } } },
      { version: 1, projects: { "project-1": { gitlens: { kind: "removed", at: 1 } } } },
      { version: 1, projects: { "": {} } },
      { version: 1, projects: { "project-1": [] } },
    ]) {
      expect(parsePickBook(stored)).toBe("unreadable");
    }
  });

  it("round-trips what it stores, through JSON as global state keeps it", () => {
    const book = withEntries(
      withEntries(
        emptyBook,
        P,
        entries(["eamodio.gitlens", picked(5, true)], ["ms-python.python", removed(7)]),
      ),
      Q,
      entries(["editorconfig.editorconfig", picked(3)]),
    );
    const read = parsePickBook(JSON.parse(JSON.stringify(storedBook(book))));
    expect(read).not.toBe("unreadable");
    if (read === "unreadable") return;
    expect(canonical(read)).toBe(canonical(book));
    expect(wantedBy(read, P)).toEqual([{ id: "eamodio.gitlens", preRelease: true }]);
  });
});

describe("withEntries", () => {
  it("keeps the later entry per id, each project on its own", () => {
    const book = withEntries(
      withEntries(emptyBook, P, entries(["eamodio.gitlens", picked(1)])),
      P,
      entries(["eamodio.gitlens", removed(2)]),
    );
    const other = withEntries(book, Q, entries(["eamodio.gitlens", picked(1)]));
    expect(wantedBy(other, P)).toEqual([]);
    expect(wantedBy(other, Q)).toEqual([{ id: "eamodio.gitlens", preRelease: false }]);
  });

  it("lets a pick win a tie with a removal", () => {
    const orders: ReadonlyArray<[PickEntry, PickEntry]> = [
      [picked(4), removed(4)],
      [removed(4), picked(4)],
    ];
    for (const [first, second] of orders) {
      const book = withEntries(
        withEntries(emptyBook, P, entries(["eamodio.gitlens", first])),
        P,
        entries(["eamodio.gitlens", second]),
      );
      expect(wantedBy(book, P)).toEqual([{ id: "eamodio.gitlens", preRelease: false }]);
    }
  });

  it("lets a newer removal beat an old pick replayed after it", () => {
    const book = withEntries(emptyBook, P, entries(["eamodio.gitlens", removed(9)]));
    const replayed = withEntries(book, P, entries(["eamodio.gitlens", picked(3)]));
    expect(wantedBy(replayed, P)).toEqual([]);
    expect(holds(replayed, P, entries(["eamodio.gitlens", picked(3)]))).toBe(true);
  });

  it("gives the same book whichever window's journal lands first", () => {
    const windowA = entries(["eamodio.gitlens", picked(10)], ["ms-python.python", removed(12)]);
    const windowB = entries(["eamodio.gitlens", removed(11)], ["ms-python.python", picked(8)]);
    const start = withEntries(emptyBook, P, entries(["ms-python.python", picked(1)]));
    const aThenB = withEntries(withEntries(start, P, windowA), P, windowB);
    const bThenA = withEntries(withEntries(start, P, windowB), P, windowA);
    expect(canonical(aThenB)).toBe(canonical(bThenA));
    expect(wantedBy(aThenB, P)).toEqual([]);
  });

  it("is commutative, associative and idempotent over random journals", () => {
    let seed = 20261026;
    const random = (below: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % below;
    };
    const ids = ["a.one", "b.two", "c.three", "d.four"];
    const projects = [P, Q];
    const journal = (): [ProjectId, ProjectPicks] => [
      projects[random(projects.length)] ?? P,
      new Map(
        Array.from({ length: random(4) }, (): [ExtensionId, PickEntry] => [
          id(ids[random(ids.length)] ?? "a.one"),
          random(2) === 0 ? removed(random(5)) : picked(random(5), random(2) === 0),
        ]),
      ),
    ];
    for (let round = 0; round < 500; round += 1) {
      const base = apply(emptyBook, journal(), journal());
      const [x, y, z] = [journal(), journal(), journal()];
      expect(canonical(apply(base, x, y))).toBe(canonical(apply(base, y, x)));
      expect(canonical(apply(base, x, y, z))).toBe(canonical(apply(base, z, y, x)));
      expect(canonical(apply(base, x, x))).toBe(canonical(apply(base, x)));
      const [p, picks] = x;
      expect(holds(base, p, picks)).toBe(canonical(apply(base, x)) === canonical(base));
    }
  });
});

describe("holds", () => {
  it("is true exactly when merging changes nothing", () => {
    const book = withEntries(emptyBook, P, entries(["eamodio.gitlens", picked(5)]));
    expect(holds(book, P, new Map())).toBe(true);
    expect(holds(book, P, entries(["eamodio.gitlens", picked(5)]))).toBe(true);
    expect(holds(book, P, entries(["eamodio.gitlens", removed(4)]))).toBe(true);
    expect(holds(book, P, entries(["eamodio.gitlens", removed(6)]))).toBe(false);
    expect(holds(book, P, entries(["eamodio.gitlens", picked(5, true)]))).toBe(false);
    expect(holds(book, Q, entries(["eamodio.gitlens", picked(5)]))).toBe(false);
    expect(holds(emptyBook, P, entries(["eamodio.gitlens", removed(1)]))).toBe(false);
  });
});

describe("wantedBy", () => {
  it("lists only that project's picks, sorted, with their pre-release choice", () => {
    const book = withEntries(
      withEntries(
        emptyBook,
        P,
        entries(
          ["ms-python.python", picked(1)],
          ["eamodio.gitlens", picked(1, true)],
          ["esbenp.prettier-vscode", removed(2)],
        ),
      ),
      Q,
      entries(["golang.go", picked(1)]),
    );
    expect(wantedBy(book, P)).toEqual([
      { id: "eamodio.gitlens", preRelease: true },
      { id: "ms-python.python", preRelease: false },
    ]);
    expect(wantedBy(book, project("project-3"))).toEqual([]);
  });
});
