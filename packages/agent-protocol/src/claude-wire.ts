/** Claude Code version whose private stream-json message shapes these types track. */
export const CLAUDE_CODE_PROTOCOL_VERSION = "2.1.238";

/** Minimal vendored user-message shape from the Claude Agent SDK sdk.d.ts. */
export interface ClaudeUserMessage {
  readonly type: "user";
  readonly session_id: string;
  readonly parent_tool_use_id: string | null;
  readonly origin: { readonly kind: "human" };
  readonly message: {
    readonly role: "user";
    readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  };
}

/** Private CLI request used for permissions and interrupt control. */
export interface ClaudeControlRequest {
  readonly type: "control_request";
  readonly request_id: string;
  readonly request:
    | {
        readonly subtype: "can_use_tool";
        readonly tool_name: string;
        readonly input: Readonly<Record<string, unknown>>;
        readonly permission_suggestions?: ReadonlyArray<unknown>;
      }
    | { readonly subtype: "interrupt" }
    /** Stop one background task (`SDKControlStopTaskRequest`). */
    | { readonly subtype: "stop_task"; readonly task_id: string }
    /** A repeated `initialize` is answered with the live background tasks. */
    | { readonly subtype: "initialize" };
}

/** Private CLI response envelope for a control request. */
export interface ClaudeControlResponse {
  readonly type: "control_response";
  readonly response: {
    readonly subtype: "success";
    readonly request_id: string;
    readonly response: Readonly<Record<string, unknown>>;
  };
}
