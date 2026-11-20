/** `undogen/wrap`: undo for the tools of another MCP server (experimental). */
export { planTools, describePlan, resultKeysFor, type McpTool, type ToolPlan, type ToolOverrides, type ToolCallTemplate, type ArgSource, type ToolStrategy } from './plans.js';
export { ToolSession, ToolRefusedError, ToolUndoError, ToolConflictError, resultData, type ToolEntry, type ToolCall, type CallUpstream, type ToolSessionOptions } from './session.js';
export { createWrapServer, listAllTools, type WrapOptions } from './server.js';
