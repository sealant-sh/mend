import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { focusRing } from "#/components/kit/button";
import { Page, PageHeader } from "#/components/kit/page";
import { Panel } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { DataTable } from "#/components/kit/table";
import { AppShell } from "#/components/shell";
import type { SkillDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";
import { skillLibraryView, type SkillLibraryView } from "#/lib/ui-prefs";

import { bundleShape } from "./model";
import { NewSkillDialog } from "./new-skill-dialog";

const VIEWS = [
  { value: "cards", label: "Cards" },
  { value: "list", label: "List" },
] as const satisfies ReadonlyArray<{ readonly value: SkillLibraryView; readonly label: string }>;

/**
 * Skills (M1, M1b): the person's own library, which every project inherits unless it turns
 * inheritance off or overrides a skill by name. Cards or a list, kept per browser.
 */
export function SkillLibraryPage() {
  const trpc = useTRPC();
  const skills = useSuspenseQuery(trpc.skills.list.queryOptions()).data;
  const view = skillLibraryView.use();
  return (
    <AppShell layout="bare">
      <Page>
        <PageHeader
          eyebrow="skills"
          title="Your skill library"
          description="Skills every session can load. A project can override or turn one off."
          actions={
            <>
              <Segment
                label="Show skills as"
                value={view}
                onChange={skillLibraryView.set}
                options={VIEWS}
              />
              <NewSkillDialog />
            </>
          }
        />
        {skills.length === 0 ? (
          <Panel className="px-[26px] py-6">
            <p className="text-[13.5px] text-ink-2">No skills in your library yet.</p>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Create one with New skill, or push the library on your computer with{" "}
              <code className="font-mono text-[12px]">mend skills push</code>.
            </p>
          </Panel>
        ) : view === "cards" ? (
          <ul aria-label="Your skills" className="grid grid-cols-3 gap-3">
            {skills.map((skill) => (
              <li key={skill.id} className="min-w-0">
                <SkillCard skill={skill} />
              </li>
            ))}
          </ul>
        ) : (
          <Panel className="px-1 py-1.5">
            <DataTable
              label="Your skills"
              columns={[
                { head: "Skill", width: "0.8fr" },
                { head: "What it does", width: "2.4fr" },
                { head: "Files", width: "0.9fr" },
                { head: "Updated", width: "0.7fr", align: "end" },
              ]}
              rows={skills.map((skill) => ({
                key: skill.id,
                cells: [
                  <SkillLink key="name" skill={skill} className="font-mono text-[12px]" />,
                  <span key="what" className="text-[13px] text-ink-2">
                    {skill.description}
                  </span>,
                  <span key="shape" className="font-mono text-[12px] text-muted-foreground">
                    {bundleShape(skill)}
                  </span>,
                  <span key="updated" className="font-mono text-[12px] text-muted-foreground">
                    {formatDay(skill.updatedAt)}
                  </span>,
                ],
              }))}
            />
          </Panel>
        )}
      </Page>
    </AppShell>
  );
}

const formatDay = (at: Date) => at.toLocaleDateString([], { month: "short", day: "numeric" });

function SkillLink({
  skill,
  className,
}: {
  readonly skill: SkillDto;
  readonly className?: string;
}) {
  return (
    <Link
      to="/skills/$skillId"
      params={{ skillId: skill.id }}
      className={`rounded-md text-foreground no-underline hover:underline ${focusRing} ${className ?? ""}`}
    >
      {skill.name}
    </Link>
  );
}

/** A card is one link to the skill, so Tab reaches each card once and Enter opens it. */
function SkillCard({ skill }: { readonly skill: SkillDto }) {
  return (
    <Link
      to="/skills/$skillId"
      params={{ skillId: skill.id }}
      className={`block h-full rounded-[22px] bg-panel px-[18px] py-4 text-foreground no-underline shadow-sm transition-shadow hover:shadow-md ${focusRing}`}
    >
      <span className="block font-sans text-[15px] font-semibold">{skill.name}</span>
      <span className="mt-1 mb-2 block font-mono text-[11.5px] text-muted-foreground">
        {bundleShape(skill)}
      </span>
      {skill.description === "" ? null : (
        <span className="line-clamp-3 block text-[13px] text-ink-2">{skill.description}</span>
      )}
    </Link>
  );
}
