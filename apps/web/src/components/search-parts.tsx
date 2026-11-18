import { Button } from "@mend/ui/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import {
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  SearchXIcon,
  SparklesIcon,
  SquarePenIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { SearchActionId, SearchHit, SearchResults } from "#/lib/search";

/** What the palette and the phone's search screen share: the model, and how a result reads. */

/** What both screens draw from: the results, what is still loading or failed, and opening one. */
export interface SearchModel {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly results: SearchResults;
  /** A list that is still being read, or failed to read, said under the results. */
  readonly notes: ReadonlyArray<SearchNote>;
  readonly choose: (hit: SearchHit) => void;
}

export interface SearchNote {
  readonly key: string;
  readonly text: string;
  /** Present when the read failed: reads it again. */
  readonly retry?: () => void;
}

/** Nothing matched (frame "Command palette · no results"). */
export function NoResults({
  query,
  className,
}: {
  readonly query: string;
  readonly className?: string;
}) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia>
          <SearchXIcon aria-hidden className="size-6 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>No results for “{query.trim()}”</EmptyTitle>
        <EmptyDescription>Search looks at sessions, projects, skills and actions.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** A list still being read, or one that failed with Try again, under the results. */
export function SearchNotes({
  notes,
  touch = false,
}: {
  readonly notes: ReadonlyArray<SearchNote>;
  readonly touch?: boolean;
}) {
  if (notes.length === 0) return null;
  return (
    <div role="status" className="flex flex-col gap-1 px-2 py-2 text-meta text-muted-foreground">
      {notes.map((note) => (
        <p key={note.key} className="flex items-center gap-2">
          <span>{note.text}</span>
          {note.retry === undefined ? null : (
            <Button
              type="button"
              variant="link"
              size={touch ? "touch" : "sm"}
              className="h-auto p-0"
              onClick={note.retry}
            >
              Try again
            </Button>
          )}
        </p>
      ))}
    </div>
  );
}

export const hitName = (hit: SearchHit): string => {
  switch (hit.kind) {
    case "action":
      return hit.action.name;
    case "session":
      return hit.row.title;
    case "project":
      return hit.project.name;
    case "skill":
      return hit.skill.name;
  }
};

export const hitIcon = (hit: SearchHit): ReactNode => {
  switch (hit.kind) {
    case "action":
      return ACTION_ICONS[hit.action.id];
    case "session":
      return <MessageSquareIcon />;
    case "project":
      return <FolderIcon />;
    case "skill":
      return <SparklesIcon />;
  }
};

const ACTION_ICONS: Readonly<Record<SearchActionId, ReactNode>> = {
  "new-session": <SquarePenIcon />,
  "add-project": <FolderPlusIcon />,
  "toggle-sidebar": <PanelLeftIcon />,
};

/** The muted words beside a result: a session's project, a project's repository. */
export const hitContext = (hit: SearchHit): string | undefined => {
  switch (hit.kind) {
    case "session":
      return hit.row.project.name;
    case "project":
      return hit.project.repository;
    case "action":
    case "skill":
      return undefined;
  }
};
