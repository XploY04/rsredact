import type { Detection, Page, ResolvedTarget } from '../types.js';
import { builtinTargetIds } from '../targets.js';
import { unionBox } from './lines.js';

/**
 * Decides which hyperlinks should have their *visible text* painted over.
 *
 * Every hyperlink is already dead by the time output is written, because the
 * PDF is rebuilt from rendered pages and no annotation survives. So this is not
 * about neutralising the link, it is only about whether the reader can still
 * read the words. Usually they should: a dead link to an employer's site is
 * just the employer's name, and a dead link behind "CKA" is just a
 * certification. Hiding those destroys content for no privacy gain.
 *
 * 'keep'                nothing here redacts link text.
 * 'redact-identifying'  hide it when the destination identifies the candidate.
 * 'redact-all'          hide it for every link.
 */
export function detectLinks(
  page: Page,
  targets: ResolvedTarget[],
  policy: 'keep' | 'redact-identifying' | 'redact-all' = 'keep',
): Detection[] {
  if (policy === 'keep' || page.links.length === 0) return [];

  const detections: Detection[] = [];

  for (const link of page.links) {
    if (link.box.width <= 0 || link.box.height <= 0) continue;

    const matched = identifyingTarget(link.url, targets);
    if (!matched && policy === 'redact-identifying') continue;

    // The annotation rect is often padded well past the glyphs. When the words
    // underneath are known, use them instead.
    const covered = page.words.filter((word) => centreInside(word.box, link.box));
    const box = covered.length > 0 ? unionBox(covered.map((w) => w.box)) : link.box;

    detections.push({
      page: page.index,
      target: matched ?? 'link',
      box,
      text: link.url,
      confidence: 1,
      source: 'link',
      wordIds: covered.map((w) => w.id),
    });
  }
  return detections;
}

const BUILTIN = new Set(builtinTargetIds());

/** Code hosts where a two-segment path is a repository, not a person. */
const CODE_HOSTS = /^(?:[a-z0-9-]+\.)?(?:github\.com|gitlab\.com|bitbucket\.org)$/i;
const LINKEDIN = /^(?:[a-z0-9-]+\.)?linkedin\.com$/i;
/** LinkedIn paths for organisations rather than people. */
const LINKEDIN_ORGANISATIONS = new Set(['company', 'school', 'showcase']);

/**
 * Which requested target, if any, says this destination points at the
 * candidate. A link's destination is not visible text, so matching it against
 * every pattern over-reaches: the url target matches every website, and phone
 * and date patterns match the digits in any long URL. That hid employer names
 * linking to the employer's site and project titles linking to a repository.
 *
 * - mailto: and tel: links are contact details, under the email and phone targets.
 * - Profile links on the hosts the social target knows, under social. A
 *   repository on a code host is a project, and a LinkedIn company or school
 *   page is an employer or a university, so neither counts.
 * - Patterns on caller-defined targets, which are about this candidate.
 */
function identifyingTarget(url: string, targets: ResolvedTarget[]): string | undefined {
  const requested = new Set(targets.map((t) => t.id));
  const matches = (target: ResolvedTarget) =>
    target.patterns.some((pattern) =>
      new RegExp(pattern.source, pattern.flags.replace('g', '')).test(url),
    );

  if (/^mailto:/i.test(url) && requested.has('email')) return 'email';
  if (/^tel:/i.test(url) && requested.has('phone')) return 'phone';

  const custom = targets.find((t) => !BUILTIN.has(t.id) && !t.visualOnly && matches(t));
  if (custom) return custom.id;

  const social = targets.find((t) => t.id === 'social');
  if (social && matches(social) && !isOrganisation(url)) return 'social';
  return undefined;
}

function isOrganisation(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
  } catch {
    return false;
  }
  const path = parsed.pathname.split('/').filter(Boolean);
  if (CODE_HOSTS.test(parsed.hostname)) return path.length >= 2;
  if (LINKEDIN.test(parsed.hostname)) return LINKEDIN_ORGANISATIONS.has(path[0]?.toLowerCase() ?? '');
  return false;
}

function centreInside(inner: { x: number; y: number; width: number; height: number }, outer: {
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height;
}
