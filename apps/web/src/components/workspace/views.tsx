import {
  AppWindowIcon,
  FileDiffIcon,
  InfoIcon,
  ListChecksIcon,
  MonitorIcon,
  ScrollTextIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { lazyBody } from "./lazy-body.tsx";
import {
  useChangeFacts,
  useChecksFacts,
  useNoFacts,
  usePreviewFacts,
  useScreenFacts,
  useTerminalFacts,
} from "./view-facts.ts";
import type { WorkspaceViewId } from "./view-ids.ts";

/** Where a view opens: the workspace of the session whose page this is. */
export interface ViewPlace {
  readonly sessionId: string;
  readonly worktreeId: string;
  readonly projectId: string;
}

/** What a view's tab and its "+" item say after its name. */
export interface ViewFacts {
  /** Change: lines added and removed. */
  readonly added?: number;
  readonly removed?: number;
  /** Anything else, muted mono: Preview's ":3000", Checks' "2 passed", Terminal's "1 shell". */
  readonly fact?: string;
}

/**
 * A workspace view a tab can hold (ADR 0026): Change, Checks, Preview, Terminal, Screen, Record,
 * Details. Each view adds its id to `WORKSPACE_VIEW_IDS` (`view-ids.ts`) and its entry to
 * `WORKSPACE_VIEWS`; the "+" menu lists only what is there, in that order.
 *
 * An entry holds what a tab shows before its body is fetched (its name, icon and facts) and its
 * body behind `lazyBody`: a view's code (the terminal's wasm, the diff viewer's grammars) is
 * fetched when its tab first shows, never with every page.
 */
export interface WorkspaceView {
  /** The view's key, in its tab's key (`view:<id>`) and its path (`/sessions/<id>/<id>`). */
  readonly id: WorkspaceViewId;
  /** Its name in the tab and the menu: "Terminal". */
  readonly name: string;
  /** Its Lucide icon, sized by the tab and the menu. */
  readonly icon: ReactNode;
  /** A hook: the facts its tab and menu item show now. Called once per tab or item. */
  readonly useFacts: (place: ViewPlace) => ViewFacts;
  /**
   * What the tab's body shows. It stays mounted while the tab moves or another tab shows. It
   * suspends while its code is fetched, the first time it shows on a page.
   */
  readonly Body: ComponentType<{ readonly place: ViewPlace }>;
  /** Starts fetching the body's code: as a pointer or focus rests on its tab or "+" item. */
  readonly preload: () => void;
}

const change = lazyBody("Change", () =>
  import("#/components/change/change-view").then((module) => module.ChangeBody),
);
const checks = lazyBody("Checks", () =>
  import("./views/checks-view.tsx").then((module) => module.ChecksBody),
);
const preview = lazyBody("Preview", () =>
  import("./views/preview-view.tsx").then((module) => module.PreviewBody),
);
const terminal = lazyBody("Terminal", () =>
  import("./views/terminal-view.tsx").then((module) => module.TerminalBody),
);
const screen = lazyBody("Screen", () =>
  import("./views/screen-view.tsx").then((module) => module.ScreenBody),
);
const record = lazyBody("Record", () =>
  import("./views/record-view.tsx").then((module) => module.RecordBody),
);
const details = lazyBody("Details", () =>
  import("./details-view.tsx").then((module) => module.WorkspaceDetails),
);

/**
 * The Details view (route PR 22): the session's workspace, checks, Services and sessions. Its
 * lines open the other registered views' tabs (Checks, Preview, Change's Land), so it is told
 * which are registered; its code can't import this file without a cycle.
 */
function DetailsBody({ place }: { readonly place: ViewPlace }) {
  return <details.Body place={place} opens={isRegistered} />;
}

const isRegistered = (id: string): boolean => workspaceView(id) !== undefined;

/** The views built so far, in the "+" menu's order: Change, Checks, Preview, Terminal, … */
export const WORKSPACE_VIEWS: ReadonlyArray<WorkspaceView> = [
  { id: "change", name: "Change", icon: <FileDiffIcon />, useFacts: useChangeFacts, ...change },
  { id: "checks", name: "Checks", icon: <ListChecksIcon />, useFacts: useChecksFacts, ...checks },
  {
    id: "preview",
    name: "Preview",
    icon: <AppWindowIcon />,
    useFacts: usePreviewFacts,
    ...preview,
  },
  {
    id: "terminal",
    name: "Terminal",
    icon: <SquareTerminalIcon />,
    useFacts: useTerminalFacts,
    ...terminal,
  },
  { id: "screen", name: "Screen", icon: <MonitorIcon />, useFacts: useScreenFacts, ...screen },
  { id: "record", name: "Record", icon: <ScrollTextIcon />, useFacts: useNoFacts, ...record },
  {
    id: "details",
    name: "Details",
    icon: <InfoIcon />,
    useFacts: useNoFacts,
    Body: DetailsBody,
    preload: details.preload,
  },
];

export const workspaceView = (id: string): WorkspaceView | undefined =>
  WORKSPACE_VIEWS.find((view) => view.id === id);
