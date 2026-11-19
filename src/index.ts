export { analyze, planOperation, tokenize, type AnalyzeOptions } from './analyze.js';
export { loadSpec, parseSpec, normalizeSchema, type LoadOptions, type ParseOptions } from './spec.js';
export {
  UndoableClient,
  IrreversibleOperationError,
  ReplayBlockedError,
  UndoError,
  ConflictError,
  DependencyError,
  MemoryJournalStore,
  FileJournalStore,
  type CallInput,
  type CapturedChildren,
  type ClientOptions,
  type Conflict,
  type EntryStatus,
  type HttpResult,
  type IrreversibleContext,
  type JournalEntry,
  type JournalStore,
  type OutgoingRequest,
  type ResolvedRequest,
  type UndoOptions,
} from './runtime.js';
export {
  verify,
  diffStates,
  synthesize,
  DEFAULT_IGNORED_FIELDS,
  type Fixture,
  type Fixtures,
  type OperationResult,
  type Outcome,
  type StateDiff,
  type VerifyOptions,
  type VerifyReport,
} from './verify.js';
export { formatAnalysis, toMarkdown, toBadge } from './report.js';
export { VERSION } from './version.js';
export type * from './types.js';
export { formatResultLine, formatSummary, toJUnit, toSarif, toHtml, analysisToHtml, redactReport } from './report.js';
export { annotate, toArazzo, toBundle, toDeclaration, toLink, type AnnotateOptions } from './export.js';
export { learn, candidateIds, type LearnAttempt, type LearnOptions, type LearnResult } from './learn.js';
export { initFiles, type InitResult } from './init.js';
export { toolDefinitions, toolName, describeEntry, type ToolAnnotations, type ToolDefinition, type ToolOptions } from './tools.js';
export { diffAnalyses, diffToMarkdown, type AnalysisDiff, type ChangeKind, type PlanChange } from './diff.js';
export { lint, type LintFinding, type LintSeverity } from './lint.js';
// The MCP server lives at 'undogen/mcp' so the core library does not load the MCP SDK.
