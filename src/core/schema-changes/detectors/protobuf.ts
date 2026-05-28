// src/core/schema-changes/detectors/protobuf.ts
//
// Protobuf detector. Uses a regex parser (proto3 message bodies are
// simple enough for our purposes) and gracefully consults protobufjs
// if present. Fancier full-AST diff lives in v8.7.

import type { SchemaChangeEntry } from '../types.ts';

interface DetectInput {
  file: string;
  beforeText?: string;
  afterText?: string;
}

interface ProtoField {
  name: string;
  number: number;
  deprecated: boolean;
  reserved: boolean;
}

const FIELD_RE = /^\s*(?:(repeated|optional|required)\s+)?(\w+(?:\.\w+)*)\s+(\w+)\s*=\s*(\d+)\s*(?:\[([^\]]*)\])?\s*;/;
const RESERVED_RE = /^\s*reserved\s+(.+);/;
// MESSAGE_RE intentionally does NOT require `{` on the same line — the
// normalization step below splits `{` onto its own line.
const MESSAGE_RE = /^\s*message\s+(\w+)\b/;

function parseProto(text: string): Map<string, Map<string, ProtoField>> {
  const result = new Map<string, Map<string, ProtoField>>();
  // Normalize: insert newlines so inline `message X { y; }` is parseable.
  const normalized = text
    .replace(/\/\/.*$/gm, '')         // strip line comments
    .replace(/\{/g, '\n{\n')
    .replace(/\}/g, '\n}\n')
    .replace(/;/g, ';\n');
  const lines = normalized.split(/\r?\n/);
  let currentMessage: string | null = null;
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const msg = MESSAGE_RE.exec(line);
    if (msg && msg[1]) {
      currentMessage = msg[1];
      depth = 0;
      if (!result.has(currentMessage)) result.set(currentMessage, new Map());
      continue;
    }
    if (currentMessage) {
      if (line === '{') {
        depth++;
        continue;
      }
      if (line === '}') {
        depth--;
        if (depth <= 0) {
          currentMessage = null;
          depth = 0;
        }
        continue;
      }
      const reserved = RESERVED_RE.exec(line);
      if (reserved && reserved[1]) {
        const tokens = reserved[1].split(',').map((s) => s.trim());
        const bucket = result.get(currentMessage);
        if (bucket) {
          for (const tok of tokens) {
            const stripped = tok.replace(/['"]/g, '');
            bucket.set(`__reserved:${stripped}`, { name: stripped, number: -1, deprecated: false, reserved: true });
          }
        }
        continue;
      }
      const field = FIELD_RE.exec(line);
      if (field) {
        const name = field[3];
        const numberStr = field[4];
        if (!name || !numberStr) continue;
        const number = Number(numberStr);
        const opts = field[5] ?? '';
        const deprecated = /deprecated\s*=\s*true/.test(opts);
        const bucket = result.get(currentMessage);
        if (bucket) bucket.set(name, { name, number, deprecated, reserved: false });
      }
    }
  }
  return result;
}

export async function detectProtobufChanges(input: DetectInput): Promise<SchemaChangeEntry[]> {
  const after = input.afterText ?? '';
  const before = input.beforeText ?? '';

  if (after.trim().length === 0 && before.trim().length === 0) return [];

  // protobufjs is optional — text-regex parsing works without it. We still
  // attempt the import so a future v8.7 detector can swap in its AST.
  try {
    await import('protobufjs');
  } catch {
    // Continue with the regex parser.
  }

  const afterMsgs = parseProto(after);
  const beforeMsgs = parseProto(before);

  const entries: SchemaChangeEntry[] = [];
  let statementIndex = 0;

  for (const [msgName, after] of afterMsgs) {
    const before = beforeMsgs.get(msgName);
    for (const [fname, afield] of after) {
      if (afield.reserved) {
        if (!before || !before.has(fname)) {
          entries.push({
            file: input.file,
            kind: 'protobuf.reserve_field',
            objectName: msgName,
            subObjectName: afield.name,
            statementIndex: statementIndex++,
            additive: true,
            description: `Reserve field ${msgName}.${afield.name}`,
          });
        }
        continue;
      }
      const bfield = before?.get(fname);
      if (!bfield) {
        entries.push({
          file: input.file,
          kind: 'protobuf.add_field',
          objectName: msgName,
          subObjectName: afield.name,
          statementIndex: statementIndex++,
          additive: true,
          description: `Add field ${msgName}.${afield.name} = ${afield.number}`,
        });
      } else if (!bfield.deprecated && afield.deprecated) {
        entries.push({
          file: input.file,
          kind: 'protobuf.deprecate_field',
          objectName: msgName,
          subObjectName: afield.name,
          statementIndex: statementIndex++,
          additive: true,
          description: `Deprecate field ${msgName}.${afield.name}`,
        });
      }
    }
  }
  return entries;
}
