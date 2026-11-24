/**
 * Load, validate, and resolve the versioned llm-fleet configuration.
 *
 * `plugins/llm-fleet/config/schema.json` is the single source of truth read by this
 * module and by `plugins/llm-fleet/config/loader.py`. The Python loader and the schema
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

import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve as resolvePath, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_NAME = "schema.json";
// The schema sits in the plugin folder, beside the Python loader that an
// install carries; this module reads it from there.
export const SCHEMA_DIRECTORY = join("..", "plugins", "llm-fleet", "config");
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
  /** Which of a code's causes this failure was, where it has more than one. */
  detail?: string;
}

export interface Field {
  expandHome?: boolean;
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
  environment: { selector: string; variables: string[]; aliases?: Record<string, string> };
  configFile: { firstResolvable: string[] };
  types: string[];
  defaultKinds: string[];
  numberLimits: { safeInteger: number };
  keyForbiddenRanges: [number, number][];
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

export function error(code: string, path: string, detail?: string): ConfigErrorEntry {
  return detail === undefined ? { code, path } : { code, path, detail };
}

export function schemaPath(): string {
  return resolvePath(dirname(fileURLToPath(import.meta.url)), SCHEMA_DIRECTORY, SCHEMA_NAME);
}

/**
 * A file's bytes as text, with the byte order mark a decoder strips by itself.
 *
 * A Windows editor may write the file with a byte order mark, which reads as
 * the same text once it is dropped, and may save in an ANSI code page, which
 * has no text to give. A decoder that is not fatal would replace each such
 * byte with U+FFFD and hand a mangled path to the rest of the load; the Python
 * loader reads as utf-8-sig and refuses the same bytes, so this returns null
 * and the caller reports the document malformed. TextDecoder drops the first
 * mark itself; a second one is a character in the document and json refuses
 * it, which is what the Python loader does with the same bytes.
 */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (caught) {
    return null;
  }
}

/** Read the schema. A broken schema is a packaging defect, not user error. */
export function loadSchema(path?: string): Schema {
  const location = path || schemaPath();
  const cached = schemaCache.get(location);
  if (cached) {
    return cached;
  }
  let text: string | null;
  try {
    text = decodeUtf8(readFileSync(location));
  } catch (caught) {
    throw new ConfigError([error(CODE_UNREADABLE, "schema")]);
  }
  if (text === null) {
    throw new ConfigError([error(CODE_MALFORMED, "schema")]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    throw new ConfigError([error(CODE_MALFORMED, "schema")]);
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

/** Whether a path is absolute, by the one rule both loaders implement.
 *
 * Python 3.13 changed `ntpath.isabs` so a rooted path with no drive, such as
 * `/fleet/config.json`, no longer counts. The loader states the rule itself so
 * the answer does not move with the interpreter: a path that begins with a
 * separator, or a drive with its root, is absolute; a drive-relative path such
 * as `D:state` is not.
 */
export function isAbsolutePath(value: string, platform: string = process.platform): boolean {
  if (!platform.startsWith("win")) {
    return posix.isAbsolute(value);
  }
  if (value.startsWith("\\") || value.startsWith("/")) {
    return true;
  }
  // The drive and root the Python loader reads, so both answer the same.
  const [drive, root] = splitRoot(value);
  return drive !== "" && root !== "";
}

/** Split a Windows path into drive, root, and tail, as CPython's `splitroot`. */
function splitRoot(value: string): [string, string, string] {
  const normp = value.replace(/\//g, "\\");
  if (normp.slice(0, 1) === "\\") {
    if (normp.slice(1, 2) === "\\") {
      // A UNC share or a device path: the drive runs through the share name.
      const start = normp.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\" ? 8 : 2;
      const index = normp.indexOf("\\", start);
      if (index === -1) {
        return [value, "", ""];
      }
      const index2 = normp.indexOf("\\", index + 1);
      if (index2 === -1) {
        return [value, "", ""];
      }
      return [value.slice(0, index2), value.slice(index2, index2 + 1),
              value.slice(index2 + 1)];
    }
    // Rooted with no drive, such as `\Windows`.
    return ["", value.slice(0, 1), value.slice(1)];
  }
  if (normp.slice(1, 2) === ":") {
    if (normp.slice(2, 3) === "\\") {
      // A drive with its root, such as `C:\Windows`.
      return [value.slice(0, 2), value.slice(2, 3), value.slice(3)];
    }
    // A drive-relative path, such as `C:Windows`.
    return [value.slice(0, 2), "", value.slice(2)];
  }
  return ["", "", value];
}

/** Fold a Windows path exactly as CPython's `ntpath.normpath` folds it. */
function ntpathNormpath(value: string): string {
  const path = value.replace(/\//g, "\\");
  const [drive, root, tail] = splitRoot(path);
  const prefix = drive + root;
  const parts = tail.split("\\");
  let index = 0;
  while (index < parts.length) {
    if (!parts[index] || parts[index] === ".") {
      parts.splice(index, 1);
    } else if (parts[index] === "..") {
      if (index > 0 && parts[index - 1] !== "..") {
        parts.splice(index - 1, 2);
        index -= 1;
      } else if (index === 0 && root) {
        parts.splice(index, 1);
      } else {
        index += 1;
      }
    } else {
      index += 1;
    }
  }
  if (!prefix && parts.length === 0) {
    parts.push(".");
  }
  return prefix + parts.join("\\");
}

/** Fold a path the way Python's own path module does, both loaders alike. */
export function normalizePath(value: string, platform: string = process.platform): string {
  const windows = platform.startsWith("win");
  if (windows) {
    // Python's Windows rules are ported rather than approximated: Node's own
    // normalizer folds some UNC and separator-only forms differently.
    return ntpathNormpath(value);
  }
  if (value === "//") {
    return "//";
  }
  let result = posix.normalize(value);
  // Python keeps exactly two leading separators, where Node folds them to one.
  if (/^\/\/(?!\/)/.test(value) && !result.startsWith("//")) {
    result = `/${result}`;
  }
  // Python drops a trailing separator unless the path is a root.
  while (result.length > 1 && result !== "//" && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

/** Join a Windows path exactly as CPython's `ntpath.join` joins it. */
function ntpathJoin(base: string, value: string): string {
  const sep = "\\";
  const seps = "\\/";
  const colonSeps = ":\\/";
  let [drive, root, path] = splitRoot(base);
  const [childDrive, childRoot, childPath] = splitRoot(value);
  if (childRoot) {
    // The second path is absolute: it replaces the first, keeping the drive
    // of the first only when it names none of its own.
    if (childDrive || !drive) {
      drive = childDrive;
    }
    root = childRoot;
    path = childPath;
  } else {
    if (childDrive && childDrive !== drive) {
      if (childDrive.toLowerCase() !== drive.toLowerCase()) {
        // A different drive: the first path is ignored entirely.
        return childDrive + childRoot + childPath;
      }
      drive = childDrive;
    }
    if (path && !seps.includes(path.slice(-1))) {
      path += sep;
    }
    path += childPath;
  }
  if (path && !root && drive && !colonSeps.includes(drive.slice(-1))) {
    return `${drive}${sep}${path}`;
  }
  return drive + root + path;
}

/** Join and fold a relative value, matching Python's path module on both. */
export function joinPath(base: string, value: string, platform: string = process.platform): string {
  if (!platform.startsWith("win")) {
    // posixpath.join: a rooted value replaces the base, one separator joins
    // otherwise. Node's own join folds the leading double separator away.
    if (value.startsWith("/") || base === "") {
      return normalizePath(value, platform);
    }
    const joined = base.endsWith("/") ? base + value : `${base}/${value}`;
    return normalizePath(joined, platform);
  }
  return ntpathNormpath(ntpathJoin(base, value));
}

/** Drop trailing separators, as pathlib does before it reads a selected file. */
function stripTrailingSeparators(value: string, platform: string = process.platform): string {
  const windows = platform.startsWith("win");
  const module = windows ? win32 : posix;
  const root = module.parse(value).root;
  // pathlib folds only the platform's own separator: off Windows a backslash
  // is a character in the name, and stripping it read a different file.
  const trailing = windows ? /[\\/]$/ : /\/$/;
  let result = value;
  while (result.length > root.length && trailing.test(result)) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Fold repeated separators the way GetFullPathName folds them, keeping the two
 * that make a UNC name a UNC name. `ntpath.normpath` leaves a doubled
 * separator inside a UNC name alone, and the native call folds it.
 */
function nativeSeparators(value: string): string {
  const lead = value.startsWith("\\\\") ? "\\\\" : "";
  return lead + value.slice(lead.length).replace(/[\\/]+/g, "\\");
}

/**
 * Drop the one `..` GetFullPathName drops from the end of a name, and only
 * from a name that does not end a separator with it. The installed Windows-only
 * abspath table pins both halves: `//server/..` answers `\\server\`, while
 * `//server/../` keeps the `..` it ends a separator after, and `//../../`
 * answers `\\..\..\`. Found by review, 2026-11-23.
 */
function dropTrailingParent(value: string): string {
  if (/[\\/]$/.test(value) || !value.endsWith("\\..")) {
    return value;
  }
  return value.slice(0, -3) + "\\";
}

/**
 * A Windows name made absolute as the platform makes it.
 *
 * Python's `abspath` is `_getfullpathname(normpath(path))` (ntpath.py). The
 * `normpath` half is ported above and checked against CPython's own answers;
 * the native half makes a relative name absolute, resolves a drive-relative
 * name from its own drive, folds a `..` above a share root the way the table
 * pins it, folds repeated separators, and drops trailing dots and spaces from
 * each component, as GetFullPathNameW does. Two of its behaviors are outside
 * what a pure model reproduces: a device name (`C:\nul` becomes `\\.\nul`) and
 * the 8.3 long-name expansion, which reads the filesystem. A drive's own
 * current directory is a third: the OS keeps it per drive, Windows also keeps
 * it in the environment block as `=C:`, and it is taken from there where it is
 * known and the drive root, that drive's default, otherwise.
 * docs/configuration.md names that boundary rather than claiming parity.
 */
function windowsAbspath(value: string, cwd: string,
                        driveCwd: Record<string, string> = {}): string {
  // The drive prefix is taken off before the name is folded: `D:..` is drive
  // D's current directory one level up, and trimming its trailing dots as if
  // they were a component's would turn the name into the bare drive. A prefix
  // and nothing after it is the drive's directory as written, which the fold
  // below would spell `D:.`. Found by review, 2026-11-24.
  const drivePrefix = /^[A-Za-z]:/.exec(value);
  const head = drivePrefix === null ? "" : drivePrefix[0];
  // Behind a drive prefix a run of separators names the drive's root, not a
  // share: `D:\\one` is `D:\one`, where feeding the run to the fold would read
  // its doubled backslashes as a UNC prefix and keep the `..` beneath them.
  // Only a name with no drive can open a share, and that one is left as
  // written. Found by review, 2026-11-24.
  const rest = head === ""
    ? value
    : value.slice(head.length).replace(/^[\\/]+/, "\\");
  // A name made only of parents keeps every one of them when a drive is what
  // it climbs from: the drive's directory is joined below, and dropping a
  // parent here would lose a level, so `D:..\..` from `D:\one\two` is `D:\`.
  // A rooted name has nothing joined beneath it and drops the one the system
  // drops, `\\..\..` becoming `\\..\`. The name is classified after it is
  // folded, so a dot component that normalizes away cannot hide a parents-only
  // name from the test. Found by review, 2026-11-24.
  const foldedRest = rest === ""
    ? ""
    : nativeSeparators(ntpathNormpath(trimTrailingDotsAndSpaces(ntpathNormpath(rest))));
  const parentsOnly = head !== "" && /^\.\.(?:\\\.\.)*\\?$/.test(foldedRest);
  const folded = rest === ""
    ? head
    : head + (parentsOnly ? foldedRest : dropTrailingParent(foldedRest));
  const [foldDrive, foldRoot] = splitRoot(folded);
  const [cwdDrive] = splitRoot(cwd);
  if (foldRoot && !foldDrive) {
    // A rooted name with no drive takes the current drive's root.
    return cwdDrive ? cwdDrive + folded : folded;
  }
  if (isAbsolutePath(folded, "win32")) {
    return folded;
  }
  if (foldDrive) {
    // A drive-relative name: `C:temp` is drive C's own current directory, not
    // the process's. Answered from the drive, it names one folder; answered as
    // written, its destination changes with the caller. A drive whose
    // directory the caller does not know falls back to its root, that drive's
    // default.
    const tail = folded.slice(foldDrive.length);
    const base = foldDrive.toLowerCase() === cwdDrive.toLowerCase()
      ? normalizePath(cwd, "win32")
      : driveCwd[foldDrive.toUpperCase()];
    const start = base !== undefined && isAbsolutePath(base, "win32")
      ? base
      : foldDrive + "\\";
    return tail === "" ? start : joinPath(start, tail, "win32");
  }
  return joinPath(cwd, folded, "win32");
}

/** Drop the trailing dots and spaces GetFullPathNameW drops from a name. */
function trimTrailingDotsAndSpaces(value: string): string {
  return value.split(/([\\/]+)/).map((part) =>
    part === "" || /[\\/]/.test(part) || part === "." || part === ".."
      ? part
      : part.replace(/[. ]+$/, "")
  ).join("");
}

/**
 * One temporary-directory candidate, absolutized as `gettempdir` absolutizes
 * it. The current directory spelled "." comes back as written, the one value
 * Python skips. On Windows the resolution is the system's own, so a rooted
 * name with no drive takes the current drive; a bare share root keeps the
 * spelling `ntpath.abspath` gives it, with no separator added.
 */
export function tempCandidatePath(value: string, platform: string = process.platform,
                                  cwd: string = process.cwd(),
                                  driveCwd: Record<string, string> = {}): string {
  if (value === ".") {
    return value;
  }
  if (platform.startsWith("win")) {
    // The resolution is the one `ntpath.abspath` gives, which the installed
    // Windows-only abspath tests pin for these shapes; docs/configuration.md
    // names what a pure model cannot reproduce. The process directory is a
    // parameter so a drive-qualified one can be named from a test that runs
    // where no drive exists, and each drive's own current directory is another:
    // the OS keeps it per drive and Windows also keeps it in the environment,
    // which the search reads (`driveCurrentDirectories`).
    return windowsAbspath(value, cwd, driveCwd);
  }
  return isAbsolutePath(value, platform)
    ? normalizePath(value, platform)
    : joinPath(cwd, value, platform);
}

/**
 * The platform temporary directory, found the way Python's `gettempdir` finds
 * it: each candidate in turn, absolutized first, and the first that is a
 * writable directory wins. Node's `os.tmpdir` stops at the first name in the
 * environment, even when that name points at nothing, so the two loaders would
 * resolve different folders.
 */
export type TempProbe = (directory: string) => boolean;

/**
 * How many names the probe tries before it calls a folder unusable.
 *
 * CPython's own count belongs to the interpreter: the default-tempdir probe
 * tries 100 names in 3.11 and 20 in 3.14, and no one number matches both. The
 * floor this repository supports is 3.11 and the Windows PC runs 3.14, so the
 * newer bound is used: the loader refuses after 20 names where 3.11 would try
 * 100, which can send it to another candidate on a 3.11 machine whose first 20
 * probe names are all taken; it never answers a folder the newer interpreter
 * would refuse, and it never leaves more probe files behind than 3.14 would.
 * Found by review, 2026-11-24.
 */
const TEMP_NAME_ATTEMPTS = 20;

function uniqueName(): string {
  return ".fleet-tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
}

/** The four bytes CPython writes into the file it makes, `b'blat'`. */
const PROBE_BYTES = "blat";

function existsAsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a refused name is one CPython would try again.
 *
 * On Windows a PermissionError with the folder still there is not a refusal:
 * a scanner or an indexer holding the file it just made is the usual cause,
 * and CPython moves to the next name. A share-mode refusal on the removal
 * reaches Node as EBUSY where CPython sees EACCES, so both count. Everywhere
 * else, and for any folder that is gone, the answer is final.
 */
function retryableOnWindows(caught: unknown, directory: string, platform: string,
                            isDirectory: (path: string) => boolean): boolean {
  const code = (caught as { code?: unknown }).code;
  if (!platform.startsWith("win")) {
    return false;
  }
  return (code === "EACCES" || code === "EPERM" || code === "EBUSY") && isDirectory(directory);
}

/**
 * Whether a file can be made in a folder, asked the way `gettempdir` asks.
 *
 * Python's temporary-directory search opens a file with a unique name, writes
 * four bytes into it, and removes it: a folder that passes an existence or
 * permission check but cannot accept a write (a full volume, an exhausted
 * quota, a write ACL) is not a temporary directory. A folder made and removed
 * is not the same proof, a probe that makes only a folder accepts one that
 * takes no file, and an empty file is accepted by a volume that holds nothing
 * else. Found by review, 2026-11-23 and 2026-11-24.
 */
export function canCreateInDirectory(directory: string,
                                     makeName: () => string = uniqueName,
                                     removeName: (name: string) => void = unlinkSync,
                                     platform: string = process.platform,
                                     isDirectory: (path: string) => boolean = existsAsDirectory): boolean {
  for (let attempt = 0; attempt < TEMP_NAME_ATTEMPTS; attempt += 1) {
    const name = join(directory, makeName());
    try {
      writeFileSync(name, PROBE_BYTES, { flag: "wx", mode: 0o600 });
    } catch (caught) {
      const code = (caught as { code?: unknown }).code;
      // A refused name is somebody else's file and is left alone; a write that
      // made the file and then failed has this probe's name to give back, as
      // CPython unlinks its file whatever the write did. Found by review,
      // 2026-11-24.
      if (code !== "EEXIST") {
        try {
          removeName(name);
        } catch {
          // Nothing to give back, and the refusal below is the answer.
        }
      }
      if (code === "EEXIST") {
        continue;
      }
      if (retryableOnWindows(caught, directory, platform, isDirectory)) {
        continue;
      }
      return false;
    }
    try {
      removeName(name);
    } catch (caught) {
      // Python rejects a folder whose file it cannot remove, and this answer
      // is about the same question: a folder that takes a file and will not
      // give it back is not a temporary directory. On Windows the refusal is
      // retried under another name while the folder stands, as Python does.
      // Found by review, 2026-11-23 and 2026-11-24.
      if (retryableOnWindows(caught, directory, platform, isDirectory)) {
        continue;
      }
      return false;
    }
    return true;
  }
  // Every name tried was taken: CPython reports no usable temporary directory
  // rather than calling the folder good, and so does this.
  return false;
}

/**
 * Each drive's own current directory, as Windows keeps it.
 *
 * The OS holds a process's per-drive directories in the environment block as
 * `=C:=C:\some\dir` entries. Node marks those entries non-enumerable, so a scan
 * of the keys does not see them at all; each drive's name is asked for
 * directly, which the same store answers. A key of that shape names a drive;
 * an empty value, which an unset drive can carry, names no directory. On a
 * system that has no such entries the map is empty, and a drive-relative name
 * then resolves from the drive root as the system resolves it.
 * Found by review, 2026-11-24.
 */
export function driveCurrentDirectories(platform: string = process.platform,
                                        environ: Record<string, string | undefined> = process.env
                                        ): Record<string, string> {
  const found: Record<string, string> = {};
  if (!platform.startsWith("win")) {
    return found;
  }
  for (let letter = "A".charCodeAt(0); letter <= "Z".charCodeAt(0); letter += 1) {
    const drive = String.fromCharCode(letter) + ":";
    // Windows answers either spelling, so a record handed to this helper is
    // asked under both: a lower-case key is a directory, not a miss.
    const upper = environ["=" + drive];
    const lower = environ["=" + drive.toLowerCase()];
    const value = typeof upper === "string" && upper !== "" ? upper : lower;
    if (typeof value === "string" && value !== "") {
      found[drive] = value;
    }
  }
  return found;
}

export function systemTempDirectory(platform: string = process.platform,
                                    probe: TempProbe = canCreateInDirectory,
                                    driveCwds: Record<string, string> =
                                      driveCurrentDirectories(platform)): string {
  const candidates: string[] = [];
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value) {
      candidates.push(value);
    }
  }
  if (platform.startsWith("win")) {
    // Python's own Windows list: the user's temp folder, the system temp
    // folder, then these four, so a machine with none of its variables set
    // still gets one. `~\AppData\Local\Temp` and `%SYSTEMROOT%\Temp` are
    // expanded before they are tried; a machine whose home cannot be found
    // keeps the literal spelling, which then fails the test and is skipped,
    // as Python's unexpanded name would.
    let appData = "~\\AppData\\Local\\Temp";
    try {
      appData = join(homedir(), "AppData", "Local", "Temp");
    } catch (caught) {
      appData = "~\\AppData\\Local\\Temp";
    }
    candidates.push(appData);
    const systemRoot = process.env["SYSTEMROOT"] || process.env["SystemRoot"];
    if (systemRoot) {
      candidates.push(join(systemRoot, "Temp"));
    }
    candidates.push("C:\\temp", "C:\\tmp", "\\temp", "\\tmp");
  } else {
    candidates.push("/tmp", "/var/tmp", "/usr/tmp");
  }
  candidates.push(process.cwd());
  const runningHere = platform === process.platform;
  for (const candidate of candidates) {
    // A drive-relative name is resolved from its drive's own current
    // directory, which the map above holds where Windows keeps it and which is
    // the drive root otherwise, the directory the system resolves the name
    // from. The candidate is never skipped: Python probes the folder the name
    // resolves to, and so does this search. Found by review, 2026-11-24.
    try {
      const absolute = tempCandidatePath(candidate, platform, process.cwd(), driveCwds);
      // The filesystem this code runs on decides what exists. A platform named
      // for a test only selects the candidate list and the spelling returned,
      // so the one path a test can reach is probed as the running system
      // spells it. The probe is a parameter so a folder that cannot take a
      // file can be produced where no full disk exists.
      const target = runningHere ? absolute : candidate;
      if (!probe(target)) {
        continue;
      }
      return absolute;
    } catch (caught) {
      continue;
    }
  }
  throw new Error("no usable temporary directory");
}

function hasOwn(target: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Write a key the document named as an own property.
 *
 * Plain assignment to `__proto__` sets the prototype instead of a property, so
 * a priced model by that name would vanish from the result while the Python
 * loader kept it. A key the document wrote is always kept.
 */
function putOwn(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

function keyForbidden(value: string, schema: Schema): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    for (const [start, end] of schema.keyForbiddenRanges) {
      if (code >= start && code <= end) {
        return true;
      }
    }
  }
  return false;
}

/** Whether a path is a regular file, so reading it cannot block or fail. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (caught) {
    return false;
  }
}

function environmentOf(
  environ: Record<string, string> | undefined,
  schema: Schema,
): Record<string, string> {
  const source = environ === undefined ? process.env : environ;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  for (const [name, alias] of Object.entries(schema.environment.aliases ?? {})) {
    if (!result[name] && result[alias]) {
      result[name] = result[alias];
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
  if (isAbsolutePath(expanded.text)) {
    return { path: normalizePath(expanded.text), code: null };
  }
  if (configDirectory === null) {
    return { path: null, code: CODE_VALUE };
  }
  return { path: joinPath(configDirectory, expanded.text), code: null };
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
        return { value: systemTempDirectory(), code: null };
      }
      if (record.resolvedBy === "underStateDir") {
        if (context.stateDir === null) {
          return { value: SKIP, code: null };
        }
        return { value: joinPath(context.stateDir, record.relative as string), code: null };
      }
      return { value: null, code: CODE_VALUE };
    }
  }
  return { value: fallback === undefined ? null : fallback, code: null };
}

/**
 * Whether a default is a path this loader already computed for the machine.
 *
 * Such a value is environment data, not document text: expanding it a second
 * time would read a `$` inside a profile path as the start of a variable and
 * refuse the default the schema declares.
 */
function isCarriedDefault(field: Field): boolean {
  const fallback = field.default;
  return field.type === "path" && fallback !== null && fallback !== undefined
    && typeof fallback === "object" && !Array.isArray(fallback)
    && "resolvedBy" in (fallback as JsonObject);
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
    if (typeof value !== "number") {
      errors.push(error(CODE_TYPE, path));
      return INVALID;
    }
    // A value the parser could not carry exactly, or one no JSON number may
    // hold, is refused rather than rounded: the literal's last digits were
    // already lost when it was parsed. The bound is declared once, in the
    // schema, and the Python loader refuses the same value at the same path.
    if (!Number.isFinite(value)) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    if (!Number.isInteger(value)) {
      errors.push(error(CODE_TYPE, path));
      return INVALID;
    }
    if (Math.abs(value) > context.schema.numberLimits.safeInteger) {
      errors.push(error(CODE_VALUE, path));
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
    if (!Number.isFinite(value)) {
      errors.push(error(CODE_VALUE, path));
      return INVALID;
    }
    if (Number.isInteger(value)
        && Math.abs(value) > context.schema.numberLimits.safeInteger) {
      errors.push(error(CODE_VALUE, path));
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
    // One keystroke: a character the schema refuses cannot be bound, and the
    // same ranges apply in both loaders so neither accepts a binding the
    // other drops.
    if (!value || keyForbidden(value, context.schema)) {
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
    if (field.expandHome && (value === "~" || value.startsWith("~/")
        || (process.platform === "win32" && value.startsWith("~\\")))) {
      value = "$HOME" + value.slice(1);
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
      putOwn(resolved, key, checked);
    }
  }
  const fallback = field.default;
  if (fallback !== null && typeof fallback === "object" && !Array.isArray(fallback)) {
    for (const [key, item] of Object.entries(fallback as JsonObject)) {
      if (!hasOwn(resolved, key)) {
        putOwn(resolved, key, item);
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
  const shipped = hasOwn(fallback, key) ? fallback[key] : undefined;
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
  // A key the document carries but that failed its check is still the author
  // saying something, so it is present, not absent: reporting it required as
  // well would name two defects for one line.
  const present = new Set(Object.keys(value as JsonObject));
  for (const [key, item] of Object.entries(value as JsonObject)) {
    const keyPath = `${path}.${key}`;
    const entry = declared.get(key);
    if (entry === undefined) {
      errors.push(error(CODE_UNKNOWN_KEY, keyPath));
      continue;
    }
    const checked = scalar(entry, item, context, keyPath, errors);
    if (checked !== INVALID) {
      putOwn(resolved, key, checked);
    }
  }
  for (const [name, entry] of declared) {
    if (hasOwn(resolved, name) || present.has(name)) {
      continue;
    }
    if (entry.default !== undefined) {
      putOwn(resolved, name, entry.default);
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
  const present = new Set(Object.keys(value as JsonObject));
  for (const [key, item] of Object.entries(value as JsonObject)) {
    const keyPath = `${path}.${key}`;
    if (field.keyValues !== undefined && !field.keyValues.includes(key)) {
      errors.push(error(CODE_UNKNOWN_KEY, keyPath));
      continue;
    }
    if (field.recordFields !== undefined) {
      putOwn(resolved, key, recordField(field.recordFields, inherited(fallback, key, item),
                                        context, keyPath, errors));
      continue;
    }
    if (field.valueFields !== undefined) {
      const entry = declared.get(key);
      if (entry === undefined) {
        continue;
      }
      const checked = scalar(entry, item, context, keyPath, errors);
      if (checked !== INVALID) {
        putOwn(resolved, key, checked);
      }
      continue;
    }
    const inner: Field = { type: field.valueType as string };
    if (field.valueType === "stringArray" || field.valueType === "pathArray") {
      const checked = arrayValue(inner, item, context, keyPath, errors);
      if (checked !== INVALID) {
        putOwn(resolved, key, checked);
      }
    } else {
      const checked = scalar(inner, item, context, keyPath, errors);
      if (checked !== INVALID) {
        putOwn(resolved, key, checked);
      }
    }
  }
  for (const key of field.keyValues || []) {
    // A key the document carries but that failed its check is present, not
    // absent; reporting it required as well names two defects for one line.
    if (hasOwn(resolved, key) || present.has(key)) {
      continue;
    }
    const keyPath = `${path}.${key}`;
    if (hasOwn(fallback, key)) {
      putOwn(resolved, key, fallback[key]);
      continue;
    }
    if (field.recordFields !== undefined) {
      putOwn(resolved, key, recordField(field.recordFields, {}, context, keyPath, errors));
      continue;
    }
    if (field.valueFields !== undefined && declared.has(key)) {
      const entry = declared.get(key) as Field;
      if (entry.default !== undefined) {
        putOwn(resolved, key, entry.default);
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
      if (!hasOwn(record, name)) {
        putOwn(resolved, name, field.default === undefined ? null : field.default);
        if (field.required) {
          errors.push(error(CODE_REQUIRED, keyPath));
        }
        continue;
      }
      const single = scalar(field, record[name], context, keyPath, errors);
      if (single !== INVALID) {
        putOwn(resolved, name, single);
      }
    }
    for (const [name, field] of declared) {
      if (field.requiredWhenEnabled && !hasOwn(record, name) && resolved.enabled === true) {
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
        || !hasOwn(current as JsonObject, part)) {
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
    if (key.includes(".")) {
      // A key that spells a path is not a nested object. The document looks
      // like it sets a declared field, resolves to nothing, and would leave
      // the setting silently unapplied.
      errors.push(error(CODE_UNKNOWN_KEY, path));
      continue;
    }
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

function applyRules(schema: Schema, flat: Record<string, JsonValue>, document: JsonObject,
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
      const order = lookup(document, rule.field as string);
      const declaredOrder = order.present ? order.value : flat[rule.field as string];
      const prefix = rule.prefix as string;
      if (Array.isArray(declaredOrder)) {
        for (const [index, item] of declaredOrder.entries()) {
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
    if (expanded.text === null || !isAbsolutePath(expanded.text)) {
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
      // The first default place that holds a document, read as the Python
      // loader reads it: a device or a FIFO is not a document, and the place
      // after it is what a load there would find. Selecting one here refused a
      // file Python never even looked at. Found by review, 2026-11-23.
      if (expanded.text && isRegularFile(expanded.text)) {
        selected = expanded.text;
      }
      break;
    }
  }
  if (selected === null) {
    return { directory: null, document: {} };
  }
  // Python's pathlib drops trailing separators before it stats a selected
  // file, so a selector ending in one still names that file. The stat, the
  // kind check, and the read all use the same stripped path.
  const target = stripTrailingSeparators(selected);
  const kind = filesystemProbe(target);
  if (kind === "missing") {
    errors.push(error(CODE_FILE_NOT_FOUND, `$${selector}`));
    return { directory: null, document: {} };
  }
  if (kind !== "file" || !isRegularFile(target)) {
    // A device or a FIFO can exist under a path that is not a directory and
    // still is not a document; reading it can block or answer nothing. The
    // Python loader refuses both, and a load must read the same in either.
    errors.push(error(CODE_FILE_NOT_REGULAR, `$${selector}`));
    return { directory: null, document: {} };
  }
  let text: string;
  try {
    const decoded = decodeUtf8(readFileSync(target));
    if (decoded === null) {
      errors.push(error(CODE_MALFORMED, ROOT_PATH, "bytes"));
      return { directory: null, document: {} };
    }
    text = decoded;
  } catch (caught) {
    errors.push(error(CODE_UNREADABLE, `$${selector}`));
    return { directory: null, document: {} };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (caught) {
    errors.push(error(CODE_MALFORMED, ROOT_PATH, "json"));
    return { directory: null, document: {} };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    errors.push(error(CODE_ROOT_TYPE, ROOT_PATH));
    return { directory: null, document: {} };
  }
  return { directory: dirname(resolvePath(target)), document: document as JsonObject };
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
  const environ = environmentOf(options.environ, schema);
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
      if (isCarriedDefault(field)) {
        // Already resolved from the machine; expanding it again would read a
        // `$` in an environment value as a variable.
        flat[path] = fallback.value;
        if (path === "stateDir" && typeof fallback.value === "string") {
          context.stateDir = fallback.value;
        }
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
  applyRules(schema, flat, located.document, errors);
  if (errors.length) {
    throw new ConfigError(errors);
  }
  const resolved = assemble(schema, flat, probe, platform, errors);
  if (errors.length) {
    throw new ConfigError(errors);
  }
  return resolved;
}
