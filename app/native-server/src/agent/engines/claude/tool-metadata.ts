/**
 * Pure helpers for classifying and enriching tool-use events emitted by
 * Claude. Pulled out of `ClaudeEngine.initializeAndRun` so the stream
 * loop is a thin dispatcher and the action-inference rules can be
 * extended without touching the run lifecycle.
 *
 * All functions here are pure: same input → same output, no module
 * state, no I/O.
 */
import { pickFirstString } from './extractors';

/**
 * Tool action type for categorizing tool operations.
 */
export type ToolAction =
  | 'Edited'
  | 'Created'
  | 'Read'
  | 'Deleted'
  | 'Generated'
  | 'Searched'
  | 'Executed';

/**
 * Map of tool names to their corresponding actions.
 */
const TOOL_NAME_ACTION_MAP: Record<string, ToolAction> = {
  read: 'Read',
  read_file: 'Read',
  write: 'Created',
  write_file: 'Created',
  create_file: 'Created',
  edit: 'Edited',
  edit_file: 'Edited',
  apply_patch: 'Edited',
  patch_file: 'Edited',
  remove_file: 'Deleted',
  delete_file: 'Deleted',
  list_files: 'Searched',
  glob: 'Searched',
  glob_files: 'Searched',
  search_files: 'Searched',
  grep: 'Searched',
  bash: 'Executed',
  run: 'Executed',
  shell: 'Executed',
  todo_write: 'Generated',
  plan_write: 'Generated',
};

/**
 * Infer tool action from tool name. Returns undefined when no rule matches.
 */
export function inferActionFromToolName(toolName: unknown): ToolAction | undefined {
  if (typeof toolName !== 'string') return undefined;
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return undefined;

  if (TOOL_NAME_ACTION_MAP[normalized]) {
    return TOOL_NAME_ACTION_MAP[normalized];
  }

  // Try suffix after colon (e.g., "mcp__server__tool" -> "tool")
  const suffix = normalized.split(':').pop() ?? normalized;
  if (suffix && TOOL_NAME_ACTION_MAP[suffix]) {
    return TOOL_NAME_ACTION_MAP[suffix];
  }

  // Infer from name patterns
  if (
    normalized.includes('edit') ||
    normalized.includes('modify') ||
    normalized.includes('patch')
  ) {
    return 'Edited';
  }
  if (normalized.includes('write') || normalized.includes('create')) {
    return 'Created';
  }
  if (normalized.includes('read') || normalized.includes('view')) {
    return 'Read';
  }
  if (normalized.includes('delete') || normalized.includes('remove')) {
    return 'Deleted';
  }
  if (
    normalized.includes('search') ||
    normalized.includes('find') ||
    normalized.includes('glob') ||
    normalized.includes('grep')
  ) {
    return 'Searched';
  }
  if (
    normalized.includes('bash') ||
    normalized.includes('shell') ||
    normalized.includes('exec')
  ) {
    return 'Executed';
  }
  if (normalized.includes('todo') || normalized.includes('plan')) {
    return 'Generated';
  }

  return undefined;
}

/**
 * Build tool metadata from content block with detailed tool-specific
 * information. Mirrors the legacy inline closure exactly.
 */
export function buildToolMetadata(contentBlock: Record<string, unknown>): Record<string, unknown> {
  const toolName = pickFirstString(contentBlock.name) || 'unknown';
  const toolId = pickFirstString(contentBlock.id);
  const input = contentBlock.input as Record<string, unknown> | undefined;
  const action = inferActionFromToolName(toolName);

  const metadata: Record<string, unknown> = {
    toolName,
    tool_name: toolName,
    toolId,
    action,
  };

  if (!input) {
    return metadata;
  }

  // Extract tool-specific details
  const normalizedName = toolName.toLowerCase();

  // File operations (read, write, edit)
  if (typeof input.file_path === 'string') {
    metadata.filePath = input.file_path;
  }

  // Edit tool - extract diff information
  if (
    normalizedName.includes('edit') ||
    normalizedName === 'apply_patch' ||
    normalizedName === 'patch_file'
  ) {
    if (typeof input.old_string === 'string') {
      metadata.oldString = input.old_string;
      metadata.deletedLines = input.old_string.split('\n').length;
    }
    if (typeof input.new_string === 'string') {
      metadata.newString = input.new_string;
      metadata.addedLines = input.new_string.split('\n').length;
    }
    if (typeof input.replace_all === 'boolean') {
      metadata.replaceAll = input.replace_all;
    }
  }

  // Write tool - content preview
  if (normalizedName.includes('write') || normalizedName === 'create_file') {
    if (typeof input.content === 'string') {
      metadata.contentPreview = input.content.slice(0, 200);
      metadata.totalLines = input.content.split('\n').length;
    }
  }

  // Read tool - offset/limit
  if (normalizedName.includes('read')) {
    if (typeof input.offset === 'number') metadata.offset = input.offset;
    if (typeof input.limit === 'number') metadata.limit = input.limit;
  }

  // Bash/shell - command
  if (
    normalizedName === 'bash' ||
    normalizedName.includes('shell') ||
    normalizedName === 'run'
  ) {
    if (typeof input.command === 'string') {
      metadata.command = input.command;
    }
    if (typeof input.description === 'string') {
      metadata.commandDescription = input.description;
    }
  }

  // Search tools (grep, glob)
  if (normalizedName === 'grep' || normalizedName.includes('search')) {
    if (typeof input.pattern === 'string') metadata.pattern = input.pattern;
    if (typeof input.path === 'string') metadata.searchPath = input.path;
    if (typeof input.glob === 'string') metadata.glob = input.glob;
    if (typeof input.output_mode === 'string') metadata.outputMode = input.output_mode;
  }

  if (normalizedName === 'glob' || normalizedName === 'glob_files') {
    if (typeof input.pattern === 'string') metadata.pattern = input.pattern;
    if (typeof input.path === 'string') metadata.searchPath = input.path;
  }

  // TodoWrite
  if (normalizedName === 'todo_write' || normalizedName === 'todowrite') {
    if (Array.isArray(input.todos)) {
      metadata.todoCount = input.todos.length;
      metadata.todos = input.todos;
    }
  }

  // Store raw input for debugging (truncated)
  metadata.rawInput = JSON.stringify(input).slice(0, 1000);

  return metadata;
}
