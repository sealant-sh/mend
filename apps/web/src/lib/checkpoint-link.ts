/**
 * The checkpoint a link names: `#checkpoint-6` is 6; anything else is null. A landed pull
 * request's link to a checkpoint is read by the session route's `beforeLoad`. A route's `validateSearch` and `beforeLoad` ride in the route tree's chunk on every page, so this module stays apart from
 * the Record view's rows (`record-rows.ts`).
 */
export const checkpointOfHash = (hash: string): number | null => {
  const match = /^#?checkpoint-(\d+)$/.exec(hash);
  return match === null ? null : Number(match[1]);
};
