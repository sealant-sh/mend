import type { AgentItemDto } from "./feed.ts";

export interface MendPageCallFailureView {
  readonly code: string | null;
  readonly message: string;
}

export interface MendPageCallView {
  readonly attachmentId: string | null;
  readonly failure: MendPageCallFailureView | null;
}

type Row = Readonly<Record<string, unknown>>;

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const failureOf = (value: unknown): MendPageCallFailureView | null => {
  if (!isRow(value) || typeof value["message"] !== "string") return null;
  const code = value["code"];
  return { code: typeof code === "string" ? code : null, message: value["message"] };
};

export const mendPageCallOf = (item: AgentItemDto): MendPageCallView | null => {
  if (item.kind !== "tool-call" || !isRow(item.data)) return null;
  const call = item.data["mendPageCall"];
  if (!isRow(call)) return null;
  const attachmentId = call["attachmentId"];
  return {
    attachmentId: typeof attachmentId === "string" ? attachmentId : null,
    failure: failureOf(call["failure"]),
  };
};

export const isShownAsPage = (item: AgentItemDto): boolean =>
  (mendPageCallOf(item)?.attachmentId ?? null) !== null;
