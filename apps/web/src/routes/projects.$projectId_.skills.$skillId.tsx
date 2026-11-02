import { cn } from "@mend/ui/lib/utils";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { focusRing } from "#/components/kit/button";
import { Page } from "#/components/kit/page";
import { AppShell } from "#/components/shell";
import { skillShape } from "#/components/skill-editor/model";
import { SkillEditor } from "#/components/skill-editor/skill-editor";
import { dropRemovedSkill, settleRemovedSkill } from "#/lib/skill-removal";
import { useTRPC } from "#/lib/trpc";

/**
 * A project skill, read and edited (screen K8). Outside the tab layout, like the library's skill
 * page: the crumb leads back to the project's Skills tab. `?edit=1` is the editing state, so Edit
 * and Back move through the browser's history and a link can open the editor.
 */
export const Route = createFileRoute("/projects/$projectId_/skills/$skillId")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { readonly edit?: true } =>
    search["edit"] === true || search["edit"] === 1 || search["edit"] === "1" ? { edit: true } : {},
  loader: async ({ context: { queryClient, trpc }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(trpc.skills.detail.queryOptions({ skillId: params.skillId })),
      queryClient.ensureQueryData(trpc.projects.detail.queryOptions({ id: params.projectId })),
    ]);
  },
  component: ProjectSkillPage,
});

const crumbLink = cn("text-muted-foreground no-underline hover:text-foreground", focusRing);

function ProjectSkillPage() {
  const { projectId, skillId } = Route.useParams();
  const { edit } = Route.useSearch();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });
  const detail = useSuspenseQuery(trpc.skills.detail.queryOptions({ skillId })).data;
  const project = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data
    .project;
  const { skill } = detail;

  return (
    <AppShell layout="bare" projectId={projectId}>
      <Page className="pt-8">
        <SkillEditor
          key={`${skill.id}:${skill.revision}`}
          detail={detail}
          crumb={
            <nav aria-label="Breadcrumb" className="mb-1.5 font-sans text-[13px] font-medium">
              <ol className="flex items-center gap-1.5">
                <li>
                  <Link to="/projects/$projectId" params={{ projectId }} className={crumbLink}>
                    {project.name}
                  </Link>
                </li>
                <li aria-hidden="true" className="text-muted-foreground">
                  /
                </li>
                <li>
                  <Link
                    to="/projects/$projectId/skills"
                    params={{ projectId }}
                    className={crumbLink}
                  >
                    Skills
                  </Link>
                </li>
                <li aria-hidden="true" className="text-muted-foreground">
                  /
                </li>
                <li aria-current="page" className="text-foreground">
                  {skill.name}
                </li>
              </ol>
            </nav>
          }
          scopeLine={`project skill · ${project.name} · revision ${skill.revision} · ${skillShape(skill)}`}
          editing={edit === true}
          onEditingChange={(editing) =>
            navigate({ search: editing ? { edit: true } : {}, replace: false })
          }
          afterDelete={async () => {
            await dropRemovedSkill(queryClient, trpc, skill);
            await navigate({ to: "/projects/$projectId/skills", params: { projectId } });
            void settleRemovedSkill(queryClient, trpc, skill);
          }}
        />
      </Page>
    </AppShell>
  );
}
