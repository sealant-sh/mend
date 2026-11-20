/**
 * Which of How Mend fits together's three screens is open. Kept apart from the step's words and
 * sample data (`how-mend-fits.ts`): the route reads it to check its address, and every route's
 * file loads with the app's first page, so it must pull in nothing else.
 */

/** The step's three screens: how the parts nest, inside a session, the sidebar. */
export type FitsScreen = 1 | 2 | 3;

export const FITS_SCREENS: ReadonlyArray<FitsScreen> = [1, 2, 3];

/** The screen an address asks for (`?screen=2`); the first for anything else. */
export const screenOf = (value: unknown): FitsScreen => {
  const number = typeof value === "string" ? Number(value) : value;
  return number === 2 || number === 3 ? number : 1;
};

/** "2 of 3": where a screen sits among the three. */
export const screenCount = (screen: FitsScreen): string => `${screen} of ${FITS_SCREENS.length}`;
