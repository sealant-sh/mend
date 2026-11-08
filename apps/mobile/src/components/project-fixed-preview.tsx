import { FixedPreviewRead } from "@/components/fixed-preview";
import { MonoText } from "@/components/typography";
import { useProjectPreview } from "@/data/preview-queries";

export function ProjectFixedPreview({ projectId }: { readonly projectId: string }) {
  const query = useProjectPreview(projectId);
  if (query.data === undefined)
    return query.isError ? (
      <MonoText tone="danger">Fixed preview could not be read · {query.error.message}</MonoText>
    ) : null;
  return <FixedPreviewRead read={query.data} />;
}
