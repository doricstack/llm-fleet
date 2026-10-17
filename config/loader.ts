/**
 * Load, validate, and resolve the versioned llm-fleet configuration.
 *
 * `plugins/fleet/config/schema.json` is the single source of truth read by this
 * module and by `plugins/fleet/config/loader.py`. The Python loader and the schema
 * live in the plugin folder because an install copies that folder alone; this
 * module stays here because the host cannot evaluate `node:fs`. Neither loader
 * carries per-key policy, and neither reads a legacy environment override: the
 * override names are recorded in the schema for the migration row, and this
 * loader ignores them by design.
 *
 * Resolution is pure apart from one injected path probe and the platform name.
 * Nothing here starts a process, reads a provider home, or contacts a network. A
 * resolved source or mod is described by one of the declared states, and an
 * unavailable group is never reported as an empty one.
 *
 * This file is written in erasable TypeScript so a current Node runtime can run
 * it directly, without a build step.
 */

import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_NAME = "schema.json";
// The schema sits in the plugin folder, beside the Python loader that an
// install carries; this module reads it from there.
export const SCHEMA_DIRECTORY = join("..", "plugins", "fleet", "config");
export const ROOT_PATH = "";

export const CODE_VERSION = "E_CONFIG_VERSION";
export const CODE_FILE_NOT_FOUND = "E_CONFIG_FILE_NOT_FOUND";
export const CODE_FILE_NOT_REGULAR = "E_CONFIG_FILE_NOT_REGULAR";
export const CODE_UNREADABLE = "E_CONFIG_UNREADABLE";
export const CODE_MALFORMED = "E_CONFIG_MALFORMED";
export const CODE_ROOT_TYPE = "E_CONFIG_ROOT_TYPE";
export const CODE_UNKNOWN_KEY = "E_CONFIG_UNKNOWN_KEY";
export const CODE_TYPE = "E_CONFIG_TYPE";
export const CODE_VALUE = "E_CONFIG_VALUE";
export const CODE_REQUIRED = "E_CONFIG_REQUIRED";
export const CODE_UNRESOLVED_VAR = "E_CONFIG_UNRESOLVED_VAR";
export const CODE_RULE = "E_CONFIG_RULE";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type Probe = (path: string) => string;
export interface ConfigErrorEntry {
  code: string;
  path: string;
}

export interface Field {
  path?: string;
  name?: string;
  type: string;
  default?: JsonValue;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  values?: string[];
  valueValues?: string[];
  valueType?: string;
  valueFields?: Field[];
  recordFields?: Field[];
  keyValues?: string[];
  /** A map key outside keyValues passes here; keyValues stays the shipped defaults. */
  openKeys?: boolean;
  /** A sectionArray item with this prefix passes here; a rule checks it is declared. */
  openPrefix?: string;
  nonEmpty?: boolean;
  mustInclude?: string[];
  required?: boolean;
  requiredWhenEnabled?: boolean;
  version?: boolean;
  legacyEnvironment?: string[];
}

export interface Group {
  id: string;
  path: string;
  fields: string[];
  requiresReadyProvider?: boolean;
  requires?: { field?: string; anyPresent?: string[]; nonEmpty?: boolean; present?: boolean }[];
  targets?: { field: string; kind: string; array?: boolean }[];
  platform?: { field: string; requires: string[]; supported: string[] };
}

export interface Rule {
  rule: string;
  field?: string;
  fields?: string[];
  values?: string[];
  container?: string;
  by?: string;
  prefix?: string;
  keyPattern?: string;
}

export interface Schema {
  schemaVersion: number;
  supportedSchemaVersions: number[];
  environment: { selector: string; variables: string[] };
  configFile: { firstResolvable: string[] };
  types: string[];
  defaultKinds: string[];
  fieldKeys: string[];
  resolvedKeys: string[];
  providerResolutionKeys: string[];
  groupResolutionKeys: string[];
  providerStates: string[];
  sourceStates: string[];
  modStates: string[];
  sections: string[];
  themeTokens: string[];
  stateMeaning: Record<string, string>;
  readerStates: Record<string, string>;
  errorCodes: { code: string; meaning: string }[];
  providerFields: Field[];
  fields: Field[];
  sources: Group[];
  mods: Group[];
  rules: Rule[];
}

/** The configuration cannot be trusted to describe this machine. */
export class ConfigError extends Error {
  errors: ConfigErrorEntry[];

  constructor(errors: ConfigErrorEntry[]) {
    const sorted = errors.slice().sort(compareEntries);
    const detail = sorted
      .map((entry) => `${entry.path || "(root)"}: ${entry.code}`)
      .join("; ");
    super(`configuration refused: ${detail}`);
    this.name = "ConfigError";
    /** Every refusal, sorted by field path then by code. */
    this.errors = sorted;
  }
}

const INVALID = Symbol("invalid");
const SKIP = Symbol("skip");
type Maybe = JsonValue | typeof INVALID;
const schemaCache = new Map<string, Schema>();

function compareEntries(left: ConfigErrorEntry, right: ConfigErrorEntry): number {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1;
  }
  if (left.code !== right.code) {
    return left.code < right.code ? -1 : 1;
  }
  return 0;
}

export function error(code: string, path: string): ConfigErrorEntry {
  return { code, path };
}

export function schemaPath(): string {
  return resolvePath(dirname(fileURLToPath(import.meta.url)), SCHEMA_DIRECTORY, SCHEMA_NAME);
}

/** Read the schema. A broken schema is a packaging defect, not user error. */
export function loadSchema(path?: string): Schema {
  const location = path || schemaPath();
  const cached = schemaCache.get(location);
  if (cached) {
    return cached;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(location, "utf8"));
  } catch (caught) {
    const failure = caught instanceof SyntaxError ? CODE_MALFORMED : CODE_UNREADABLE;
    throw new ConfigError([error(failure, "schema")]);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError([error(CODE_ROOT_TYPE, "schema")]);
  }
  schemaCache.set(location, parsed as Schema);
  return parsed as Schema;
}

export function filesystemProbe(path: string): string {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch (caught) {
    return "missing";
  }
}

function environmentOf(environ?: Record<string, string>): Record<string, string> {
  const source = environ === undefined ? process.env : environ;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
// A percent-delimited name is another platform's expansion form. It is refused
// rather than passed through as a literal directory name.
const PERCENT_VARIABLE = /%[A-Za-z_][A-Za-z0-9_]*%/;

/** Expand declared variables only. Returns the text, or an error code. */
function expand(
  value: string,
  environ: Record<string, string>,
  variables: string[],
): { text: string | null; code: string | null } {
  if (value.startsWith("~") || PERCENT_VARIABLE.test(value)) {
    return { text: null, code: CODE_VALUE };
  }
  const parts: string[] = [];
  let index = 0;
  for (const match of value.matchAll(VARIABLE)) {
    const start = match.index === undefined ? 0 : match.index;
    const gap = value.slice(index, start);
    if (gap.includes("$")) {
      return { text: null, code: CODE_VALUE };
    }
    const name = match[1] || match[2];
    const replacement = environ[name];
    if (!variables.includes(name) || !replacement) {
      return { text: null, code: CODE_UNRESOLVED_VAR };
    }
    parts.push(gap, replacement);
    index = start + match[0].length;
  }
  const tail = value.slice(index);
  if (tail.includes("$")) {
    return { text: null, code: CODE_VALUE };
  }
  parts.push(tail);
  return { text: parts.join(""), code: null };
}

function resolvePathValue(
  value: string,
  configDirectory: string | null,
  environ: Record<string, string>,
  variables: string[],
): { path: string | null; code: string | null } {
  const expanded = expand(value, environ, variables);
  if (expanded.code !== null || expanded.text === null) {
    return { path: null, code: expanded.code || CODE_VALUE };
  }
  if (!expanded.text) {
    return { path: null, code: CODE_VALUE };
  }
  if (isAbsolute(expanded.text)) {
    return { path: normalize(expanded.text), code: null };
  }
  if (configDirectory === null) {
    return { path: null, code: CODE_VALUE };
  }
  return { path: normalize(join(configDirectory, expanded.text)), code: null };
}

class Context {
  schema: Schema;
  environ: Record<string, string>;
  variables: string[];
  configDirectory: string | null;
  platform: string;
  stateDir: string | null;

  constructor(schema: Schema, environ: Record<string, string>, configDirectory: string | null,
              platform: string) {
    this.schema = schema;
    this.environ = environ;
    this.variables = schema.environment.variables;
    this.configDirectory = configDirectory;
    this.platform = platform;
    this.stateDir = null;
  }
}

/**
 * The declared default, an error code when unresolvable, or SKIP.
 *
 * A default that depends on a value that already failed is skipped: the cause
 * is reported once, at the field that owns it.
 */
function defaultValue(field: Field, context: Context): { value: JsonValue | typeof SKIP; code: string | null } {
  const fallback = field.default;
  if (fallback !== null && typeof fallback === "object" && !Array.isArray(fallback)) {
    const record = fallback as JsonObject;
    if ("firstResolvable" in record) {
      for (const candidate of record.firstResolvable as string[]) {
        if (expand(candidate, context.environ, context.variables).code === null) {
          return { value: candidate, code: null };
        }
      }
      return { value: null, code: CODE_UNRESOLVED_VAR };
    }
    if ("resolvedBy" in record) {
      if (record.resolvedBy === "systemTemp") {
        return { value: normalize(tmpdir()), code: null };
      }
      if (record.resolvedBy === "underStateDir") {
        if (context.stateDir === null) {
          return { value: SKIP, code: null };
        }
        return { value: normalize(join(context.stateDir, record.relative as string)), code: null };
      }
      return { value: null, code: CODE_VALUE };
    }
  }
  return { value: fallback === undefined ? null : fallback, code: null };
}

function scalar(
  field: Field,
  value: JsonValue,
  context: Context,
  path: string,
  errors: ConfigErrorEntry[],
): Maybe {
  const kind = field.type;
  if (value === null) {
    if (field.nullable) {
      return null;
    }
    errors.push(error(CODE_TYPE, path));
    return INVALID;
  }
  if (kind === "boolean") {
    if (typeof value !== "boolean") {
      errors.push(error(CODE_TYPE, path));
      return INVALID;
    }
    return value;
  }
  if (kind === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push(error(CODE_TYPE, path));
      return INVALID;
    }
    if (field.minimum !== undefined && value < field.minimum) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    if (field.maximum !== undefined && value > field.maximum) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    if (field.version && !context.schema.supportedSchemaVersions.includes(value)) {
      errors.push(error(CODE_VERSION, path));
      return INVALID;
    }
    return value;
  }
  if (kind === "number") {
    if (typeof value !== "number") {
      errors.push(error(CODE_TYPE, path));
      return INVALID;
    }
    if (field.minimum !== undefined && value < field.minimum) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    if (field.maximum !== undefined && value > field.maximum) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    return value;
  }
  if (kind === "string") {
    if (typeof value !== "string") {
      errors.push(error(CODE_TYPE, path));
      return INVALID;
    }
    if (field.nonEmpty && !value) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    if (field.values !== undefined && !field.values.includes(value)) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    return value;
  }
  if (kind === "key") {
    if (typeof value !== "string") {
      errors.push(error(CODE_TYPE, path));
      return INVALID;
    }
    if (!value || /\s/.test(value)) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    return value;
  }
  if (kind === "path") {
    if (typeof value !== "string") {
      errors.push(error(CODE_TYPE, path));
      return INVALID;
    }
    const resolved = resolvePathValue(value, context.configDirectory, context.environ,
                                     context.variables);
    if (resolved.code !== null || resolved.path === null) {
      errors.push(error(resolved.code || CODE_VALUE, path));
      return INVALID;
    }
    return resolved.path;
  }
  if (kind === "argv") {
    if (!Array.isArray(value)) {
      errors.push(error(CODE_TYPE, path));
      return INVALID;
    }
    if (value.length === 0) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    for (const [index, item] of value.entries()) {
      if (typeof item !== "string" || !item) {
        errors.push(error(CODE_VALUE, `${path}[${index}]`));
        return INVALID;
      }
    }
    return value.slice();
  }
  errors.push(error(CODE_VALUE, path));
  return INVALID;
}

function arrayValue(
  field: Field,
  value: JsonValue,
  context: Context,
  path: string,
  errors: ConfigErrorEntry[],
): Maybe {
  const kind = field.type;
  if (!Array.isArray(value)) {
    errors.push(error(CODE_TYPE, path));
    return INVALID;
  }
  if (kind === "rgb") {
    if (value.length !== 3) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    for (const [index, item] of value.entries()) {
      if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 255) {
        errors.push(error(CODE_VALUE, `${path}[${index}]`));
        return INVALID;
      }
    }
    return value.slice();
  }
  if (kind === "sectionArray") {
    const resolved: string[] = [];
    for (const [index, item] of value.entries()) {
      const itemPath = `${path}[${index}]`;
      if (typeof item !== "string") {
        errors.push(error(CODE_TYPE, itemPath));
        continue;
      }
      // A custom section is named by its prefix here and checked against the
      // sections the document declares by a rule, which can see both.
      const opened = field.openPrefix;
      if (!context.schema.sections.includes(item) && !(opened && item.startsWith(opened))) {
        errors.push(error(CODE_VALUE, itemPath));
        continue;
      }
      resolved.push(item);
    }
    return resolved;
  }
  const resolved: string[] = [];
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "string") {
      errors.push(error(CODE_TYPE, itemPath));
      continue;
    }
    if (kind === "stringArray") {
      if (!item) {
        errors.push(error(CODE_VALUE, itemPath));
        continue;
      }
      resolved.push(item);
      continue;
    }
    const expanded = resolvePathValue(item, context.configDirectory, context.environ,
                                     context.variables);
    if (expanded.code !== null || expanded.path === null) {
      errors.push(error(expanded.code || CODE_VALUE, itemPath));
      continue;
    }
    resolved.push(expanded.path);
  }
  const required = field.mustInclude;
  if (Array.isArray(required) && required.some((item) => !resolved.includes(item))) {
    errors.push(error(CODE_RULE, path));
  }
  return resolved;
}

function mapField(
  field: Field,
  value: JsonValue,
  context: Context,
  path: string,
  errors: ConfigErrorEntry[],
): Maybe {
  if (value === null && field.nullable) {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(error(CODE_TYPE, path));
    return INVALID;
  }
  const inner: Field = { type: field.valueType as string };
  if (field.valueValues !== undefined) {
    inner.values = field.valueValues;
  }
  const resolved: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    const keyPath = `${path}.${key}`;
    // A closed map names every key it may hold, so a key outside the list is a
    // typo and is refused. An open map lists the keys it ships a default for and
    // takes any other: a document adds what the packaged list cannot name ahead
    // of time, such as the family of another vendor's model.
    if (field.keyValues !== undefined && !field.keyValues.includes(key) && !field.openKeys) {
      errors.push(error(CODE_UNKNOWN_KEY, keyPath));
      continue;
    }
    const checked = scalar(inner, item, context, keyPath, errors);
    if (checked !== INVALID) {
      resolved[key] = checked;
    }
  }
  const fallback = field.default;
  if (fallback !== null && typeof fallback === "object" && !Array.isArray(fallback)) {
    for (const [key, item] of Object.entries(fallback as JsonObject)) {
      if (!(key in resolved)) {
        resolved[key] = item;
      }
    }
  }
  return resolved;
}

/**
 * A record's own document, over the one the schema ships for that key.
 *
 * An object whose records are declared by descriptor also ships one of them per
 * key, and that shipped record is the answer for every field the document does
 * not name: a person who sets one field of a section means to change that field
 * and not to blank the rest. Resolving a named record against the descriptor's
 * own default instead made every unnamed field the schema's generic stand-in,
 * so hiding one section renamed it "Section".
 */
function inherited(fallback: JsonObject, key: string, item: JsonValue): JsonValue {
  const shipped = fallback[key];
  if (shipped === null || typeof shipped !== "object" || Array.isArray(shipped)
      || item === null || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }
  return { ...(shipped as JsonObject), ...(item as JsonObject) };
}

/** One record whose keys are declared by descriptor, not by the document. */
function recordField(
  fields: Field[],
  value: JsonValue,
  context: Context,
  path: string,
  errors: ConfigErrorEntry[],
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(error(CODE_TYPE, path));
    return {};
  }
  const declared = new Map<string, Field>();
  for (const entry of fields) {
    declared.set(entry.name as string, entry);
  }
  const resolved: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    const keyPath = `${path}.${key}`;
    const entry = declared.get(key);
    if (entry === undefined) {
      errors.push(error(CODE_UNKNOWN_KEY, keyPath));
      continue;
    }
    const checked = scalar(entry, item, context, keyPath, errors);
    if (checked !== INVALID) {
      resolved[key] = checked;
    }
  }
  for (const [name, entry] of declared) {
    if (name in resolved) {
      continue;
    }
    if (entry.default !== undefined) {
      resolved[name] = entry.default;
    } else {
      errors.push(error(CODE_REQUIRED, `${path}.${name}`));
    }
  }
  return resolved;
}

function objectField(
  field: Field,
  value: JsonValue,
  context: Context,
  path: string,
  errors: ConfigErrorEntry[],
): Maybe {
  if (value === null && field.nullable) {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(error(CODE_TYPE, path));
    return INVALID;
  }
  const declared = new Map<string, Field>();
  for (const entry of field.valueFields || []) {
    declared.set(entry.name as string, entry);
  }
  const fallback: JsonObject = {};
  if (field.default !== null && typeof field.default === "object" && !Array.isArray(field.default)) {
    Object.assign(fallback, field.default as JsonObject);
  }
  const resolved: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    const keyPath = `${path}.${key}`;
    if (field.keyValues !== undefined && !field.keyValues.includes(key)) {
      errors.push(error(CODE_UNKNOWN_KEY, keyPath));
      continue;
    }
    if (field.recordFields !== undefined) {
      resolved[key] = recordField(field.recordFields, inherited(fallback, key, item),
                                  context, keyPath, errors);
      continue;
    }
    if (field.valueFields !== undefined) {
      const entry = declared.get(key);
      if (entry === undefined) {
        continue;
      }
      const checked = scalar(entry, item, context, keyPath, errors);
      if (checked !== INVALID) {
        resolved[key] = checked;
      }
      continue;
    }
    const inner: Field = { type: field.valueType as string };
    if (field.valueType === "stringArray" || field.valueType === "pathArray") {
      const checked = arrayValue(inner, item, context, keyPath, errors);
      if (checked !== INVALID) {
        resolved[key] = checked;
      }
    } else {
      const checked = scalar(inner, item, context, keyPath, errors);
      if (checked !== INVALID) {
        resolved[key] = checked;
      }
    }
  }
  for (const key of field.keyValues || []) {
    if (key in resolved) {
      continue;
    }
    const keyPath = `${path}.${key}`;
    if (key in fallback) {
      resolved[key] = fallback[key];
      continue;
    }
    if (field.recordFields !== undefined) {
      resolved[key] = recordField(field.recordFields, {}, context, keyPath, errors);
      continue;
    }
    if (field.valueFields !== undefined && declared.has(key)) {
      const entry = declared.get(key) as Field;
      if (entry.default !== undefined) {
        resolved[key] = entry.default;
      } else {
        errors.push(error(CODE_REQUIRED, keyPath));
      }
      continue;
    }
    errors.push(error(CODE_REQUIRED, keyPath));
  }
  return resolved;
}

function providers(
  value: JsonValue,
  context: Context,
  path: string,
  errors: ConfigErrorEntry[],
  probe: Probe,
): Maybe {
  if (!Array.isArray(value)) {
    errors.push(error(CODE_TYPE, path));
    return INVALID;
  }
  const declared = new Map<string, Field>();
  for (const field of context.schema.providerFields) {
    declared.set(field.name as string, field);
  }
  const entries: JsonObject[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(error(CODE_TYPE, itemPath));
      continue;
    }
    const record = item as JsonObject;
    for (const key of Object.keys(record)) {
      if (!declared.has(key)) {
        errors.push(error(CODE_UNKNOWN_KEY, `${itemPath}.${key}`));
      }
    }
    const resolved: JsonObject = {};
    for (const [name, field] of declared) {
      const keyPath = `${itemPath}.${name}`;
      if (!(name in record)) {
        resolved[name] = field.default === undefined ? null : field.default;
        if (field.required) {
          errors.push(error(CODE_REQUIRED, keyPath));
        }
        continue;
      }
      const single = scalar(field, record[name], context, keyPath, errors);
      if (single !== INVALID) {
        resolved[name] = single;
      }
    }
    for (const [name, field] of declared) {
      if (field.requiredWhenEnabled && !(name in record) && resolved.enabled === true) {
        errors.push(error(CODE_REQUIRED, `${itemPath}.${name}`));
      }
    }
    const identifier = resolved.id;
    if (typeof identifier !== "string") {
      continue;
    }
    if (seen.has(identifier)) {
      errors.push(error(CODE_VALUE, `${itemPath}.id`));
      continue;
    }
    seen.add(identifier);
    if (typeof resolved.label !== "string") {
      resolved.label = identifier;
    }
    const home = resolved.home;
    if (resolved.enabled !== true) {
      resolved.state = "disabled";
    } else if (typeof home === "string" && probe(home) === "directory") {
      resolved.state = "ready";
    } else {
      resolved.state = "unavailable";
    }
    entries.push(resolved);
  }
  return entries;
}

function fieldValue(
  field: Field,
  value: JsonValue,
  context: Context,
  path: string,
  errors: ConfigErrorEntry[],
  probe: Probe,
): Maybe {
  const kind = field.type;
  if (kind === "providerArray") {
    return providers(value, context, path, errors, probe);
  }
  if (kind === "stringArray" || kind === "pathArray" || kind === "sectionArray"
      || kind === "rgb") {
    return arrayValue(field, value, context, path, errors);
  }
  if (kind === "map") {
    return mapField(field, value, context, path, errors);
  }
  if (kind === "object") {
    return objectField(field, value, context, path, errors);
  }
  return scalar(field, value, context, path, errors);
}

function lookup(source: JsonObject, path: string): { present: boolean; value: JsonValue } {
  let current: JsonValue = source;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)
        || !(part in current)) {
      return { present: false, value: null };
    }
    current = (current as JsonObject)[part];
  }
  return { present: true, value: current };
}

function unknownKeys(
  source: JsonObject,
  known: Set<string>,
  prefix: string,
  errors: ConfigErrorEntry[],
): void {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (known.has(path)) {
      continue;
    }
    let isPrefix = false;
    for (const candidate of known) {
      if (candidate.startsWith(`${path}.`)) {
        isPrefix = true;
        break;
      }
    }
    if (isPrefix) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        unknownKeys(value as JsonObject, known, path, errors);
      } else {
        errors.push(error(CODE_TYPE, path));
      }
      continue;
    }
    errors.push(error(CODE_UNKNOWN_KEY, path));
  }
}

function groupState(
  group: Group,
  values: JsonObject,
  entries: JsonObject[],
  probe: Probe,
  platform: string,
  errors: ConfigErrorEntry[],
): string | null {
  if (values.enabled !== true) {
    return "disabled";
  }
  let incomplete = false;
  for (const rule of group.requires || []) {
    if (rule.anyPresent !== undefined) {
      // Some sources can be satisfied by either of two settings, and one of
      // them is enough: a status line hands over a recorded payload or a folder
      // of priced sessions, and either names what the source reads.
      const present = rule.anyPresent.some((name) => {
        const value = values[name];
        return value !== null && value !== undefined;
      });
      if (!present) {
        incomplete = true;
        errors.push(error(CODE_REQUIRED, group.path));
      }
      continue;
    }
    const name = rule.field as string;
    const value = values[name];
    const empty = value === null || value === undefined || value === ""
      || (Array.isArray(value) && value.length === 0);
    const unmet = rule.nonEmpty ? empty : value === null || value === undefined;
    if (unmet) {
      incomplete = true;
      errors.push(error(CODE_REQUIRED, `${group.path}.${name}`));
    }
  }
  if (incomplete) {
    return null;
  }
  if (group.requiresReadyProvider && !entries.some((entry) => entry.state === "ready")) {
    return "unconfigured";
  }
  const platformRule = group.platform;
  if (platformRule !== undefined) {
    const value = values[platformRule.field];
    if (typeof value === "string" && platformRule.requires.includes(value)
        && !platformRule.supported.includes(platform)) {
      return "unavailable";
    }
  }
  for (const target of group.targets || []) {
    const candidates = values[target.field];
    const paths: JsonValue[] = target.array
      ? (Array.isArray(candidates) ? candidates : [])
      : [candidates === undefined ? null : candidates];
    for (const candidate of paths) {
      // A target nobody configured is not a target to check: a source with two
      // ways in, one of them set, is satisfied by the one it has.
      if (candidate === null || candidate === undefined) {
        continue;
      }
      if (typeof candidate !== "string" || !candidate || probe(candidate) !== target.kind) {
        return "unavailable";
      }
    }
  }
  return "ready";
}

function applyRules(schema: Schema, flat: Record<string, JsonValue>,
                   errors: ConfigErrorEntry[]): void {
  for (const rule of schema.rules) {
    if (rule.rule === "memberOf") {
      const value = flat[rule.field as string];
      const container = flat[rule.container as string];
      const group = flat[rule.by as string];
      if (value === null || value === undefined || container === null
          || typeof container !== "object" || Array.isArray(container)) {
        continue;
      }
      const allowed = (container as JsonObject)[group as string];
      if (Array.isArray(allowed) && typeof value === "string" && !allowed.includes(value)) {
        errors.push(error(CODE_RULE, rule.field as string));
      }
      continue;
    }
    if (rule.rule === "distinct") {
      const seen = new Set<string>();
      for (const path of rule.fields || []) {
        const value = flat[path];
        if (value === null || value === undefined || typeof value !== "string") {
          continue;
        }
        if (seen.has(value)) {
          errors.push(error(CODE_RULE, path));
        }
        seen.add(value);
      }
      continue;
    }
    if (rule.rule === "reserved") {
      // Values another part of the system already binds, such as the digits
      // the pane folds its sections with: a field holding one loads as a
      // control that never fires.
      const values = rule.values || [];
      for (const path of rule.fields || []) {
        const value = flat[path];
        if (typeof value === "string" && values.includes(value)) {
          errors.push(error(CODE_RULE, path));
        }
      }
      continue;
    }
    if (rule.rule === "sectionsDeclared") {
      // Each declared section's name is plain enough to address, and each one
      // the order names is declared.
      const container = flat[rule.container as string];
      const names = container !== null && typeof container === "object" && !Array.isArray(container)
        ? Object.keys(container) : [];
      const pattern = new RegExp(rule.keyPattern as string);
      for (const key of names) {
        if (!pattern.test(key)) {
          errors.push(error(CODE_RULE, `${rule.container}.${key}`));
        }
      }
      const order = flat[rule.field as string];
      const prefix = rule.prefix as string;
      if (Array.isArray(order)) {
        for (const [index, item] of order.entries()) {
          if (typeof item === "string" && item.startsWith(prefix)
              && !names.includes(item.slice(prefix.length))) {
            errors.push(error(CODE_RULE, `${rule.field}[${index}]`));
          }
        }
      }
      continue;
    }
    if (rule.rule === "distinctValues") {
      const value = flat[rule.field as string];
      if (Array.isArray(value)) {
        const seen = new Set<string>();
        for (const item of value) {
          if (typeof item === "string") {
            if (seen.has(item)) {
              errors.push(error(CODE_RULE, rule.field as string));
              break;
            }
            seen.add(item);
          }
        }
      }
    }
  }
}

function readConfig(
  selectorPath: string | null | undefined,
  environment: Record<string, string>,
  schema: Schema,
  errors: ConfigErrorEntry[],
): { directory: string | null; document: JsonObject } {
  const selector = schema.environment.selector;
  const variables = schema.environment.variables;
  let selected: string | null = null;
  if (selectorPath !== undefined && selectorPath !== null) {
    selected = selectorPath;
  } else if (selector in environment) {
    const expanded = expand(environment[selector], environment, variables);
    if (expanded.code !== null) {
      errors.push(error(expanded.code, `$${selector}`));
      return { directory: null, document: {} };
    }
    if (expanded.text === null || !isAbsolute(expanded.text)) {
      errors.push(error(CODE_VALUE, `$${selector}`));
      return { directory: null, document: {} };
    }
    selected = expanded.text;
  } else {
    for (const candidate of schema.configFile.firstResolvable) {
      const expanded = expand(candidate, environment, variables);
      if (expanded.code !== null) {
        continue;
      }
      if (expanded.text && filesystemProbe(expanded.text) === "file") {
        selected = expanded.text;
      }
      break;
    }
  }
  if (selected === null) {
    return { directory: null, document: {} };
  }
  const kind = filesystemProbe(selected);
  if (kind === "missing") {
    errors.push(error(CODE_FILE_NOT_FOUND, `$${selector}`));
    return { directory: null, document: {} };
  }
  if (kind !== "file") {
    errors.push(error(CODE_FILE_NOT_REGULAR, `$${selector}`));
    return { directory: null, document: {} };
  }
  let text: string;
  try {
    text = readFileSync(selected, "utf8");
  } catch (caught) {
    errors.push(error(CODE_UNREADABLE, `$${selector}`));
    return { directory: null, document: {} };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (caught) {
    errors.push(error(CODE_MALFORMED, ROOT_PATH));
    return { directory: null, document: {} };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    errors.push(error(CODE_ROOT_TYPE, ROOT_PATH));
    return { directory: null, document: {} };
  }
  return { directory: dirname(resolvePath(selected)), document: document as JsonObject };
}

function assemble(schema: Schema, flat: Record<string, JsonValue>, probe: Probe,
                  platform: string, errors: ConfigErrorEntry[]): JsonObject {
  const resolved: JsonObject = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let node = resolved;
    for (const part of parts.slice(0, -1)) {
      if (node[part] === undefined || typeof node[part] !== "object") {
        node[part] = {};
      }
      node = node[part] as JsonObject;
    }
    node[parts[parts.length - 1]] = value;
  }
  const providers = (flat.providers === undefined ? [] : flat.providers) as JsonObject[];
  for (const group of [...schema.sources, ...schema.mods]) {
    let node = resolved;
    for (const part of group.path.split(".")) {
      node = node[part] as JsonObject;
    }
    const values = { ...node };
    const annotated: JsonObject = { enabled: values.enabled };
    annotated.state = groupState(group, values, providers, probe, platform, errors);
    for (const name of group.fields) {
      if (name !== "enabled") {
        const value = values[name];
        annotated[name] = value === undefined ? null : value;
      }
    }
    if (group.requiresReadyProvider) {
      annotated.providers = providers
        .filter((entry) => entry.state === "ready")
        .map((entry) => entry.id);
    }
    for (const key of Object.keys(node)) {
      delete node[key];
    }
    Object.assign(node, annotated);
  }
  return resolved;
}

export interface LoadOptions {
  configPath?: string | null;
  environ?: Record<string, string>;
  probe?: Probe;
  schemaFile?: string;
  platform?: string;
}

/**
 * Resolve the configuration, or throw ConfigError carrying every refusal.
 *
 * `schemaFile` and `platform` exist so a test can prove the loader follows the
 * contract it is given, and resolve a platform rule, without editing this module.
 */
export function loadConfig(options: LoadOptions = {}): JsonObject {
  const schema = loadSchema(options.schemaFile);
  const environ = environmentOf(options.environ);
  const probe = options.probe === undefined ? filesystemProbe : options.probe;
  const platform = options.platform === undefined ? process.platform : options.platform;
  const errors: ConfigErrorEntry[] = [];
  const located = readConfig(options.configPath, environ, schema, errors);
  const context = new Context(schema, environ, located.directory, platform);
  const known = new Set<string>();
  for (const field of schema.fields) {
    known.add(field.path as string);
  }
  unknownKeys(located.document, known, ROOT_PATH, errors);
  const flat: Record<string, JsonValue> = {};
  for (const field of schema.fields) {
    const path = field.path as string;
    let raw: JsonValue;
    const found = lookup(located.document, path);
    if (found.present) {
      raw = found.value;
    } else {
      const fallback = defaultValue(field, context);
      if (fallback.value === SKIP) {
        continue;
      }
      if (fallback.code !== null) {
        errors.push(error(fallback.code, path));
        continue;
      }
      raw = fallback.value;
    }
    const value = fieldValue(field, raw, context, path, errors, probe);
    if (value !== INVALID) {
      flat[path] = value;
      if (path === "stateDir" && typeof value === "string") {
        context.stateDir = value;
      }
    }
  }
  applyRules(schema, flat, errors);
  if (errors.length) {
    throw new ConfigError(errors);
  }
  const resolved = assemble(schema, flat, probe, platform, errors);
  if (errors.length) {
    throw new ConfigError(errors);
  }
  return resolved;
}
