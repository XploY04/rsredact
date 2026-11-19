/**
 * Postal addresses, found by their shape. An Indian address is a run of short
 * comma-separated parts that carry a door number ("No. 42", "#12", "Flat 302"),
 * a numbered cross or main ("3rd Cross", "5th Main"), or a street or area word
 * ("HSR Layout", "MG Road", "Indiranagar"), and it usually ends in a six-digit
 * PIN. A city, state or country is none of these, so "Bengaluru, India" stays.
 */

export interface Neighbours {
  previous?: string;
  next?: string;
}

const NUMBERED = ['Cross', 'Main', 'Road', 'Street', 'Lane', 'Layout', 'Block', 'Stage', 'Phase', 'Sector', 'Floor', 'Avenue'];
const AREA = [
  'Cross', 'Main', 'Road', 'Rd', 'Street', 'St', 'Lane', 'Layout', 'Nagar', 'Colony', 'Block', 'Stage',
  'Phase', 'Sector', 'Apartment', 'Apartments', 'Apts', 'Residency', 'Enclave', 'Tower', 'Towers',
  'Society', 'Marg', 'Extension', 'Avenue',
];

// The number must end its part, as in "#12, 4th Cross", so "Ranked #1 in" is not a door.
const DOOR = String.raw`(?:(?:#|\b(?:No|Door\s?No|H\.?\s?No|House\s?No|Flat(?:\s?No)?|Plot(?:\s?No)?|Site\s?No|Shop\s?No)\b\.?)\s?[:#-]?\s?\d[\dA-Za-z/-]*(?=\s*,|\s*$))`;
const NUMBERED_STREET = String.raw`\b\d{1,3}(?:st|nd|rd|th|ST|ND|RD|TH)\s?(?:[A-Z]\s)?(?:${NUMBERED.map((w) => `[${w.charAt(0)}${w.charAt(0).toLowerCase()}]${w.slice(1)}|${w.toUpperCase()}`).join('|')})\b`;
// Capitalised only: a lowercase "main" or "block" in a sentence is not a place.
const AREA_WORD = String.raw`\b(?:${AREA.map((w) => `${w}|${w.toUpperCase()}`).join('|')})\b|\b[A-Z][a-z]+nagar\b`;
const MARKER = `(?:${DOOR}|${NUMBERED_STREET}|${AREA_WORD})`;

/** The first part may not start before a ":", so a label like "Address:" stays. */
const FIRST_PART = `[^,;|•:\\n]{0,60}?${MARKER}[^,;|•\\n]{0,60}`;
const PART = `[^,;|•\\n]{0,60}?${MARKER}[^,;|•\\n]{0,60}`;
/** One unmarked part, such as a building name, is allowed between two marked ones. */
const GAP = `[^,;|•\\n]{1,40},`;

const STREET_RUN = new RegExp(`${FIRST_PART}(?:,(?:${GAP})?${PART})*`, 'g');
const PIN = /(?<![\d+])[1-9]\d{2}\s?\d{3}(?!\d)/g;
/** A line that is nothing but one to three capitalised words, such as "Whitefield". */
const LOCALITY_LINE = /^[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,2},?$/g;

export const ADDRESS_PATTERNS: RegExp[] = [STREET_RUN, PIN, LOCALITY_LINE];

/** A part of a real address is short; a part with more words is a sentence. */
const MAX_PART_WORDS = 6;
const PIN_LABEL = /\b(?:pin\s?code|pincode|pin|postal\s?code|zip\s?code|zip)\s*[:.\-–]?\s*$/i;
const PLACE_BEFORE_PIN = /([A-Z][A-Za-z.]{2,})\s*[,\-–]?\s*$/;
const AFTER_PIN = /^(?:\s*\.?\s*$|\s*[,;|•)\-–]|\s+[A-Z])/;
/** Capitalised words that put a six-digit figure in money, not in a PIN. */
const NOT_PLACES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'RS', 'CTC', 'LPA']);

/**
 * Vetoes an address pattern match that is not part of an address. A street
 * run needs two markers with a door or numbered one, or a PIN on its line, or
 * an address line next to it. A PIN needs a label or a place name before it.
 * A bare locality line counts only between two lines of the same address.
 */
export function addressGuard(match: string, line: string, index: number, neighbours: Neighbours): boolean {
  if (/^\d{3}\s?\d{3}$/.test(match)) return pinInContext(line, index, match.length);
  if (markerCount(match) === 0) return isBetweenAddressLines(neighbours);
  if (match.split(',').some((part) => part.trim().split(/\s+/).length > MAX_PART_WORDS)) return false;
  if (isStrongRun(match) || hasPin(line)) return true;
  return isAddressLine(neighbours.previous) || isAddressLine(neighbours.next);
}

function markerCount(text: string): number {
  return text.match(new RegExp(MARKER, 'g'))?.length ?? 0;
}

function isStrongRun(run: string): boolean {
  return markerCount(run) >= 2 && new RegExp(`${DOOR}|${NUMBERED_STREET}`).test(run);
}

function pinInContext(line: string, index: number, length: number): boolean {
  if (!AFTER_PIN.test(line.slice(index + length))) return false;
  const before = line.slice(0, index);
  if (PIN_LABEL.test(before)) return true;
  const place = PLACE_BEFORE_PIN.exec(before);
  return place !== null && !NOT_PLACES.has(place[1]!.replace(/\.$/, '').toUpperCase());
}

function hasPin(text: string): boolean {
  for (const match of text.matchAll(new RegExp(PIN.source, 'g'))) {
    if (pinInContext(text, match.index ?? 0, match[0].length)) return true;
  }
  return false;
}

function isAddressLine(text: string | undefined): boolean {
  if (text === undefined) return false;
  if (hasPin(text)) return true;
  return [...text.matchAll(new RegExp(STREET_RUN.source, 'g'))].some((match) => isStrongRun(match[0]));
}

function isBetweenAddressLines({ previous, next }: Neighbours): boolean {
  if (previous === undefined || next === undefined) return false;
  const before = isAddressLine(previous);
  const after = isAddressLine(next);
  return (before || after) && (before || markerCount(previous) > 0) && (after || markerCount(next) > 0);
}
