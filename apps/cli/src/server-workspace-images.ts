/**
 * How many workspace images the bundled sealant worker keeps, and for how long. The worker removes
 * workspace images no workspace runs from once an hour. It keeps the newest image of each of the
 * most recently built image definitions (sealant's `WORKSPACE_IMAGE_RETAINED_PLANS`, 10 by
 * default) and every image built within a window (`WORKSPACE_IMAGE_MIN_AGE_HOURS`, a week by
 * default). On a small server those defaults keep every image it ever built.
 *
 * The operator's values live in the server config (`--workspace-image-keep`,
 * `--workspace-image-min-age`), and `compose.workspace-images.yaml` hands them to the `mend`
 * container, whose environment the bundled worker inherits. The values are written into the
 * overlay itself, not `server.env`: a CLI from before this setting refuses a `server.env` line it
 * does not know, and ignores a file it does not know, so an older CLI can still read and upgrade
 * the install (and drops the setting, which returns the worker to sealant's defaults). Unset, no
 * overlay is written and the generation is what it was before the setting existed.
 *
 * Never an empty value: sealant reads both with `z.coerce.number()`, which reads `""` as 0.
 */

export const WORKSPACE_IMAGES_COMPOSE_FILE = "compose.workspace-images.yaml";

/** sealant's own defaults, which apply to whichever value the install does not set. */
export const SEALANT_WORKSPACE_IMAGE_KEEP = 10;
export const SEALANT_WORKSPACE_IMAGE_MIN_AGE_HOURS = 168;

const MAX_KEEP = 1000;
/** Ten years: anything longer is a typo, not a policy. */
const MAX_MIN_AGE_HOURS = 87_600;

/** The values an install sets; a value it does not set is sealant's default. */
export interface ServerWorkspaceImages {
  /** `WORKSPACE_IMAGE_RETAINED_PLANS`: how many image definitions' newest images are kept. */
  readonly keep?: number;
  /** `WORKSPACE_IMAGE_MIN_AGE_HOURS`: images built within this many hours are never removed. */
  readonly minAgeHours?: number;
}

/** A flag's value: a count or hours, or `default` to go back to sealant's own. */
export type WorkspaceImageValue = number | "default";

const wholeNumber = (value: string, max: number): number | null => {
  if (!/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= max ? parsed : null;
};

export const parseWorkspaceImageKeep = (value: string): WorkspaceImageValue | null =>
  value === "default" ? "default" : wholeNumber(value, MAX_KEEP);

export const parseWorkspaceImageMinAge = (value: string): WorkspaceImageValue | null =>
  value === "default" ? "default" : wholeNumber(value, MAX_MIN_AGE_HOURS);

export const WORKSPACE_IMAGE_KEEP_RULE = `a whole number from 0 to ${MAX_KEEP}, or default`;
export const WORKSPACE_IMAGE_MIN_AGE_RULE = `a whole number of hours from 0 to ${MAX_MIN_AGE_HOURS}, or default`;

/** A flag's value over the saved one: `default` takes it away, silence keeps it. */
const pick = (flag: WorkspaceImageValue | undefined, kept: number | undefined) =>
  flag === "default" ? undefined : (flag ?? kept);

/**
 * What a setup writes: each flag given, else what the install saved. `default` takes a saved value
 * away. Undefined when neither value is set, so the config carries no field at all.
 */
export const resolveWorkspaceImages = (
  saved: ServerWorkspaceImages | undefined,
  options: {
    readonly workspaceImageKeep: WorkspaceImageValue | undefined;
    readonly workspaceImageMinAge: WorkspaceImageValue | undefined;
  },
): ServerWorkspaceImages | undefined => {
  const keep = pick(options.workspaceImageKeep, saved?.keep);
  const minAgeHours = pick(options.workspaceImageMinAge, saved?.minAgeHours);
  if (keep === undefined && minAgeHours === undefined) return undefined;
  return {
    ...(keep === undefined ? {} : { keep }),
    ...(minAgeHours === undefined ? {} : { minAgeHours }),
  };
};

/** The saved field, or null when it is not what a setup writes. */
export const parseWorkspaceImagesField = (raw: unknown): ServerWorkspaceImages | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const fields = new Map(Object.entries(raw));
  if ([...fields.keys()].some((key) => key !== "keep" && key !== "minAgeHours")) return null;
  const read = (key: string, max: number): number | undefined | null => {
    const value = fields.get(key);
    if (value === undefined) return undefined;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
      ? value
      : null;
  };
  const keep = read("keep", MAX_KEEP);
  const minAgeHours = read("minAgeHours", MAX_MIN_AGE_HOURS);
  if (keep === null || minAgeHours === null || (keep === undefined && minAgeHours === undefined))
    return null;
  return {
    ...(keep === undefined ? {} : { keep }),
    ...(minAgeHours === undefined ? {} : { minAgeHours }),
  };
};

/** `compose.workspace-images.yaml`, or undefined when the install sets neither value. */
export const renderWorkspaceImagesOverlay = (
  images: ServerWorkspaceImages | undefined,
): string | undefined => {
  if (images === undefined) return undefined;
  return [
    "# Written by mend server setup from server.json: how many workspace images the bundled",
    "# sealant worker keeps (--workspace-image-keep) and for how long (--workspace-image-min-age).",
    "# A value not named here is sealant's default.",
    "services:",
    "  mend:",
    "    environment:",
    ...(images.keep === undefined
      ? []
      : [`      WORKSPACE_IMAGE_RETAINED_PLANS: "${images.keep}"`]),
    ...(images.minAgeHours === undefined
      ? []
      : [`      WORKSPACE_IMAGE_MIN_AGE_HOURS: "${images.minAgeHours}"`]),
    "",
  ].join("\n");
};

const hours = (value: number): string => (value === 1 ? "1 hour" : `${value} hours`);

/** The one line `mend server status` says, among the settings the install declares. */
export const workspaceImagesLine = (images: ServerWorkspaceImages | undefined): string => {
  const keep = images?.keep ?? SEALANT_WORKSPACE_IMAGE_KEEP;
  const minAge = images?.minAgeHours ?? SEALANT_WORKSPACE_IMAGE_MIN_AGE_HOURS;
  const source =
    images === undefined
      ? "sealant's defaults, not set on this install"
      : images.keep === undefined
        ? "the count is sealant's default"
        : images.minAgeHours === undefined
          ? "the age is sealant's default"
          : "set on this install";
  return `workspace images · the worker keeps the newest ${keep} with no workspace on them, and any built in the last ${hours(minAge)} · ${source}`;
};

/** What setup says when this run changes either value; nothing when it does not. */
export const workspaceImagesChangedLines = (
  before: ServerWorkspaceImages | undefined,
  after: ServerWorkspaceImages | undefined,
): ReadonlyArray<string> =>
  before?.keep === after?.keep && before?.minAgeHours === after?.minAgeHours
    ? []
    : [
        `${workspaceImagesLine(after)}. The worker sweeps half a minute after Mend starts, then hourly.`,
      ];
