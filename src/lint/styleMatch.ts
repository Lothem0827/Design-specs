import type { StyleCandidate } from "./types";

const CHANNEL = 3 / 255;

let paintStylesCache: PaintStyle[] | null = null;
let textStylesCache: TextStyle[] | null = null;
let effectStylesCache: EffectStyle[] | null = null;

export function clearStyleCaches(): void {
  paintStylesCache = null;
  textStylesCache = null;
  effectStylesCache = null;
}

function colorsClose(a: RGB, b: RGB, maxChannel = CHANNEL): boolean {
  return (
    Math.abs(a.r - b.r) <= maxChannel &&
    Math.abs(a.g - b.g) <= maxChannel &&
    Math.abs(a.b - b.b) <= maxChannel
  );
}

function solidFromPaints(paints: ReadonlyArray<Paint>): SolidPaint | null {
  for (const p of paints) {
    if (p.type === "SOLID" && p.visible !== false) return p;
  }
  return null;
}

export async function loadPaintStyles(): Promise<PaintStyle[]> {
  if (paintStylesCache) return paintStylesCache;
  paintStylesCache = await figma.getLocalPaintStylesAsync();
  return paintStylesCache;
}

export async function loadTextStyles(): Promise<TextStyle[]> {
  if (textStylesCache) return textStylesCache;
  textStylesCache = await figma.getLocalTextStylesAsync();
  return textStylesCache;
}

export async function loadEffectStyles(): Promise<EffectStyle[]> {
  if (effectStylesCache) return effectStylesCache;
  effectStylesCache = await figma.getLocalEffectStylesAsync();
  return effectStylesCache;
}

export function matchPaintStyles(styles: PaintStyle[], color: RGB): StyleCandidate[] {
  const out: StyleCandidate[] = [];
  for (const style of styles) {
    const solid = solidFromPaints(style.paints);
    if (solid && colorsClose(solid.color, color)) {
      out.push({ id: style.id, name: style.name });
    }
  }
  return out;
}

export type PaintRole = "text" | "icon" | "bg" | "other";

function isIconLike(node: SceneNode): boolean {
  const name = (node.name || "").toLowerCase();
  if (/icon|ico|glyph|symbol/.test(name)) return true;
  if (
    node.type === "VECTOR" ||
    node.type === "BOOLEAN_OPERATION" ||
    node.type === "STAR" ||
    node.type === "POLYGON" ||
    node.type === "LINE" ||
    node.type === "ELLIPSE"
  ) {
    return true;
  }
  if (
    (node.type === "FRAME" || node.type === "INSTANCE" || node.type === "COMPONENT") &&
    "width" in node &&
    typeof node.width === "number" &&
    typeof node.height === "number" &&
    node.width <= 48 &&
    node.height <= 48
  ) {
    return true;
  }
  return false;
}

export function paintRole(node: SceneNode): PaintRole {
  if (node.type === "TEXT") return "text";
  if (isIconLike(node)) return "icon";
  if (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE" ||
    node.type === "COMPONENT_SET" ||
    node.type === "RECTANGLE" ||
    node.type === "SECTION"
  ) {
    return "bg";
  }
  return "other";
}

export function rankPaintStyles(candidates: StyleCandidate[], role: PaintRole): StyleCandidate[] {
  if (candidates.length <= 1 || role === "other") return candidates;
  const re =
    role === "text" ? /text/i : role === "icon" ? /icon/i : /background|\bbg\b/i;
  const preferred = candidates.filter((c) => re.test(c.name));
  if (preferred.length === 0) return candidates;
  const rest = candidates.filter((c) => !re.test(c.name));
  return [...preferred, ...rest];
}

export function matchTextStyles(styles: TextStyle[], node: TextNode): StyleCandidate[] {
  if (node.fontSize === figma.mixed || typeof node.fontSize !== "number") return [];
  if (node.fontName === figma.mixed) return [];

  const family = node.fontName.family;
  const styleName = node.fontName.style;
  const size = node.fontSize;
  const out: StyleCandidate[] = [];

  for (const style of styles) {
    if (style.fontSize !== size) continue;
    if (style.fontName.family !== family) continue;
    if (style.fontName.style !== styleName) continue;
    out.push({ id: style.id, name: style.name });
  }
  return out;
}

function effectRoughEqual(a: Effect, b: Effect): boolean {
  if (a.type !== b.type || a.visible !== b.visible) return false;

  if (
    (a.type === "DROP_SHADOW" || a.type === "INNER_SHADOW") &&
    (b.type === "DROP_SHADOW" || b.type === "INNER_SHADOW")
  ) {
    const aSpread = a.spread ?? 0;
    const bSpread = b.spread ?? 0;
    return (
      colorsClose(a.color, b.color) &&
      Math.abs(a.radius - b.radius) < 0.5 &&
      Math.abs(aSpread - bSpread) < 0.5 &&
      Math.abs(a.offset.x - b.offset.x) < 0.5 &&
      Math.abs(a.offset.y - b.offset.y) < 0.5
    );
  }

  if (
    (a.type === "LAYER_BLUR" || a.type === "BACKGROUND_BLUR") &&
    (b.type === "LAYER_BLUR" || b.type === "BACKGROUND_BLUR")
  ) {
    return Math.abs(a.radius - b.radius) < 0.5;
  }

  return false;
}

export function matchEffectStyles(styles: EffectStyle[], effects: ReadonlyArray<Effect>): StyleCandidate[] {
  const visible = effects.filter((e) => e.visible);
  if (visible.length === 0) return [];

  const out: StyleCandidate[] = [];
  for (const style of styles) {
    const se = style.effects.filter((e) => e.visible);
    if (se.length !== visible.length) continue;
    let ok = true;
    for (let i = 0; i < visible.length; i++) {
      if (!effectRoughEqual(visible[i], se[i])) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ id: style.id, name: style.name });
  }
  return out;
}
