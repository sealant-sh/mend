// The account's secret files (docs/adr/0010): the paths written into every
// workspace a session of this account launches in. Read-only on the phone:
// adding one takes a file, which the CLI or the web app reads. The API never
// returns a file's content, so there is nothing more to show than this.

import { useQuery } from "@tanstack/react-query";

import { api } from "@/data/live";

export interface SecretFileDto {
  readonly id: string;
  /** Home-relative path in the workspace. */
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const KEY = ["secret-files"] as const;

export const useSecretFiles = (enabled: boolean) =>
  useQuery({
    queryKey: KEY,
    enabled,
    queryFn: () => api<{ readonly files: ReadonlyArray<SecretFileDto> }>("GET", "/me/secret-files"),
    staleTime: 60_000,
  });
