import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import { useAdoptionAttempt } from "./adoptions.ts";
import { type FitsNames, pictureProject } from "./how-mend-fits.ts";
import { useServerHost } from "./online.ts";
import { signedInOptions } from "./sign-in.ts";
import { useTRPC } from "./trpc.ts";
import { useViewer } from "./use-viewer.ts";

/**
 * What the screens name, for the signed-in person: their organization and whether they own it,
 * their name, this server, and the project the pictures show (the clone this browser started, the
 * newest project they can see, or the sample).
 */
export const useFitsNames = (): FitsNames => {
  const trpc = useTRPC();
  const signedIn = useSuspenseQuery(signedInOptions(trpc)).data;
  const { organizationName, account } = useViewer();
  const host = useServerHost();
  const cloning = useAdoptionAttempt(signedIn.userId);
  const projects = useQuery(trpc.projects.list.queryOptions());
  // Until the list answers, or if it can't, the pictures use the clone or the sample.
  const project = pictureProject(
    cloning?.name ?? null,
    projects.isPending || projects.isError ? [] : projects.data,
  );
  return {
    host,
    organization: organizationName,
    owner: signedIn.role === "owner",
    person: account.name,
    email: account.email,
    project: project.name,
    ownProject: project.own,
  };
};
