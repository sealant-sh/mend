import { describe, expect, it } from "vitest";

import { parseWorkspaceList, type Listed, type WorkspaceList } from "./editor-extensions.js";
import {
  PROPAGATION_WAIT_MS,
  inFlight,
  initialObserver,
  observe,
  type Observer,
  type ObserverEvent,
  type ReadResult,
  type RestoreOutcome,
} from "./editor-observer.js";
import {
  extensionId,
  type ExtensionId,
  type PickEntry,
  type ProjectPicks,
} from "./editor-picks.js";

const id = (raw: string): ExtensionId => {
  const parsed = extensionId(raw);
  if (parsed === null) throw new Error(`not an extension id: ${raw}`);
  return parsed;
};
const gallery = (raw: string, preRelease = false): Listed => ({
  id: id(raw),
  source: "gallery",
  preRelease,
});
const fromFile = (raw: string): Listed => ({ id: id(raw), source: "file", preRelease: false });
const listOf = (...listed: ReadonlyArray<Listed>): WorkspaceList =>
  new Map(listed.map((entry) => [entry.id, entry]));

interface ReadContext {
  readonly generation?: number;
  readonly book?: ProjectPicks;
}

const readOf = (at: number, result: ReadResult, context: ReadContext = {}): ObserverEvent => ({
  kind: "read",
  generation: context.generation ?? 0,
  at,
  result,
  book: context.book ?? new Map(),
});
const read = (at: number, ...listed: ReadonlyArray<Listed>): ObserverEvent =>
  readOf(at, { kind: "list", list: listOf(...listed) });
const started = (raw: string, generation = 0): ObserverEvent => ({
  kind: "restoreStarted",
  generation,
  id: id(raw),
});
const settled = (
  raw: string,
  outcome: RestoreOutcome,
  at: number,
  generation = 0,
): ObserverEvent => ({ kind: "restoreSettled", generation, id: id(raw), outcome, at });
const removedElsewhere = (raw: string, at: number): ProjectPicks =>
  new Map<ExtensionId, PickEntry>([[id(raw), { kind: "removed", at }]]);

const play = (
  events: ReadonlyArray<ObserverEvent>,
): { readonly observer: Observer; readonly lines: ReadonlyArray<string> } => {
  let observer = initialObserver;
  const lines: Array<string> = [];
  for (const event of events) {
    const step = observe(observer, event);
    observer = step.observer;
    for (const [extension, entry] of step.entries) {
      lines.push(
        entry.kind === "picked" && entry.preRelease
          ? `picked ${extension} pre-release`
          : `${entry.kind} ${extension}`,
      );
    }
    for (const extension of step.fromFile) lines.push(`fromFile ${extension}`);
  }
  return { observer, lines };
};

const LATER = PROPAGATION_WAIT_MS;

const gitlensAt = (version: string) =>
  JSON.stringify([
    { identifier: { id: "eamodio.gitlens" }, version, metadata: { source: "gallery" } },
  ]);

describe("observe: what two reads of one window make of the panel", () => {
  it.each<[string, ReadonlyArray<ObserverEvent>, ReadonlyArray<string>]>([
    ["the first read is a baseline", [read(0, gallery("eamodio.gitlens"))], []],
    [
      "an id that appears from the gallery is a pick, with its pre-release choice",
      [read(0), read(1, gallery("eamodio.gitlens", true))],
      ["picked eamodio.gitlens pre-release"],
    ],
    [
      "an id installed from a file is named and never picked",
      [read(0), read(1, fromFile("me.local"))],
      ["fromFile me.local"],
    ],
    [
      "an id the previous read listed is removed, whoever installed it",
      [read(0, gallery("eamodio.gitlens"), fromFile("me.local")), read(1)],
      ["removed eamodio.gitlens", "removed me.local"],
    ],
    [
      "Remote-SSH and Mend are never picked or removed",
      [
        read(0),
        read(
          1,
          gallery("ms-vscode-remote.remote-ssh"),
          gallery("ms-vscode.remote-explorer"),
          gallery("ms-vscode.remote-server"),
          gallery("sealant-sh.mend"),
        ),
        read(2),
      ],
      [],
    ],
    [
      // VS Code's own remote.defaultExtensionsIfInstalledLocally lists it, but installs it only
      // when it is installed locally, which a remote window cannot see.
      "an id in VS Code's remote defaults that the person installs is a pick",
      [read(0), read(1, gallery("github.vscode-pull-request-github"))],
      ["picked github.vscode-pull-request-github"],
    ],
    [
      "a missing extensions.json at the baseline is an empty list",
      [readOf(0, { kind: "fileNotFound" }), read(1, gallery("eamodio.gitlens"))],
      ["picked eamodio.gitlens"],
    ],
    [
      "a missing extensions.json after the baseline is no observation",
      [
        read(0, gallery("eamodio.gitlens")),
        readOf(1, { kind: "fileNotFound" }),
        read(2, gallery("eamodio.gitlens")),
      ],
      [],
    ],
    [
      "a read that does not parse is no observation, never everything uninstalled",
      [
        read(0, gallery("eamodio.gitlens")),
        readOf(1, { kind: "unreadable" }),
        read(2, gallery("eamodio.gitlens")),
      ],
      [],
    ],
    [
      "a switch to pre-release is a pick with the new choice",
      [read(0, gallery("eamodio.gitlens")), read(1, gallery("eamodio.gitlens", true))],
      ["picked eamodio.gitlens pre-release"],
    ],
    [
      "a switch back to release is a pick with the new choice",
      [read(0, gallery("eamodio.gitlens", true)), read(1, gallery("eamodio.gitlens"))],
      ["picked eamodio.gitlens"],
    ],
  ])("%s", (_name, events, lines) => expect(play(events).lines).toEqual(lines));

  it("sees no change when a listed id only changes version", () => {
    const before = parseWorkspaceList(gitlensAt("1.0.0"));
    const after = parseWorkspaceList(gitlensAt("2.0.0"));
    if (before === null || after === null) throw new Error("the fixture did not parse");
    const events: ReadonlyArray<ObserverEvent> = [
      readOf(0, { kind: "list", list: before }),
      readOf(1, { kind: "list", list: after }),
    ];
    expect(play(events).lines).toEqual([]);
  });

  it("writes each entry at the time of the read that saw it, into the journal", () => {
    const { observer } = play([read(0), read(5, gallery("eamodio.gitlens", true)), read(9)]);
    expect(observer.journal).toEqual(
      new Map([[id("eamodio.gitlens"), { kind: "removed", at: 9 }]]),
    );
  });
});

describe("observe: Mend's own restores", () => {
  it.each<[string, ReadonlyArray<ObserverEvent>, ReadonlyArray<string>]>([
    [
      "a restored id that arrives is not a pick, and a later uninstall and reinstall by hand count",
      [
        read(0),
        started("eamodio.gitlens"),
        settled("eamodio.gitlens", "reported", 1),
        read(2, gallery("eamodio.gitlens")),
        read(3),
        read(4, gallery("eamodio.gitlens")),
      ],
      ["removed eamodio.gitlens", "picked eamodio.gitlens"],
    ],
    [
      "a restore that appears and is rolled back is neither a pick nor a removal",
      [
        read(0),
        started("eamodio.gitlens"),
        read(1, gallery("eamodio.gitlens")),
        read(2),
        settled("eamodio.gitlens", "failed", 3),
        read(3 + LATER),
      ],
      [],
    ],
    [
      "a failed restore still listed when it settles is not removed when the list catches up",
      [
        read(0),
        started("eamodio.gitlens"),
        read(1, gallery("eamodio.gitlens")),
        settled("eamodio.gitlens", "failed", 2),
        read(3),
        read(2 + LATER),
      ],
      [],
    ],
    [
      "a restore whose report timed out stays Mend's until VS Code's install settles",
      [
        read(0),
        started("eamodio.gitlens"),
        read(121_000),
        readOf(
          150_000,
          { kind: "list", list: listOf() },
          { book: removedElsewhere("eamodio.gitlens", 140_000) },
        ),
        settled("eamodio.gitlens", "reported", 200_000),
        readOf(
          200_500,
          { kind: "list", list: listOf(gallery("eamodio.gitlens")) },
          { book: removedElsewhere("eamodio.gitlens", 140_000) },
        ),
      ],
      [],
    ],
    [
      "an id reported installed but never listed is a pick when installed by hand after the wait",
      [
        read(0),
        started("eamodio.gitlens"),
        settled("eamodio.gitlens", "reported", 10),
        read(10 + LATER),
        read(11 + LATER, gallery("eamodio.gitlens")),
      ],
      ["picked eamodio.gitlens"],
    ],
    [
      "a restore of an id the window already lists ends when it settles",
      [
        read(0, gallery("eamodio.gitlens")),
        started("eamodio.gitlens"),
        settled("eamodio.gitlens", "reported", 1),
        read(2),
        read(3, gallery("eamodio.gitlens")),
      ],
      ["removed eamodio.gitlens", "picked eamodio.gitlens"],
    ],
    [
      "an id that arrives with a restore does not undo the project's removal of it",
      [
        read(0),
        started("eamodio.gitlens"),
        readOf(
          1,
          {
            kind: "list",
            list: listOf(
              gallery("eamodio.gitlens"),
              gallery("eamodio.gitlens-pack"),
              gallery("a.one"),
            ),
          },
          { book: removedElsewhere("eamodio.gitlens-pack", 0) },
        ),
      ],
      ["picked a.one"],
    ],
    [
      "an id this window removed does not come back with a restore",
      [
        read(0, gallery("b.two")),
        read(1),
        started("eamodio.gitlens"),
        read(2, gallery("eamodio.gitlens"), gallery("b.two")),
      ],
      ["removed b.two"],
    ],
    [
      "with no restore running, installing a removed id by hand is a pick",
      [
        readOf(
          0,
          { kind: "list", list: listOf() },
          { book: removedElsewhere("eamodio.gitlens", 0) },
        ),
        readOf(
          1,
          { kind: "list", list: listOf(gallery("eamodio.gitlens")) },
          { book: removedElsewhere("eamodio.gitlens", 0) },
        ),
      ],
      ["picked eamodio.gitlens"],
    ],
  ])("%s", (_name, events, lines) => expect(play(events).lines).toEqual(lines));

  it("names the ids whose install has not settled, a timed-out one included", () => {
    const { observer } = play([
      read(0),
      started("a.one"),
      started("b.two"),
      settled("b.two", "failed", 1),
      read(200_000),
    ]);
    expect(inFlight(observer)).toEqual(new Set(["a.one"]));
  });
});

describe("observe: the setting turned off", () => {
  it("drops the baseline, so changes made while off are not recorded", () => {
    const { lines } = play([
      read(0),
      { kind: "off" },
      readOf(1, { kind: "list", list: listOf(gallery("eamodio.gitlens")) }, { generation: 1 }),
    ]);
    expect(lines).toEqual([]);
  });

  it("starts a fresh baseline and keeps what the window saw before", () => {
    const on = (at: number, ...listed: ReadonlyArray<Listed>) =>
      readOf(at, { kind: "list", list: listOf(...listed) }, { generation: 1 });
    const { observer, lines } = play([
      read(0),
      read(1, gallery("a.one")),
      { kind: "off" },
      on(2, gallery("a.one"), gallery("b.two")),
      on(3, gallery("a.one"), gallery("b.two"), gallery("c.three")),
    ]);
    expect(lines).toEqual(["picked a.one", "picked c.three"]);
    expect([...observer.journal.keys()]).toEqual(["a.one", "c.three"]);
  });

  it("drops restores in flight, and a read or a settlement begun before it", () => {
    const { observer } = play([
      read(0),
      started("a.one"),
      { kind: "off" },
      read(1, gallery("b.two")),
      settled("a.one", "reported", 2),
    ]);
    expect(inFlight(observer)).toEqual(new Set());
    expect(observer.previous).toBeNull();
  });
});
