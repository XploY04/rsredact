import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFFont, type PDFPage, type PDFRef } from 'pdf-lib';
import { columnLabel } from '../src/index.js';
import { customProvider } from '../src/providers/index.js';
import type { LLMProvider, ProviderRequest } from '../src/types.js';

export const PAGE = { width: 595, height: 842 };

/** A rectangle in PDF points, origin bottom-left, as pdf-lib draws. */
export interface PointRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Canvas {
  pdf: PDFDocument;
  page: PDFPage;
  helvetica: PDFFont;
  courier: PDFFont;
  annotations: PDFRef[];
}

/** One A4 page with a name in the header, plus whatever `draw` adds. */
export async function buildPdf(draw: (canvas: Canvas) => Promise<void> | void): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  const courier = await pdf.embedFont(StandardFonts.Courier);
  page.drawText('Jane Doe', { x: 60, y: 780, size: 20, font: helvetica });
  const canvas = { pdf, page, helvetica, courier, annotations: [] as PDFRef[] };
  await draw(canvas);
  if (canvas.annotations.length > 0) {
    page.node.set(PDFName.of('Annots'), pdf.context.obj(canvas.annotations));
  }
  return Buffer.from(await pdf.save());
}

export function addLink(canvas: Canvas, rect: PointRect, url: string): void {
  canvas.annotations.push(
    canvas.pdf.context.register(
      canvas.pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
      }),
    ),
  );
}

/** Black text on white, as a PNG: contact details pasted into a CV as a picture. */
export function textPng(text: string, width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#000000';
  context.font = `${Math.round(height * 0.6)}px sans-serif`;
  context.fillText(text, 4, height * 0.75);
  return canvas.toBuffer('image/png');
}

/** The grid cells a vision model would name to cover `rect`, at the default grid and dpi. */
export function cellRange(rect: PointRect, dpi = 150): { from: string; to: string } {
  const scale = dpi / 72;
  const width = Math.ceil(PAGE.width * scale);
  const height = Math.ceil(PAGE.height * scale);
  const cellWidth = width / 24;
  const cellHeight = height / 36;
  const left = rect.x * scale;
  const right = (rect.x + rect.width) * scale;
  const top = (PAGE.height - rect.y - rect.height) * scale;
  const bottom = (PAGE.height - rect.y) * scale;
  return {
    from: `${columnLabel(Math.floor(left / cellWidth))}${Math.floor(top / cellHeight) + 1}`,
    to: `${columnLabel(Math.floor((right - 0.01) / cellWidth))}${Math.floor((bottom - 0.01) / cellHeight) + 1}`,
  };
}

/** Raster pixel at the centre of `rect`, at `dpi`. */
export function centreOf(rect: PointRect, dpi = 150): { x: number; y: number } {
  const scale = dpi / 72;
  return {
    x: (rect.x + rect.width / 2) * scale,
    y: (PAGE.height - rect.y - rect.height / 2) * scale,
  };
}

/**
 * Answers text calls with nothing and vision calls with `visionHits`, recording
 * every request so a test can tell which detectors ran.
 */
export function splitProvider(
  visionHits: { target: string; rect: PointRect }[],
  options: { supportsVision?: boolean } = {},
): LLMProvider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const provider = customProvider({
    name: 'split',
    supportsVision: options.supportsVision ?? true,
    generate: async (request) => {
      requests.push(request);
      if (!request.images?.length) return { redactions: [] };
      return {
        redactions: visionHits.map((hit) => ({ target: hit.target, ...cellRange(hit.rect), confidence: 0.95 })),
      };
    },
  });
  return Object.assign(provider, { requests });
}
