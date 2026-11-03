import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { focusRing } from "#/components/kit/button";
import { Panel, SettingsSection } from "#/components/kit/section";
import { StatusWord } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import { DataTable } from "#/components/kit/table";
import { skillDate, skillShape } from "#/components/skill-editor/model";
import { type ProjectDto, type SkillDto } from "#/lib/api";
import { useProjectSetting } from "#/lib/project-settings";
import { useTRPC } from "#/lib/trpc";

import { AddSkillDialog } from "./skills-add-dialog";

/** What one library skill does in this project: the project's own wins on a name. */
export const libraryStanding = (
  skill: Pick<SkillDto, "name">,
  projectNames: ReadonlySet<string>,
  inherits: boolean,
): "inherited" | "overridden here" | "off" =>
  !inherits ? "off" : projectNames.has(skill.name) ? "overridden here" : "inherited";

const nameLink = cn(
  "font-mono text-[12.5px] text-foreground no-underline hover:underline underline-offset-2 rounded-sm",
  focusRing,
);

/**
 * The project's Skills tab (screen K6): your library, which sessions here load unless global
 * skills are off, and the project's own skills, shared with everyone who can see the project.
 * A project skill with a library skill's name replaces it here. Only someone who manages the
 * project changes any of it; everyone else reads it.
 */
export function SkillsTab({
  project,
  manage,
}: {
  readonly project: ProjectDto;
  /** Whether this person may change the project: without it the tab reads, and offers nothing. */
  readonly manage: boolean;
}) {
  const trpc = useTRPC();
  const library = useQuery(trpc.skills.list.queryOptions());
  const local = useQuery(trpc.skills.forProject.queryOptions({ id: project.id }));
  const inherit = useProjectSetting(project.id, "inheritUserSkills");
  const inherits = project.inheritUserSkills;
  const projectNames = new Set((local.data ?? []).map((skill) => skill.name));

  return (
    <Panel>
      <SettingsSection
        title="Global skills"
        why="Your library, shared with every project unless you override one here."
      >
        <SwitchRow
          label="Use global skills"
          checked={inherits}
          pending={inherit.isPending}
          disabled={!manage}
          onCheckedChange={(enabled) => inherit.mutate(enabled)}
        />
        <p role="alert" className="mb-2 font-mono text-[11.5px] text-danger empty:hidden">
          {inherit.isError
            ? `Not saved: ${inherit.error.message}. Global skills are back to ${inherits ? "on" : "off"}.`
            : ""}
        </p>
        {library.isPending ? (
          <p role="status" className="py-2 font-mono text-[12px] text-faint">
            Reading your library…
          </p>
        ) : library.isError ? (
          <p role="alert" className="py-2 font-mono text-[12px] text-danger">
            Your library did not load: {library.error.message}
          </p>
        ) : (
          <DataTable
            label="Global skills here"
            columns={[
              { head: "Skill", width: "1fr" },
              { head: "Here", width: "160px", align: "end" },
            ]}
            empty={
              <>
                Your library is empty. Skills you add in{" "}
                <Link to="/skills" className={nameLink}>
                  Skills
                </Link>{" "}
                show here.
              </>
            }
            rows={library.data.map((skill) => {
              const standing = libraryStanding(skill, projectNames, inherits);
              return {
                key: skill.id,
                cells: [
                  <Link
                    key="name"
                    to="/skills/$skillId"
                    params={{ skillId: skill.id }}
                    className={nameLink}
                  >
                    {skill.name}
                  </Link>,
                  <StatusWord key="here" tone={standing === "inherited" ? "ok" : "off"}>
                    {standing}
                  </StatusWord>,
                ],
              };
            })}
          />
        )}
      </SettingsSection>
      <SettingsSection
        title="Project skills"
        why={`Shared with everyone who can see ${project.name}.`}
      >
        {local.isPending ? (
          <p role="status" className="py-2 font-mono text-[12px] text-faint">
            Reading project skills…
          </p>
        ) : local.isError ? (
          <p role="alert" className="py-2 font-mono text-[12px] text-danger">
            Project skills did not load: {local.error.message}
          </p>
        ) : (
          <DataTable
            label={`Skills in ${project.name}`}
            columns={[
              { head: "Skill", width: "1fr" },
              { head: "Files", width: "160px", align: "end" },
              { head: "Updated", width: "112px", align: "end" },
            ]}
            empty="No project skills yet. Add one, or push a folder with mend skills push --project."
            rows={local.data.map((skill) => ({
              key: skill.id,
              cells: [
                <Link
                  key="name"
                  to="/projects/$projectId/skills/$skillId"
                  params={{ projectId: project.id, skillId: skill.id }}
                  className={nameLink}
                >
                  {skill.name}
                </Link>,
                <span key="files" className="font-mono text-[12px] text-muted-foreground">
                  {skillShape(skill)}
                </span>,
                <span key="updated" className="font-mono text-[12px] text-muted-foreground">
                  {skillDate(skill.updatedAt)}
                </span>,
              ],
            }))}
          />
        )}
        {manage ? (
          <div className="mt-2.5">
            <AddSkillDialog project={project} projectSkills={local.data ?? []} />
          </div>
        ) : (
          <p className="mt-2.5 text-[12.5px] text-muted-foreground">
            The project&apos;s creator or an organization owner adds and changes project skills. You
            can read them.
          </p>
        )}
      </SettingsSection>
    </Panel>
  );
}
