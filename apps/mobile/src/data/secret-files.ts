// The account's secret files (docs/adr/0010): the paths written into every
// workspace a session of this account launches in. Read-only on the phone:
// adding one takes a file, which the CLI or the web app reads. The API never
// returns a file's content, so there is nothing more to show than this.

import { useQuery } from "@tanstack/react-query";

import { usePairing } from "@/data/pairing-scope";

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

export const useSecretFiles = (enabled: boolean) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: () =>
      machine.read<{ readonly files: ReadonlyArray<SecretFileDto> }>("/me/secret-files"),
    staleTime: 60_000,
  });
};
