/**
 * Masking: the pane must not print what it was never meant to show.
 *
 * A session name, a branch name and a question are all written by whoever ran the
 * session, and any of them can carry a merchant identifier, a location, a
 * sign-in, or key material. The pane is a display surface, so it masks before it
 * renders rather than hoping the text is clean.
 *
 * The rules are the shapes that identify an account or a credential. They are
 * deliberately narrow: a masker that eats ordinary words makes itself useless, so
 * every rule has a case in the suite proving it leaves normal text alone.
 *
 * This module is the masker the secret-shield mod will own. It lives here for now
 * because the pane needs it before that mod is extracted; the mod keeps its own
 * policy and thresholds, and this one only has to be honest about what it hides.
 */

export const MASK = "[masked]";

export type Masked = {
  text: string;
  /** Which rules fired, in the order they are declared. */
  rules: string[];
};

type Rule = {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
};

/** A merchant, a location, or the organization they belong to. */
const IDENTIFIERS: Rule[] = [
  { name: "organization", pattern: /\borg_[A-Za-z0-9]+\b/gi, replacement: MASK },
  { name: "location", pattern: /\bloc_[A-Za-z0-9]+\b/gi, replacement: MASK },
  { name: "merchant identifier", pattern: /\bMID\b[\s:=#-]*\d{4,}/g, replacement: MASK },
  { name: "account number", pattern: /\b(?:account|acct|card|pan)\b[\s:=#-]*\d{6,}/gi,
    replacement: MASK },
];

/**
 * A sign-in or key material.
 *
 * The separator is required for the word forms, because "the key is here" is a
 * sentence and "key: abc" is a credential. The one form without a separator is a
 * value that carries a digit, which prose almost never does, so "login failed"
 * survives and "login y1avJp1mg" does not.
 */
const CREDENTIALS: Rule[] = [
  { name: "sign-in", pattern: /\b(?:login|username|password|passwd|pwd|passcode)\b\s*[:=]\s*\S+/gi,
    replacement: MASK },
  // The value is captured on its own so a closing bracket, which is not part of
  // the sign-in, survives the mask.
  { name: "sign-in", pattern: /\b((?:login|password|passwd|pwd)\s+)(?=\S*\d)([A-Za-z0-9._@+-]{6,})/gi,
    replacement: (_match, lead) => lead + MASK },
  // The value must look like material: one unbroken run of eight or more, with a
  // digit or a symbol in it. A colon after a word is not proof, so "high secret:
  // looks like a key" keeps its sentence and "token: abc123def456" does not.
  { name: "key material",
    pattern: /\b(?:token|secret|api[_-]?key|access[_-]?key|secure[_-]?key|key)\b\s*[:=]\s*(\S+)/gi,
    replacement: (match, value) => looksLikeMaterial(value) ? MASK : match },
  { name: "key prefix", pattern: /\bsk-(?:proj-|ant-|live_)[A-Za-z0-9_-]{8,}/g, replacement: MASK },
  { name: "github token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}/g, replacement: MASK },
  { name: "aws key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: MASK },
  { name: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: MASK },
  { name: "credentialed url", pattern: /:\/\/[^\s/:]+:[^\s/@]+@/g,
    replacement: (match, ...groups) => "://" + MASK + "@" },
];

/** Whether a value is a key rather than a word that followed a colon. */
function looksLikeMaterial(value: string): boolean {
  if (!/^[A-Za-z0-9+/_=.-]{8,}$/.test(value)) {
    return false;
  }
  return /\d/.test(value) || /[+/_=-]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value));
}

function applyRule(text: string, rule: Rule): string {
  if (typeof rule.replacement === "string") {
    return text.replace(rule.pattern, rule.replacement);
  }
  const replacement = rule.replacement;
  return text.replace(rule.pattern,
                      (match: string, ...groups: string[]) => replacement(match, ...groups));
}

/**
 * The text with every identifying shape replaced.
 *
 * `rules` names what fired rather than counting, so a caller can say what was
 * hidden without repeating it.
 */
export function mask(value: unknown): Masked {
  if (typeof value !== "string" || !value) {
    return { text: "", rules: [] };
  }
  let text = value;
  const rules: string[] = [];
  for (const rule of [...IDENTIFIERS, ...CREDENTIALS]) {
    const before = text;
    text = applyRule(text, rule);
    if (text !== before && !rules.includes(rule.name)) {
      rules.push(rule.name);
    }
  }
  return { text, rules };
}

/** Whether the text holds anything this masker would hide. */
export function hides(value: unknown): boolean {
  return mask(value).rules.length > 0;
}
