import type { JsonValue, UnixMillis } from './json';

export type VariableName = string;

/** Persistent variable name — must start with `$`. */
export type PersistentVariableName = `$${string}`;

export type VariableScope = 'run' | 'flow' | 'persistent';

export interface VariablePointer {
  scope: VariableScope;
  name: VariableName;
  /** Optional JSON path for accessing nested properties. */
  path?: ReadonlyArray<string | number>;
}

export interface VariableDefinition {
  name: VariableName;
  label?: string;
  description?: string;
  /** When true, the variable is hidden from display/export. */
  sensitive?: boolean;
  required?: boolean;
  default?: JsonValue;
  /** Persistent scope is implied by a `$` prefix and excluded here. */
  scope?: Exclude<VariableScope, 'persistent'>;
}

export interface PersistentVarRecord {
  key: PersistentVariableName;
  value: JsonValue;
  updatedAt: UnixMillis;
  /** Monotonic version, used for LWW and debugging. */
  version: number;
}

export function isPersistentVariable(name: string): name is PersistentVariableName {
  return name.startsWith('$');
}

/**
 * Parse a variable reference string.
 * @example "$user.name" -> { scope: 'persistent', name: '$user', path: ['name'] }
 */
export function parseVariablePointer(ref: string): VariablePointer | null {
  if (!ref) return null;

  const parts = ref.split('.');
  const name = parts[0];
  const path = parts.slice(1);

  if (isPersistentVariable(name)) {
    return {
      scope: 'persistent',
      name,
      path: path.length > 0 ? path : undefined,
    };
  }

  return {
    scope: 'run',
    name,
    path: path.length > 0 ? path : undefined,
  };
}
