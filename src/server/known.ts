import type { CustomTarget } from '../types.js';

/** Identifying values the caller already holds for the candidate. */
export interface KnownValues {
  emails: string[];
  phones: string[];
  urls: string[];
  names: string[];
}

const MAX_VALUES_PER_KIND = 20;
const MAX_VALUE_LENGTH = 300;

/** Shortest slug suffix, dash included, worth matching on its own. */
const MIN_SUFFIX_LENGTH = 6;
/** A one-word slug shorter than this, with no digit or underscore, could be a name. */
const MIN_PLAIN_SLUG_LENGTH = 8;
const MIN_SLUG_LENGTH = 5;
const MIN_PHONE_DIGITS = 8;
/** A name word shorter than this is only matched as part of the full name. */
const MIN_NAME_WORD_LENGTH = 4;
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'shri', 'smt']);

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class KnownValuesError extends Error {}

/** Parses the `known` form field. An absent field means nothing is known. */
export function parseKnown(raw: string | null): KnownValues {
  const known: KnownValues = { emails: [], phones: [], urls: [], names: [] };
  if (raw === null || raw.trim() === '') return known;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KnownValuesError('known is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KnownValuesError('known must be a JSON object');
  }

  for (const kind of ['emails', 'phones', 'urls', 'names'] as const) {
    const values = (parsed as Record<string, unknown>)[kind];
    if (values === undefined || values === null) continue;
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) {
      throw new KnownValuesError(`known.${kind} must be an array of strings`);
    }
    if (values.length > MAX_VALUES_PER_KIND) {
      throw new KnownValuesError(`known.${kind} has more than ${MAX_VALUES_PER_KIND} entries`);
    }
    for (const value of values as string[]) {
      if (value.length > MAX_VALUE_LENGTH) {
        throw new KnownValuesError(`a known.${kind} entry is longer than ${MAX_VALUE_LENGTH} characters`);
      }
      const trimmed = value.trim();
      // A placeholder like "na" or "-" would otherwise become a pattern that wipes
      // ordinary text, so anything that cannot be the value it claims is dropped.
      if (isUsable(kind, trimmed)) known[kind].push(trimmed);
    }
  }
  return known;
}

function isUsable(kind: keyof KnownValues, value: string): boolean {
  if (kind === 'emails') return VALID_EMAIL.test(value);
  if (kind === 'phones') return value.replace(/\D/g, '').length >= MIN_PHONE_DIGITS;
  if (kind === 'names') return nameWords(value).some((word) => word.length >= 2);
  return urlCore(value).includes('.');
}

/**
 * Exact-match targets for the contact values the caller already knows. The
 * built-in patterns find the usual shapes; these catch what they miss, chiefly a
 * profile URL that wrapped onto a second line and left half its slug readable.
 * The descriptions never carry the values, because they are shown to the model.
 */
export function buildKnownTargets(known: KnownValues): CustomTarget[] {
  const targets: CustomTarget[] = [];

  const emails = known.emails.map((email) => new RegExp(escapeRegExp(email), 'gi'));
  if (emails.length > 0) {
    targets.push({
      id: 'known_email',
      description: 'An email address the platform already holds for this candidate.',
      patterns: emails,
    });
  }

  const phones = known.phones.flatMap(phonePattern);
  if (phones.length > 0) {
    targets.push({
      id: 'known_phone',
      description: 'A phone number the platform already holds for this candidate.',
      patterns: phones,
    });
  }

  const urls = known.urls.flatMap(urlPatterns);
  if (urls.length > 0) {
    targets.push({
      id: 'known_url',
      description: 'A profile or site URL the platform already holds for this candidate.',
      patterns: urls,
    });
  }

  const names = known.names.flatMap(namePatterns);
  if (names.length > 0) {
    targets.push({
      id: 'known_name',
      description: "The candidate's own name as the platform holds it.",
      patterns: names,
    });
  }
  return targets;
}

/** The words of a name, without punctuation or a leading title such as "Dr.". */
function nameWords(name: string): string[] {
  return name
    .split(/[\s.,]+/)
    .map((word) => word.replace(/[^\p{L}'-]/gu, ''))
    .filter((word) => word.length > 0 && !HONORIFICS.has(word.toLowerCase()));
}

/**
 * The full name in either order, in any case, and each of its longer words
 * when written as a name: capitalised or in capitals. A lowercase "mark" or a
 * three-letter "Dev" on its own is left alone, because those are ordinary
 * words far more often than they are the candidate.
 */
function namePatterns(name: string): RegExp[] {
  const words = nameWords(name);
  if (words.length === 0) return [];
  const patterns: RegExp[] = [];
  const before = '(?<![\\p{L}])';
  const after = '(?![\\p{L}])';
  const gap = '[\\s.,]+';

  if (words.length > 1) {
    patterns.push(new RegExp(before + words.map(escapeRegExp).join(gap) + after, 'giu'));
    const first = escapeRegExp(words[0]!);
    const last = escapeRegExp(words[words.length - 1]!);
    patterns.push(new RegExp(before + last + gap + first + after, 'giu'));
  }
  for (const word of words) {
    if ([...word].length < MIN_NAME_WORD_LENGTH) continue;
    const lower = word.toLowerCase();
    const capitalised = lower.charAt(0).toUpperCase() + lower.slice(1);
    patterns.push(new RegExp(`${before}(?:${escapeRegExp(capitalised)}|${escapeRegExp(word.toUpperCase())})${after}`, 'gu'));
  }
  return patterns;
}

/**
 * The national digits with optional spaces or dashes between each, behind an
 * optional +91, so "+91 98765 43210", "98765-43210" and "9876543210" all match
 * one stored value.
 */
function phonePattern(phone: string): RegExp[] {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length < MIN_PHONE_DIGITS) return [];

  const body = digits.split('').join('[\\s-]?');
  return [new RegExp(`(?<!\\d)(?:\\+?91[\\s-]?|0)?${body}(?!\\d)`, 'g')];
}

/**
 * The URL itself with or without scheme and www, and for a LinkedIn or GitHub
 * profile, the pieces of its slug that a line wrap can leave stranded.
 *
 * A wrap splits "yash-singh-gour" either before a dash, leaving "-singh-gour",
 * or after one, leaving "singh-gour" at the start of the next line. Both are
 * matched. The rules keep these from matching the name itself, which has its
 * own target, so a slug piece never blanks an unrelated word:
 *
 * - A tail with a leading dash matches anywhere, but not straight after a
 *   letter, so "-jones" never matches inside "Smith-Jones".
 * - A tail without a leading dash must still contain a dash, and must start
 *   its line, so "smith-jones" never matches "Mary Smith-Jones".
 * - The whole slug matches after a "/" ("in/jean-pierre"), or anywhere when it
 *   has a digit. On its own it can be a hyphenated first name.
 * - A one-word slug ("xploy04") matches as a whole word only when it has a
 *   digit or underscore, or is at least eight characters. A shorter plain one
 *   like "priya" is too likely to be the name itself.
 *
 * Tails shorter than six characters, dash included, are skipped.
 */
function urlPatterns(url: string): RegExp[] {
  const core = urlCore(url);
  if (core.length < 4) return [];

  // Not followed by more path, so the profile URL does not match its own repositories.
  const patterns = [new RegExp(`(?:https?://)?(?:www\\.)?${escapeRegExp(core)}/?(?![\\w./-])`, 'gi')];

  const slug = profileSlug(core);
  if (!slug) return patterns;

  const parts = slug.split('-').filter(Boolean);
  const hasDigit = (piece: string) => /\d/.test(piece);

  if (parts.length === 1) {
    if (slug.length >= MIN_SLUG_LENGTH && (/[\d_]/.test(slug) || slug.length >= MIN_PLAIN_SLUG_LENGTH)) {
      patterns.push(new RegExp(`(?<![a-z0-9_])${escapeRegExp(slug)}(?![a-z0-9_])`, 'gi'));
    }
    return patterns;
  }

  const whole = parts.join('-');
  patterns.push(
    hasDigit(whole)
      ? new RegExp(`(?<![a-z0-9])${escapeRegExp(whole)}(?![a-z0-9])`, 'gi')
      : new RegExp(`(?<=/)${escapeRegExp(whole)}(?![a-z0-9])`, 'gi'),
  );

  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(i).join('-');
    if (tail.length + 1 >= MIN_SUFFIX_LENGTH) {
      patterns.push(new RegExp(`(?<![a-z0-9])-${escapeRegExp(tail)}(?![a-z0-9])`, 'gi'));
    }
    if (!tail.includes('-')) continue;
    patterns.push(
      hasDigit(tail)
        ? new RegExp(`(?<![a-z0-9])${escapeRegExp(tail)}(?![a-z0-9])`, 'gi')
        : new RegExp(`(?<=^[^a-z0-9]*)${escapeRegExp(tail)}(?![a-z0-9])`, 'gi'),
    );
  }
  return patterns;
}

function urlCore(url: string): string {
  return url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[?#]/)[0]!
    .replace(/\/+$/, '');
}

function profileSlug(core: string): string | null {
  const [host, ...path] = core.toLowerCase().split('/');
  if (!host) return null;
  if (/(^|\.)linkedin\.com$/.test(host) && (path[0] === 'in' || path[0] === 'pub')) {
    return path[1] || null;
  }
  if (/(^|\.)github\.com$/.test(host)) return path[0] || null;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}
