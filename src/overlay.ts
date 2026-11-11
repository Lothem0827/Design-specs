import type { DimLine, Pill, Rect, Specs } from "./measure";
import {
  DEFAULT_COLORS,
  hexToRgb,
  type ShowOptions,
} from "./options";
import {
  BLUE_RADIUS,
  COMPACT_MAX,
  DASH_PATTERN,
  DIM_STROKE_WEIGHT,
  DIM_TICK,
  GAP_FILL_OPACITY,
  GRAY,
  GREEN_PAD,
  labelFont,
  LABEL_FONT_SIZE,
  OUTLINE_STROKE_WEIGHT,
  OVERLAY_NAME,
  PAD_FILL_OPACITY,
  PILL_PAD_X,
  PILL_PAD_Y,
  PILL_RADIUS,
  PURPLE,
  RED,
  YELLOW_GAP,
} from "./theme";
type RGB = { r: number; g: number; b: number };

export type OverlayHighlights = {
  layoutRects: Rect[];
  componentRects: Rect[];
};

export type OverlayExtras = {
  focusValue?: number | null;
};

const OVERLAY_MARK = "designSpecs";
const PILL_MARK = "pill";
/** Selection-dependent bits (distance dims, component outlines) — safe to replace on sticky. */
const STICKY_EXTRA = "stickyExtra";
/** Target pill height in canvas units at scale 1 — used to fit into small bands. */
const PILL_FIT = 14;

function markStickyExtra(node: SceneNode): void {
  node.setPluginData(STICKY_EXTRA, "1");
}

function takeBudget<T>(
  items: readonly T[],
  limit: number,
  prefer: (item: T) => boolean
): T[] {
  if (items.length <= limit) return items.slice();
  const priority: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (prefer(item)) priority.push(item);
    else rest.push(item);
  }
  if (priority.length >= limit) return priority.slice(0, limit);
  return [...priority, ...rest.slice(0, limit - priority.length)];
}

let liveOverlay: GroupNode | null = null;

export function findLiveOverlay(): GroupNode | null {
  if (liveOverlay && !liveOverlay.removed) return liveOverlay;
  liveOverlay = null;
  for (const child of figma.currentPage.children) {
    if (child.name !== OVERLAY_NAME || child.type !== "GROUP") continue;
    if (child.getPluginData(OVERLAY_MARK) === "1") {
      liveOverlay = child;
      return liveOverlay;
    }
  }
  return null;
}

export function removeExistingOverlay(): void {
  liveOverlay = null;
  for (const child of [...figma.currentPage.children]) {
    if (child.name !== OVERLAY_NAME) continue;
    const marked = child.getPluginData(OVERLAY_MARK) === "1";
    // shortcut: locked name match also clears overlays from before the mark
    const legacy = "locked" in child && child.locked;
    if (marked || legacy) child.remove();
  }
}

function placePill(frame: FrameNode, x: number, y: number, anchor: string): void {
  const w = frame.width;
  const h = frame.height;
  if (anchor === "center") {
    frame.x = x - w / 2;
    frame.y = y - h / 2;
  } else if (anchor === "top-left") {
    frame.x = x;
    frame.y = y;
  } else {
    frame.x = x - w / 2;
    frame.y = y;
  }
}

function solidPaint(color: RGB, opacity = 1): SolidPaint {
  return { type: "SOLID", color, opacity };
}

function sameColor(a: RGB, b: RGB): boolean {
  return Math.abs(a.r - b.r) < 0.01 && Math.abs(a.g - b.g) < 0.01 && Math.abs(a.b - b.b) < 0.01;
}

/** Fit label into measured space only — no viewport zoom (avoids pan/zoom lag). */
export function pillScale(spacePx: number): number {
  const bySpace = spacePx > 0 ? spacePx / PILL_FIT : 1;
  return Math.max(0.08, Math.min(1.5, bySpace));
}

function makeRect(
  name: string,
  rect: Rect,
  opts: {
    color: RGB;
    fillOpacity: number;
  }
): RectangleNode {
  const r = figma.createRectangle();
  r.name = name;
  r.x = rect.x;
  r.y = rect.y;
  r.resize(Math.max(rect.width, 0.01), Math.max(rect.height, 0.01));
  r.fills = [solidPaint(opts.color, opts.fillOpacity)];
  r.strokes = [];
  return r;
}

function makeDashedBorder(name: string, rect: Rect, color: RGB): RectangleNode {
  const r = figma.createRectangle();
  r.name = name;
  r.x = rect.x;
  r.y = rect.y;
  r.resize(Math.max(rect.width, 0.01), Math.max(rect.height, 0.01));
  r.fills = [];
  r.strokes = [solidPaint(color, 1)];
  r.strokeWeight = OUTLINE_STROKE_WEIGHT;
  r.dashPattern = DASH_PATTERN;
  return r;
}

function gapLabelPoint(gap: { rect: Rect }): { x: number; y: number } {
  return {
    x: gap.rect.x + gap.rect.width / 2,
    y: gap.rect.y + gap.rect.height / 2,
  };
}

function matchesFocus(value: number | undefined, focusValue: number | null | undefined): boolean {
  if (focusValue == null) return true;
  if (value == null) return false;
  return Math.abs(value - focusValue) < 0.001;
}

function makePill(
  pill: Pill,
  color: RGB,
  scale: number,
  style: { labelFontSize: number; pillSize: number },
  spacePx: number,
  opacity = 1
): FrameNode {
  const frame = figma.createFrame();
  frame.name = `label:${pill.text}`;
  frame.layoutMode = "HORIZONTAL";
  frame.primaryAxisSizingMode = "AUTO";
  frame.counterAxisSizingMode = "AUTO";
  const size = style.pillSize;
  const padX = Math.max(0.5, PILL_PAD_X * size * scale);
  const padY = Math.max(0.25, PILL_PAD_Y * size * scale);
  frame.paddingLeft = padX;
  frame.paddingRight = padX;
  frame.paddingTop = padY;
  frame.paddingBottom = padY;
  frame.cornerRadius = Math.max(0.5, PILL_RADIUS * size * scale);
  frame.fills = [solidPaint(color, opacity)];
  frame.strokes = [];
  frame.primaryAxisAlignItems = "CENTER";
  frame.counterAxisAlignItems = "CENTER";
  frame.setPluginData(PILL_MARK, "1");
  frame.setPluginData("spacePx", String(spacePx));
  frame.setPluginData("anchor", pill.anchor);
  frame.setPluginData("ax", String(pill.x));
  frame.setPluginData("ay", String(pill.y));
  if (pill.value != null) frame.setPluginData("spacingValue", String(pill.value));
  if (sameColor(color, RED)) frame.setPluginData("error", "1");

  const text = figma.createText();
  text.fontName = labelFont;
  text.fontSize = Math.max(1, Math.round(style.labelFontSize * scale * 10) / 10);
  text.characters = pill.text;
  text.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity }];
  frame.appendChild(text);

  placePill(frame, pill.x, pill.y, pill.anchor);
  return frame;
}

/** Red = hard input (no token). Else: user colors (defaults green/yellow/blue). */
function kindColor(kind: "padding" | "gap" | "radius", options: ShowOptions): RGB {
  const hex =
    kind === "padding"
      ? options.colors?.padding ?? DEFAULT_COLORS.padding
      : kind === "gap"
        ? options.colors?.gap ?? DEFAULT_COLORS.gap
        : options.colors?.radius ?? DEFAULT_COLORS.radius;
  const parsed = hexToRgb(hex);
  if (parsed) return parsed;
  if (kind === "padding") return GREEN_PAD;
  if (kind === "gap") return YELLOW_GAP;
  return BLUE_RADIUS;
}

function pillColor(
  kind: "padding" | "gap" | "radius",
  opts: { bound?: boolean },
  options: ShowOptions
): RGB {
  if (opts.bound === false) return RED;
  return kindColor(kind, options);
}

function bandColor(bound: boolean | undefined, soft: RGB): RGB {
  if (bound === false) return RED;
  return soft;
}

function pushBand(
  soft: SceneNode[],
  hard: SceneNode[],
  node: SceneNode,
  color: RGB
): void {
  if (sameColor(color, RED)) hard.push(node);
  else soft.push(node);
}

function makeDimNodes(dim: DimLine, color: RGB, sticky = false): SceneNode[] {
  const nodes: SceneNode[] = [];
  const thick = DIM_STROKE_WEIGHT;
  if (dim.axis === "HORIZONTAL") {
    const line = figma.createRectangle();
    line.name = `dim-h-${dim.value}`;
    line.x = dim.x1;
    line.y = dim.y1 - thick / 2;
    line.resize(Math.max(dim.x2 - dim.x1, 0.01), thick);
    line.fills = [solidPaint(color, 1)];
    line.strokes = [];
    nodes.push(line);

    const tickL = figma.createRectangle();
    tickL.name = "tick";
    tickL.x = dim.x1 - thick / 2;
    tickL.y = dim.y1 - DIM_TICK / 2;
    tickL.resize(thick, DIM_TICK);
    tickL.fills = [solidPaint(color, 1)];
    tickL.strokes = [];
    nodes.push(tickL);

    const tickR = figma.createRectangle();
    tickR.name = "tick";
    tickR.x = dim.x2 - thick / 2;
    tickR.y = dim.y1 - DIM_TICK / 2;
    tickR.resize(thick, DIM_TICK);
    tickR.fills = [solidPaint(color, 1)];
    tickR.strokes = [];
    nodes.push(tickR);
  } else {
    const line = figma.createRectangle();
    line.name = `dim-v-${dim.value}`;
    line.x = dim.x1 - thick / 2;
    line.y = dim.y1;
    line.resize(thick, Math.max(dim.y2 - dim.y1, 0.01));
    line.fills = [solidPaint(color, 1)];
    line.strokes = [];
    nodes.push(line);

    const tickT = figma.createRectangle();
    tickT.name = "tick";
    tickT.x = dim.x1 - DIM_TICK / 2;
    tickT.y = dim.y1 - thick / 2;
    tickT.resize(DIM_TICK, thick);
    tickT.fills = [solidPaint(color, 1)];
    tickT.strokes = [];
    nodes.push(tickT);

    const tickB = figma.createRectangle();
    tickB.name = "tick";
    tickB.x = dim.x1 - DIM_TICK / 2;
    tickB.y = dim.y2 - thick / 2;
    tickB.resize(DIM_TICK, thick);
    tickB.fills = [solidPaint(color, 1)];
    tickB.strokes = [];
    nodes.push(tickB);
  }
  if (sticky) {
    for (const n of nodes) markStickyExtra(n);
  }
  return nodes;
}

type QueuedPill = { pill: Pill; color: RGB; spacePx: number; stickyExtra?: boolean };

function removeStickyExtras(group: GroupNode): void {
  const doomed: SceneNode[] = [];
  const walk = (nodes: readonly SceneNode[]) => {
    for (const node of nodes) {
      if (node.getPluginData(STICKY_EXTRA) === "1") doomed.push(node);
      else if ("children" in node) walk(node.children);
    }
  };
  walk(group.children);
  for (const node of doomed) {
    if (!node.removed) node.remove();
  }
}

/** Replace distance dims + component outlines on live overlay — keep pad/gap fills. */
export function patchStickyOverlayExtras(
  group: GroupNode,
  options: ShowOptions,
  extras: {
    distanceDims: DimLine[];
    componentRects: Rect[];
  }
): void {
  const wasLocked = group.locked;
  if (wasLocked) group.locked = false;
  const pillStyle = {
    labelFontSize: options.labelFontSize ?? LABEL_FONT_SIZE,
    pillSize: options.pillSize ?? 1,
  };
  const pillOpacity = options.pillOpacity ?? 1;
  try {
    removeStickyExtras(group);
    const add: SceneNode[] = [];
    if (options.distance) {
      for (const dim of extras.distanceDims) {
        add.push(...makeDimNodes(dim, GRAY, true));
        const len =
          dim.axis === "HORIZONTAL" ? Math.abs(dim.x2 - dim.x1) : Math.abs(dim.y2 - dim.y1);
        const space = Math.max(len * 0.15, 8);
        const pill = makePill(
          dim.label,
          GRAY,
          pillScale(space),
          pillStyle,
          space,
          pillOpacity
        );
        markStickyExtra(pill);
        add.push(pill);
      }
    }
    if (options.components) {
      for (let i = 0; i < extras.componentRects.length; i++) {
        const border = makeDashedBorder(
          `not-component-${i}`,
          extras.componentRects[i],
          PURPLE
        );
        markStickyExtra(border);
        add.push(border);
      }
    }
    for (const node of add) group.appendChild(node);
  } finally {
    if (wasLocked) group.locked = true;
  }
}

export async function drawOverlay(
  specs: Specs | null,
  options: ShowOptions,
  highlights: OverlayHighlights = { layoutRects: [], componentRects: [] },
  stillValid: () => boolean = () => true,
  extras: OverlayExtras = {}
): Promise<GroupNode | null> {
  const focusValue = extras.focusValue ?? null;
  const anyOn =
    options.radius ||
    options.padding ||
    options.gap ||
    options.layout ||
    options.components ||
    options.distance;

  const softUnder: SceneNode[] = [];
  const hardUnder: SceneNode[] = [];
  const softPills: SceneNode[] = [];
  const hardPills: SceneNode[] = [];
  const queuedPills: QueuedPill[] = [];
  const pillStyle = {
    labelFontSize: options.labelFontSize ?? LABEL_FONT_SIZE,
    pillSize: options.pillSize ?? 1,
  };
  const pillOpacity = options.pillOpacity ?? 1;
  const padSoft = kindColor("padding", options);
  const gapSoft = kindColor("gap", options);

  const queuePill = (pill: Pill, color: RGB, spacePx: number, stickyExtra = false) => {
    queuedPills.push({ pill, color, spacePx, stickyExtra });
  };

  const flushPills = () => {
    const priority: QueuedPill[] = [];
    const rest: QueuedPill[] = [];
    for (const item of queuedPills) {
      const isError = sameColor(item.color, RED);
      const focused =
        focusValue != null && matchesFocus(item.pill.value, focusValue);
      if (isError || focused) priority.push(item);
      else rest.push(item);
    }
    const chosen = priority.length >= COMPACT_MAX
      ? priority.slice(0, COMPACT_MAX)
      : [...priority, ...rest.slice(0, COMPACT_MAX - priority.length)];
    for (const item of chosen) {
      const node = makePill(
        item.pill,
        item.color,
        pillScale(item.spacePx),
        pillStyle,
        item.spacePx,
        pillOpacity
      );
      if (item.stickyExtra) markStickyExtra(node);
      if (sameColor(item.color, RED)) hardPills.push(node);
      else softPills.push(node);
    }
  };

  if (specs && options.padding) {
    const bands = specs.paddingBands.filter((band) => matchesFocus(band.value, focusValue));
    const chosen = takeBudget(bands, COMPACT_MAX, (band) => band.bound === false);
    for (const band of chosen) {
      const color = bandColor(band.bound, padSoft);
      pushBand(
        softUnder,
        hardUnder,
        makeRect(`pad-${band.side}`, band.rect, {
          color,
          fillOpacity: options.overlayOpacity ?? PAD_FILL_OPACITY,
        }),
        color
      );
    }
  }

  if (specs && options.gap) {
    const gaps = specs.gaps.filter((gap) => matchesFocus(gap.value, focusValue));
    const chosen = takeBudget(gaps, COMPACT_MAX, (gap) => gap.bound === false);
    for (const gap of chosen) {
      const color = bandColor(gap.bound, gapSoft);
      pushBand(
        softUnder,
        hardUnder,
        makeRect(`gap-fill`, gap.rect, {
          color,
          fillOpacity: options.overlayOpacity ?? GAP_FILL_OPACITY,
        }),
        color
      );
    }
  }

  if (anyOn && options.layout) {
    for (let i = 0; i < highlights.layoutRects.length; i++) {
      softUnder.push(makeDashedBorder(`layout-${i}`, highlights.layoutRects[i], GRAY));
    }
  }

  if (anyOn && options.components) {
    for (let i = 0; i < highlights.componentRects.length; i++) {
      const border = makeDashedBorder(
        `not-component-${i}`,
        highlights.componentRects[i],
        PURPLE
      );
      markStickyExtra(border);
      softUnder.push(border);
    }
  }

  if (specs && options.distance && focusValue == null) {
    for (const dim of specs.distanceDims) {
      softUnder.push(...makeDimNodes(dim, GRAY, true));
      const len =
        dim.axis === "HORIZONTAL" ? Math.abs(dim.x2 - dim.x1) : Math.abs(dim.y2 - dim.y1);
      queuePill(dim.label, GRAY, Math.max(len * 0.15, 8), true);
    }
  }

  if (anyOn && specs && options.radius && focusValue == null) {
    for (const pill of specs.radiusPills) {
      const space = pill.value != null ? Math.max(pill.value, 8) : 12;
      queuePill(
        pill,
        pillColor("radius", { bound: pill.bound }, options),
        space
      );
    }
  }

  if (anyOn && specs && options.padding) {
    for (let i = 0; i < specs.paddingPills.length; i++) {
      const pill = specs.paddingPills[i];
      if (!matchesFocus(pill.value, focusValue)) continue;
      const band = specs.paddingBands[i];
      const space = band
        ? Math.min(band.rect.width, band.rect.height)
        : pill.value ?? 8;
      queuePill(
        pill,
        pillColor("padding", { bound: pill.bound }, options),
        space
      );
    }
  }

  if (anyOn && specs && options.gap) {
    for (const gap of specs.gaps) {
      if (!matchesFocus(gap.value, focusValue)) continue;
      const pt = gapLabelPoint(gap);
      const space = Math.min(gap.rect.width, gap.rect.height);
      queuePill(
        {
          text: String(gap.value),
          x: pt.x,
          y: pt.y,
          anchor: "center",
          value: gap.value,
          bound: gap.bound,
        },
        pillColor("gap", { bound: gap.bound }, options),
        space
      );
    }
  }

  flushPills();

  // z-order: soft fills → hard fills → soft labels → hard/error labels on top
  const nodes = [...softUnder, ...hardUnder, ...softPills, ...hardPills];
  if (!stillValid()) {
    for (const node of nodes) node.remove();
    return null;
  }
  removeExistingOverlay();
  if (nodes.length === 0) {
    liveOverlay = null;
    return null;
  }

  const group = figma.group(nodes, figma.currentPage);
  group.name = OVERLAY_NAME;
  group.setPluginData(OVERLAY_MARK, "1");
  group.locked = true;
  figma.currentPage.appendChild(group);
  liveOverlay = group;
  return group;
}
