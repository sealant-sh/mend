import type { OrchestrationV2SearchThreadInput } from "@mend/t3-contracts";
// t3code's client highlights matches through `threadFindText.ts` and `threadSearch.ts`; counts
// read any other way drift from what it highlights.
import {
  searchableMessageSegments,
  searchablePlanSegments,
} from "@mend/t3-contracts/thread-find-text";

export type Skills = NonNullable<OrchestrationV2SearchThreadInput["skills"]>;

export interface ParseRequest {
  readonly role: "user" | "assistant" | "plan";
  readonly text: string;
  readonly streaming: boolean;
  readonly hasContext: boolean;
  readonly cwd: string | undefined;
  readonly skills: Skills;
}

export const parseSegments = ({
  role,
  text,
  streaming,
  hasContext,
  cwd,
  skills,
}: ParseRequest): ReadonlyArray<string> =>
  role === "plan"
    ? searchablePlanSegments(text, cwd)
    : (searchableMessageSegments(
        {
          role,
          text,
          streaming,
          context: hasContext ? { version: 1, records: [] } : undefined,
        },
        cwd,
        skills,
      ) ?? []);
