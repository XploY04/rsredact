import type { Box, Detection, LLMProvider, OpaqueRegion, Page, ResolvedTarget, GridOptions } from '../types.js';
import { ProviderError } from '../errors.js';
import { unionBox } from './lines.js';
import {
  DEFAULT_GRID,
  cellRangeToBox,
  columnLabel,
  drawGridOverlay,
  makeGrid,
  parseCell,
  type Grid,
} from './grid.js';
import { VISION_SYSTEM, visionPrompt, visionSchema } from './prompts.js';

interface GridRedaction {
  target: string;
  from: string;
  to: string;
  confidence: number;
}

export interface VisionDetectionResult {
  detections: Detection[];
  calls: number;
  warnings: string[];
  /** The grid image that was sent, for debugging. */
  overlay: Buffer;
}

/**
 * `clipTo` limits findings to those regions, with no snapping to words. That
 * is how content the text layer cannot read is checked without letting a
 * coarse cell spill onto text that text detection already judged. A form field
 * or annotation holds one value, so a finding covers all of it. An image can
 * hold a whole header, so a finding covers where the rectangle, grown by one
 * cell to allow for the grid's imprecision, overlaps the image.
 */
export async function detectWithVision(
  page: Page,
  targets: ResolvedTarget[],
  provider: LLMProvider,
  gridOptions: GridOptions | undefined,
  clipTo?: OpaqueRegion[],
): Promise<VisionDetectionResult> {
  if (!provider.supportsVision) {
    throw new ProviderError(
      `Provider "${provider.name}" cannot read images, so vision mode is unavailable. ` +
        'Use mode "text", or pass a provider with supportsVision.',
      provider.name,
    );
  }

  const grid = makeGrid(page, gridOptions);
  const overlay = await drawGridOverlay(page, grid, gridOptions);
  const warnings: string[] = [];

  let response: { redactions?: GridRedaction[] };
  try {
    response = await provider.generateJson({
      system: VISION_SYSTEM,
      prompt: visionPrompt(targets, grid.cols, grid.rows, columnLabel(grid.cols - 1)),
      images: [{ mediaType: 'image/png', data: overlay.toString('base64') }],
      schema: visionSchema(targets.map((t) => t.id)) as never,
      maxTokens: 4096,
    });
  } catch (error) {
    throw new ProviderError(
      `Vision detection failed on page ${page.index + 1}`,
      provider.name,
      error,
    );
  }

  const snap = gridOptions?.snapToWords ?? DEFAULT_GRID.snapToWords;
  const targetIds = new Set(targets.map((t) => t.id));
  const detections: Detection[] = [];

  for (const item of response.redactions ?? []) {
    if (!targetIds.has(item.target)) {
      warnings.push(`page ${page.index + 1}: dropped a finding for a target that was not requested`);
      continue;
    }
    const from = parseCell(item.from ?? '');
    const to = parseCell(item.to ?? '');
    if (!from || !to) {
      warnings.push(
        `page ${page.index + 1}: unreadable grid reference "${item.from}":"${item.to}" ` +
          `for target "${item.target}"; nothing was redacted for it`,
      );
      continue;
    }

    const cellBox = cellRangeToBox(grid, from, to);
    const confidence = clamp(item.confidence);
    const target = item.target;

    if (clipTo) {
      const grown = {
        x: cellBox.x - grid.cellWidth,
        y: cellBox.y - grid.cellHeight,
        width: cellBox.width + 2 * grid.cellWidth,
        height: cellBox.height + 2 * grid.cellHeight,
      };
      for (const region of clipTo) {
        if (!intersect(cellBox, region.box)) continue;
        const box = region.kind === 'image' ? intersect(grown, region.box)! : region.box;
        detections.push({ page: page.index, target, box, confidence, source: 'llm-vision' });
      }
      continue;
    }

    const refined = snap ? snapToWords(page, cellBox) : [];
    if (refined.length > 0) {
      for (const hit of refined) {
        detections.push({
          page: page.index,
          target,
          box: hit.box,
          text: hit.text,
          confidence,
          source: 'llm-vision',
          wordIds: hit.wordIds,
        });
      }
    } else {
      detections.push({
        page: page.index,
        target,
        box: clampBox(cellBox, grid),
        confidence,
        source: 'llm-vision',
      });
    }
  }

  return { detections, calls: 1, warnings, overlay };
}

/**
 * A grid cell is coarse by construction: at 24x36 on A4 a cell is still about
 * two lines of body text tall. When we know where the words are, shrink the
 * model's rectangle to the words actually inside it, one box per line. That
 * keeps the model's job easy (point at a region) without paying for it in
 * over-redaction.
 */
function snapToWords(
  page: Page,
  region: Box,
): { box: Box; text: string; wordIds: string[] }[] {
  const inside = page.words.filter((word) => overlapRatio(word.box, region) > 0.5);
  if (inside.length === 0) return [];

  const byLine = new Map<number, typeof inside>();
  for (const word of inside) {
    const bucket = byLine.get(word.line);
    if (bucket) bucket.push(word);
    else byLine.set(word.line, [word]);
  }

  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, words]) => {
      const ordered = words.sort((a, b) => a.box.x - b.box.x);
      return {
        box: unionBox(ordered.map((w) => w.box)),
        text: ordered.map((w) => w.text).join(' '),
        wordIds: ordered.map((w) => w.id),
      };
    });
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Fraction of `inner` that lies within `outer`. */
function overlapRatio(inner: Box, outer: Box): number {
  const width = Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x);
  const height =
    Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y);
  if (width <= 0 || height <= 0) return 0;
  const area = inner.width * inner.height;
  if (area <= 0) return 0;
  return (width * height) / area;
}

function clampBox(box: Box, grid: Grid): Box {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  return {
    x,
    y,
    width: Math.min(box.width, grid.pageWidth - x),
    height: Math.min(box.height, grid.pageHeight - y),
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}
