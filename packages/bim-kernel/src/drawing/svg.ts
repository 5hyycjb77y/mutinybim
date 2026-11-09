import { textBlockToSvg } from "../annotation/text-note";
import { TONE_GREY, fillGrey, lineWidthMm, type SheetScene, type Tone } from "./sheet";

function stroke(tone: Tone | undefined, color?: string): string {
  if (color && (!tone || tone === "ink")) return color;
  if (!tone || tone === "ink") return "#000";
  const v = Math.round(TONE_GREY[tone] * 255).toString(16).padStart(2, "0");
  return `#${v}${v}${v}`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render a sheet scene to SVG in paper millimetres. Same scene graph as the
 * PDF writer, so what the engineer sees is what prints.
 */
export function sceneToSvg(scene: SheetScene, opts: { readonly hideNoteIds?: ReadonlySet<string>; readonly imageHref?: (fileId: string) => string | null; /** Every colour black, as a black-only plotter prints it. */ readonly monochrome?: boolean } = {}): string {
  const parts: string[] = [];
  const ink = (color: string | undefined) => (opts.monochrome ? undefined : color);
  const fonts = new Map((scene.fonts ?? []).map((f) => [f.id, f]));
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.paper.x} ${scene.paper.y}" width="100%" height="100%" font-family="Helvetica, Arial, sans-serif">`,
    `<rect x="0" y="0" width="${scene.paper.x}" height="${scene.paper.y}" fill="#fff"/>`,
  );
  // A firm title block's faces, loaded from where the scene names them.
  if (fonts.size > 0) parts.push(`<defs><style>${[...fonts.values()].map((f) => `@font-face{font-family:"${esc(f.family)}";font-weight:${f.weight};src:url("${esc(f.file)}")}`).join("")}</style></defs>`);
  // Pictures under the linework, as printed; one the host hasn't loaded yet shows as a labelled frame.
  for (const im of scene.images ?? []) {
    const href = opts.imageHref?.(im.fileId) ?? null;
    const box = `x="${im.at.x.toFixed(2)}" y="${im.at.y.toFixed(2)}" width="${im.size.x.toFixed(2)}" height="${im.size.y.toFixed(2)}"`;
    if (href) parts.push(`<image ${box} href="${esc(href)}" preserveAspectRatio="none" data-figure-id="${esc(im.itemId)}"/>`);
    else
      parts.push(
        `<rect ${box} fill="none" stroke="#9ca3af" stroke-width="0.25" stroke-dasharray="1.5 1" data-figure-id="${esc(im.itemId)}"/>`,
        `<text x="${(im.at.x + im.size.x / 2).toFixed(2)}" y="${(im.at.y + im.size.y / 2).toFixed(2)}" font-size="3" text-anchor="middle" fill="#6b7280">${esc(im.name)} (loading)</text>`,
      );
  }
  for (const p of scene.primitives) {
    if (p.kind === "line") {
      const dash = p.dash ? ` stroke-dasharray="${p.dash.join(" ")}"` : "";
      parts.push(
        `<line x1="${p.a.x.toFixed(2)}" y1="${p.a.y.toFixed(2)}" x2="${p.b.x.toFixed(2)}" y2="${p.b.y.toFixed(2)}" stroke="${stroke(p.tone, ink(p.color))}" stroke-width="${lineWidthMm(p)}" stroke-linecap="square"${dash}/>`,
      );
    } else if (p.kind === "fill") {
      const v = Math.round(fillGrey(p.grey, p.tone) * 255).toString(16).padStart(2, "0");
      const fill = p.color && !opts.monochrome ? p.color : `#${v}${v}${v}`;
      parts.push(`<polygon points="${p.points.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(" ")}" fill="${fill}" stroke="none"/>`);
    } else if (p.kind === "rect") {
      parts.push(
        `<rect x="${p.at.x.toFixed(2)}" y="${p.at.y.toFixed(2)}" width="${p.size.x.toFixed(2)}" height="${p.size.y.toFixed(2)}" fill="none" stroke="${ink(p.color) ?? "#000"}" stroke-width="${lineWidthMm(p)}"/>`,
      );
    } else {
      // SVG font-size is the em box; cap height is ~0.72 em for Helvetica (a scene font says its own).
      const face = p.font ? fonts.get(p.font) : undefined;
      const fontSize = (p.size / (face?.capHeight ?? 0.72)).toFixed(2);
      const family = face ? ` font-family="${esc(face.family)}, Helvetica, Arial, sans-serif"` : "";
      const weight = face ? ` font-weight="${face.weight}"` : p.bold ? ' font-weight="bold"' : "";
      const fill = p.tone && p.tone !== "ink" ? ` fill="${stroke(p.tone)}"` : ink(p.color) ? ` fill="${ink(p.color)}"` : "";
      parts.push(
        `<text x="${p.at.x.toFixed(2)}" y="${p.at.y.toFixed(2)}" font-size="${fontSize}" text-anchor="${p.anchor}"${family}${weight}${fill}${p.rotate ? ` transform="rotate(${p.rotate.toFixed(2)} ${p.at.x.toFixed(2)} ${p.at.y.toFixed(2)})"` : ""}>${esc(p.text)}</text>`,
      );
    }
  }
  // A note being edited in place is drawn by the editor from its draft instead.
  for (const block of scene.textBlocks ?? []) if (!opts.hideNoteIds?.has(block.itemId)) parts.push(textBlockToSvg(block));
  // On screen the placed standard detail is a labelled frame; the PDF writer
  // embeds the detail's actual vector page in the same frame.
  for (const d of scene.details) {
    const cx = d.at.x + d.size.x / 2;
    const cy = d.at.y + d.size.y / 2;
    parts.push(
      `<text x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" font-size="4.2" text-anchor="middle" fill="#6b7280">${esc(d.title)}</text>`,
      `<text x="${cx.toFixed(2)}" y="${(cy + 6).toFixed(2)}" font-size="3.2" text-anchor="middle" fill="#6b7280">vector detail embedded in the exported PDF · ${esc(d.sha256.slice(0, 12))}</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}
