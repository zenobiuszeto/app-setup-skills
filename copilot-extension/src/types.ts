// ─── Shared type definitions ────────────────────────────────────────────────

/** OpenAI-compatible chat message */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  /** Required when role === 'tool' */
  tool_call_id?: string;
  name?: string;
}

/** A single tool/function call requested by the model */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded string of the arguments object */
    arguments: string;
  };
}

/** OpenAI function-tool definition sent to the model */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

/** Parsed Copilot agent request body */
export interface CopilotPayload {
  messages: ChatMessage[];
  copilot_thread_id?: string;
}
