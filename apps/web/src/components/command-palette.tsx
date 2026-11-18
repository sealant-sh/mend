import {
  CommandPalette,
  CommandPaletteEmpty,
  CommandPaletteGroup,
  CommandPaletteItem,
  CommandPaletteMatch,
} from "@mend/ui/components/command-palette";
import { Status } from "@mend/ui/components/status";
import { Kbd } from "@mend/ui/components/ui/kbd";
import { useSidebar } from "@mend/ui/components/ui/sidebar";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, use, useMemo, useState } from "react";

import { laterPage } from "#/lib/later-pages";
import { usePhone } from "#/lib/phone";
import { repositoryWords } from "#/lib/projects";
import {
  countWords,
  type SearchAction,
  type SearchActionId,
  type SearchHit,
  searchResults,
  sessionStatus,
} from "#/lib/search";
import { useSearchShortcut } from "#/lib/search-keys";
import { sessionLink } from "#/lib/session-sheet";
import { useTRPC } from "#/lib/trpc";
import type { InboxState } from "#/lib/use-inbox";

import { PhoneSearch } from "./phone-search.tsx";
import {
  hitContext,
  hitIcon,
  hitName,
  NoResults,
  type SearchModel,
  type SearchNote,
  SearchNotes,
} from "./search-parts.tsx";

/**
 * Search from anywhere (Doop "Command palette", frames "Command palette · empty", "· results",
 * "· no results"; on a phone "Phone · search · …"). ⌘K or Ctrl K on any signed-in page, the
 * sidebar's Search field, its rail's search button, and the phone inbox's search button open it.
 * It finds sessions, projects and skills in the lists the app already holds, and the actions
 * that lead somewhere today, and opens what is picked.
 *
 * On a wide screen it is the palette over the page; under 1024px it is its own screen with the
 * keyboard up and Cancel (`phone-search.tsx`). Both show the same results.
 */

const OpenSearch = createContext<(() => void) | null>(null);

/** Opens search; for the controls that offer it. */
export const useOpenSearch = (): (() => void) => {
  const open = use(OpenSearch);
  if (open === null) throw new Error("useOpenSearch is used outside SearchProvider.");
  return open;
};

export function SearchProvider({
  organizationName,
  inbox,
  children,
}: {
  readonly organizationName: string;
  readonly inbox: InboxState;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const openSearch = useMemo(() => () => setOpen(true), []);
  useSearchShortcut(openSearch);
  const phone = usePhone();
  return (
    <OpenSearch value={openSearch}>
      {children}
      {open ? (
        <Search
          phone={phone}
          organizationName={organizationName}
          inbox={inbox}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </OpenSearch>
  );
}

/** Recent sessions with nothing typed, as many as each frame lists. */
const RECENT = { desk: 4, phone: 3 } as const;

function Search({
  phone,
  organizationName,
  inbox,
  onClose,
}: {
  readonly phone: boolean;
  readonly organizationName: string;
  readonly inbox: InboxState;
  readonly onClose: () => void;
}) {
  const model = useSearchModel(inbox, phone, onClose);
  return phone ? (
    <PhoneSearch model={model} organizationName={organizationName} onClose={onClose} />
  ) : (
    <DeskPalette model={model} organizationName={organizationName} onClose={onClose} />
  );
}

function useSearchModel(inbox: InboxState, phone: boolean, close: () => void): SearchModel {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { state: sidebar, toggleSidebar } = useSidebar();
  const [query, setQuery] = useState("");
  const projects = useQuery(trpc.projects.list.queryOptions());
  const skills = useQuery(trpc.skills.list.queryOptions());

  const actions: ReadonlyArray<SearchAction> = [
    { id: "new-session", name: "New session" },
    { id: "add-project", name: "Add project…" },
    // The sidebar is the desk's alone.
    ...(phone
      ? []
      : [
          {
            id: "toggle-sidebar" as const,
            name: sidebar === "expanded" ? "Collapse sidebar" : "Expand sidebar",
            keys: "⌘B",
          },
        ]),
  ];
  const sources = {
    sessions: inbox.status === "success" ? inbox.view.all : [],
    projects:
      projects.data?.map((project) => ({
        id: project.id,
        name: project.name,
        repository: repositoryWords(project),
      })) ?? [],
    skills: skills.data?.map((skill) => ({ id: skill.id, name: skill.name })) ?? [],
    actions,
  };
  const results = searchResults(sources, query, phone ? RECENT.phone : RECENT.desk);

  const notes: Array<SearchNote> = [];
  if (inbox.status === "pending") notes.push({ key: "sessions", text: "Reading your sessions…" });
  if (inbox.status === "error")
    notes.push({ key: "sessions", text: "Your sessions didn't load.", retry: inbox.retry });
  if (projects.isPending) notes.push({ key: "projects", text: "Reading your projects…" });
  if (projects.isError && projects.data === undefined)
    notes.push({
      key: "projects",
      text: "Your projects didn't load.",
      retry: () => void projects.refetch(),
    });
  if (skills.isPending) notes.push({ key: "skills", text: "Reading your skills…" });
  if (skills.isError && skills.data === undefined)
    notes.push({
      key: "skills",
      text: "Your skills didn't load.",
      retry: () => void skills.refetch(),
    });

  const runAction = (id: SearchActionId) => {
    switch (id) {
      case "new-session":
        // On a phone the composer is its own page; on the desk it is home.
        return navigate({ to: phone ? "/new" : "/" });
      case "add-project":
        return navigate({ to: "/projects", search: { add: true } });
      case "toggle-sidebar":
        return toggleSidebar();
    }
  };
  const choose = (hit: SearchHit) => {
    close();
    switch (hit.kind) {
      case "action":
        return void runAction(hit.action.id);
      case "session":
        return void navigate(sessionLink(hit.row.session.id));
      case "project":
        return void navigate(laterPage(`projects/${hit.project.id}`));
      case "skill":
        return void navigate({ to: "/skills/$skillId", params: { skillId: hit.skill.id } });
    }
  };
  return { query, setQuery, results, notes, choose };
}

/** The palette on the desk: 512px over the page, 128px from the top. */
function DeskPalette({
  model,
  organizationName,
  onClose,
}: {
  readonly model: SearchModel;
  readonly organizationName: string;
  readonly onClose: () => void;
}) {
  const { query, setQuery, results, notes, choose } = model;
  const empty = results.count === 0;
  return (
    <CommandPalette
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search sessions, projects and skills"
      scope={`in ${organizationName}`}
      count={results.count === null ? undefined : countWords(results.count)}
      empty={empty}
    >
      {results.groups.map((group) => (
        <CommandPaletteGroup key={group.heading} heading={group.heading}>
          {group.hits.map((hit) => (
            <CommandPaletteItem
              key={hit.key}
              value={hit.key}
              icon={hitIcon(hit)}
              context={hitContext(hit)}
              trailing={hitTrailing(hit)}
              onSelect={() => choose(hit)}
            >
              <CommandPaletteMatch text={hitName(hit)} indices={hit.indices} />
            </CommandPaletteItem>
          ))}
        </CommandPaletteGroup>
      ))}
      {empty ? (
        <CommandPaletteEmpty>
          <NoResults query={query} />
        </CommandPaletteEmpty>
      ) : null}
      <SearchNotes notes={notes} />
    </CommandPalette>
  );
}

function hitTrailing(hit: SearchHit): ReactNode {
  if (hit.kind === "session") {
    const status = sessionStatus(hit.row);
    return <Status tone={status.tone}>{status.word}</Status>;
  }
  if (hit.kind === "action" && hit.action.keys !== undefined) return <Kbd>{hit.action.keys}</Kbd>;
  return undefined;
}
