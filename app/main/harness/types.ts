export type JSONSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: (args: unknown, ctx: ToolCtx) => Promise<ToolResult>;
}

export interface ToolCtx {
  projectRoot: string;
  signal: AbortSignal;
  emit: (event: HarnessEvent) => void;
}

export interface ToolResult {
  output: unknown;
  isError?: boolean;
}

export interface Attachment {
  kind: 'image' | 'file';
  path: string;
  mimeType?: string;
}

export interface PermissionRequest {
  id: string;
  tool: string;
  input: unknown;
  reason?: string;
}

export type PermissionDecision = 'allow' | 'allow_once' | 'deny';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type HarnessEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: unknown; isError?: boolean }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'turn_done'; usage?: Usage }
  | { type: 'error'; error: SerializedError };

export interface Turn {
  turnId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: unknown;
    output?: unknown;
    isError?: boolean;
  }>;
  ts: string;
}

export interface LoadedSkill {
  name: string;
  description: string;
  body: string;
  dir: string;
  pluginName: string;
}

export interface LoadedAgent {
  name: string;
  description: string;
  body: string;
  path: string;
  tools: string[];
  pluginName: string;
}

export interface StartSessionOpts {
  projectRoot: string;
  systemPrompt?: string;
  tools: ToolDef[];
  skills: LoadedSkill[];
  agents: LoadedAgent[];
  permissionCallback: (req: PermissionRequest) => Promise<PermissionDecision>;
  model?: string;
}

export interface HarnessSession {
  send(
    message: string,
    opts?: { attachments?: Attachment[] },
  ): AsyncIterable<HarnessEvent>;
  approvePermission(id: string, decision: PermissionDecision): void;
  interrupt(): void;
  history(): Turn[];
  dispose(): Promise<void>;
}

export interface HarnessAdapter {
  readonly id: 'copilot' | 'claude' | 'openai' | 'mock' | string;
  startSession(opts: StartSessionOpts): Promise<HarnessSession>;
  dispose(): Promise<void>;
}
