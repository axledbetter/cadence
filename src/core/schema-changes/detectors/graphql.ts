// src/core/schema-changes/detectors/graphql.ts
//
// GraphQL schema detector. Lazy-imports `graphql` so cadence install
// stays light when GraphQL detection isn't opted into.

import type { SchemaChangeEntry } from '../types.ts';

interface DetectInput {
  file: string;
  beforeText?: string;
  afterText?: string;
}

interface GqlField {
  name: string;
  type: string;
  deprecated: boolean;
}

interface GqlType {
  name: string;
  kind: 'object' | 'enum' | 'interface' | 'input';
  fields: Map<string, GqlField>;
  enumValues: Set<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function indexSchema(parsed: any): Map<string, GqlType> {
  const out = new Map<string, GqlType>();
  if (!parsed || !Array.isArray(parsed.definitions)) return out;
  for (const def of parsed.definitions) {
    const name = def?.name?.value;
    if (!name) continue;
    let kind: GqlType['kind'] | null = null;
    if (def.kind === 'ObjectTypeDefinition') kind = 'object';
    else if (def.kind === 'EnumTypeDefinition') kind = 'enum';
    else if (def.kind === 'InterfaceTypeDefinition') kind = 'interface';
    else if (def.kind === 'InputObjectTypeDefinition') kind = 'input';
    if (!kind) continue;
    const fields = new Map<string, GqlField>();
    if (Array.isArray(def.fields)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of def.fields as any[]) {
        const fname = f?.name?.value;
        if (!fname) continue;
        const dep = Array.isArray(f.directives) && f.directives.some((d: { name?: { value?: string } }) => d.name?.value === 'deprecated');
        fields.set(fname, { name: fname, type: JSON.stringify(f.type ?? null), deprecated: dep });
      }
    }
    const enumValues = new Set<string>();
    if (Array.isArray(def.values)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const v of def.values as any[]) {
        const vn = v?.name?.value;
        if (vn) enumValues.add(vn);
      }
    }
    out.set(name, { name, kind, fields, enumValues });
  }
  return out;
}

export async function detectGraphqlChanges(input: DetectInput): Promise<SchemaChangeEntry[]> {
  const after = input.afterText ?? '';
  const before = input.beforeText ?? '';

  if (after.trim().length === 0 && before.trim().length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gql: any;
  try {
    gql = await import('graphql');
  } catch {
    return [{
      file: input.file,
      kind: 'unknown.unsupported_kind',
      additive: false,
      description: 'graphql parser not installed; install optional dependency to enable GraphQL detection',
    }];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let afterParsed: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let beforeParsed: any = null;
  try {
    afterParsed = after.trim() ? gql.parse(after, { noLocation: true }) : null;
  } catch (err) {
    return [{
      file: input.file,
      kind: 'unknown.unparseable',
      additive: false,
      description: `GraphQL parse failed: ${(err as Error).message}; agent must hand-author this manifest entry`,
    }];
  }
  try {
    beforeParsed = before.trim() ? gql.parse(before, { noLocation: true }) : null;
  } catch {
    beforeParsed = null;
  }

  const afterTypes = afterParsed ? indexSchema(afterParsed) : new Map<string, GqlType>();
  const beforeTypes = beforeParsed ? indexSchema(beforeParsed) : new Map<string, GqlType>();

  const entries: SchemaChangeEntry[] = [];
  let statementIndex = 0;

  for (const [typeName, after] of afterTypes) {
    const before = beforeTypes.get(typeName);
    if (!before) {
      // New type — all fields are "add_field" entries.
      for (const [fname] of after.fields) {
        entries.push({
          file: input.file,
          kind: 'graphql.add_field',
          objectName: typeName,
          subObjectName: fname,
          statementIndex: statementIndex++,
          additive: true,
          description: `Add field ${typeName}.${fname}`,
        });
      }
      for (const v of after.enumValues) {
        entries.push({
          file: input.file,
          kind: 'graphql.add_enum_value',
          objectName: typeName,
          subObjectName: v,
          statementIndex: statementIndex++,
          additive: true,
          description: `Add enum value ${typeName}.${v}`,
        });
      }
      continue;
    }
    // Compare fields.
    for (const [fname, afield] of after.fields) {
      const bfield = before.fields.get(fname);
      if (!bfield) {
        entries.push({
          file: input.file,
          kind: 'graphql.add_field',
          objectName: typeName,
          subObjectName: fname,
          statementIndex: statementIndex++,
          additive: true,
          description: `Add field ${typeName}.${fname}`,
        });
      } else if (!bfield.deprecated && afield.deprecated) {
        entries.push({
          file: input.file,
          kind: 'graphql.deprecate_field',
          objectName: typeName,
          subObjectName: fname,
          statementIndex: statementIndex++,
          additive: true,
          description: `Deprecate field ${typeName}.${fname}`,
        });
      }
    }
    for (const [fname] of before.fields) {
      if (!after.fields.has(fname)) {
        entries.push({
          file: input.file,
          kind: 'graphql.remove_field',
          objectName: typeName,
          subObjectName: fname,
          statementIndex: statementIndex++,
          additive: false,
          description: `Remove field ${typeName}.${fname}`,
        });
      }
    }
    // Enum values.
    for (const v of after.enumValues) {
      if (!before.enumValues.has(v)) {
        entries.push({
          file: input.file,
          kind: 'graphql.add_enum_value',
          objectName: typeName,
          subObjectName: v,
          statementIndex: statementIndex++,
          additive: true,
          description: `Add enum value ${typeName}.${v}`,
        });
      }
    }
    for (const v of before.enumValues) {
      if (!after.enumValues.has(v)) {
        entries.push({
          file: input.file,
          kind: 'graphql.remove_enum_value',
          objectName: typeName,
          subObjectName: v,
          statementIndex: statementIndex++,
          additive: false,
          description: `Remove enum value ${typeName}.${v}`,
        });
      }
    }
  }
  // Removed types (treat as remove_field of all fields).
  for (const [typeName, before] of beforeTypes) {
    if (afterTypes.has(typeName)) continue;
    for (const [fname] of before.fields) {
      entries.push({
        file: input.file,
        kind: 'graphql.remove_field',
        objectName: typeName,
        subObjectName: fname,
        statementIndex: statementIndex++,
        additive: false,
        description: `Remove field ${typeName}.${fname} (type ${typeName} removed)`,
      });
    }
  }
  return entries;
}
