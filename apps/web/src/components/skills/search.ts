/**
 * What a skill's URL says: which file is open, and whether it is being edited. Its own module:
 * the route parses it before anything renders, so it must not bring the skill page with it.
 */
export interface SkillSearch {
  readonly file?: string;
  readonly edit?: true;
}

export const skillSearch = (search: Record<string, unknown>): SkillSearch => {
  const file = typeof search["file"] === "string" ? search["file"] : undefined;
  const edit = search["edit"] === true || search["edit"] === "true" ? true : undefined;
  return { ...(file === undefined ? {} : { file }), ...(edit === undefined ? {} : { edit }) };
};
