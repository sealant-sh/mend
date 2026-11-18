// Which of the agent's requests this tab answered, and which it showed while they waited. The
// server records who answered, not from where: a request this tab showed waiting that then reads
// answered by the viewer, without this tab having sent it, was answered on another device (Doop
// "Question · answered on your phone"). Held for the tab's life; a reload forgets it, and the
// line then says only who answered.

const answered = new Set<string>();
const shown = new Set<string>();

/** This tab sent the answer to `requestId`. */
export const markAnsweredHere = (requestId: string): void => {
  answered.add(requestId);
};

/** This tab showed `requestId` waiting for an answer. */
export const markShownWaiting = (requestId: string): void => {
  shown.add(requestId);
};

/** Whether this tab sent the answer to `requestId`. */
export const answeredHere = (requestId: string): boolean => answered.has(requestId);

/** Whether the viewer's answer to `requestId` came from another device, as far as this tab saw. */
export const answeredElsewhere = (requestId: string): boolean =>
  shown.has(requestId) && !answered.has(requestId);
