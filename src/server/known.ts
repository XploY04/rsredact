import type { CustomTarget } from '../types.js';

/** Contact values the caller already holds for the candidate. */
export interface KnownValues {
  emails: string[];
  phones: string[];
  urls: string[];
}

const MAX_VALUES_PER_KIND = 20;
const MAX_VALUE_LENGTH = 300;

/** Shortest slug suffix, dash included, worth matching on its own. */
const MIN_SUFFIX_LENGTH = 6;

export class KnownValuesError extends Error {}

/** Parses the `known` form field. An absent field means nothing is known. */
export function parseKnown(raw: string | null): KnownValues {
  const known: KnownValues = { emails: [], phones: [], urls: [] };
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

  for (const kind of ['emails', 'phones', 'urls'] as const) {
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
      if (trimmed) known[kind].push(trimmed);
    }
  }
  return known;
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
  return targets;
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
  if (digits.length < 7) return [];

  const body = digits.split('').join('[\\s-]?');
  return [new RegExp(`(?<!\\d)(?:\\+?91[\\s-]?|0)?${body}(?!\\d)`, 'g')];
}

/**
 * The URL itself with or without scheme and www, and for a LinkedIn or GitHub
 * profile, the pieces of its slug that a line wrap can leave stranded. Every
 * slug pattern contains a dash, so the candidate's name written with a space
 * ("Singh Gour") never matches.
 */
function urlPatterns(url: string): RegExp[] {
  const core = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[?#]/)[0]!
    .replace(/\/+$/, '');
  if (core.length < 4) return [];

  const patterns = [new RegExp(`(?:https?://)?(?:www\\.)?${escapeRegExp(core)}`, 'gi')];

  const slug = profileSlug(core);
  if (slug) {
    const parts = slug.split('-').filter(Boolean);
    const pieces = new Set<string>();
    if (parts.length > 1) pieces.add(parts.join('-'));
    for (let i = 1; i < parts.length; i++) {
      const suffix = `-${parts.slice(i).join('-')}`;
      if (suffix.length >= MIN_SUFFIX_LENGTH) pieces.add(suffix);
    }
    for (const piece of pieces) {
      patterns.push(new RegExp(`(?<![a-z0-9])${escapeRegExp(piece)}(?![a-z0-9])`, 'gi'));
    }
  }
  return patterns;
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
