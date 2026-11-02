import type { Machine } from "@/data/machine";

export function proofMediaSource(
  connection: Machine["connection"],
  mediaPath: string,
): {
  readonly uri: string;
  readonly headers: { readonly authorization: string };
} {
  return {
    uri: `${connection.url}${mediaPath}`,
    headers: { authorization: `Bearer ${connection.token}` },
  };
}
