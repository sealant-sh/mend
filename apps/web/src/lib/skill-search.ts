/**
 * What a skill's URL says: which file is open, and whether it is being edited (`?edit=1`). The
 * route parses it before anything renders. A route's `validateSearch` and `beforeLoad` ride in the route tree's chunk on every page, so this module stays apart from
 * the Skills pages' rules (`skills.ts`) and imports nothing.
 */
export interface SkillSearch {
  readonly file?: string;
  readonly edit?: 1;
}

export const skillSearch = (search: Record<string, unknown>): SkillSearch => {
  const file = typeof search["file"] === "string" ? search["file"] : undefined;
  const raw = search["edit"];
  const edit = raw === 1 || raw === "1" || raw === true || raw === "true" ? 1 : undefined;
  return { ...(file === undefined ? {} : { file }), ...(edit === undefined ? {} : { edit }) };
};
