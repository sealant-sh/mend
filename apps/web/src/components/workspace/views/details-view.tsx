import { InfoIcon } from "lucide-react";

import { type ViewOpens, WorkspaceDetails } from "../details-view.tsx";
import type { ViewFacts, ViewPlace, WorkspaceView } from "../views.tsx";

/** The Details tab says nothing after its name. */
const useDetailsFacts = (_place: ViewPlace): ViewFacts => ({});

/**
 * The Details view (route PR 22): the session's workspace, checks, Services and sessions, opened as
 * a tab like any other view. `opens` says which other views are registered, so its lines open
 * their tabs (Checks, Preview, Change's Land); it comes from `views.tsx`, which this file can't
 * import without a cycle.
 */
export const detailsView = (opens: ViewOpens): WorkspaceView => ({
  id: "details",
  name: "Details",
  icon: <InfoIcon />,
  useFacts: useDetailsFacts,
  Body: function DetailsBody({ place }: { readonly place: ViewPlace }) {
    return <WorkspaceDetails place={place} opens={opens} />;
  },
});
