import { isCounterGapAuto, isPrimaryGapAuto } from "./lint/walk";
import { DIM_OFFSET, MAX_NEST_DEPTH, MAX_WALK_NODES } from "./theme";

export type Rect = { x: number; y: number; width: number; height: number };

export type Pill = {
  text: string;
  x: number;
  y: number;
  anchor: "center" | "top-left" | "bottom-center";
  value?: number;
  /** False = hardcoded number, not bound to a variable token. */
  bound?: boolean;
};

export type DimLine = {
  axis: "HORIZONTAL" | "VERTICAL";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
  label: Pill;
};

export type Specs = {
  bounds: Rect;
  outline: Rect;
  contentInset: Rect | null;
  radius: number | null;
  paddingBands: Array<{
    side: "top" | "right" | "bottom" | "left";
    rect: Rect;
    value: number;
    bound?: boolean;
  }>;
  gaps: Array<{
    rect: Rect;
    value: number;
    axis: "VERTICAL" | "HORIZONTAL";
    bound?: boolean;
  }>;
  radiusPills: Pill[];
  paddingPills: Pill[];
  gapPills: Pill[];
  sizeDims: DimLine[];
  distanceDims: DimLine[];
};

export function distinctSpacingValues(specs: Specs | null): number[] {
  if (!specs) return [];
  const set = new Set<number>();
  for (const band of specs.paddingBands) set.add(band.value);
  for (const gap of specs.gaps) set.add(gap.value);
  return [...set].sort((a, b) => a - b);
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

function dimHorizontal(y: number, x1: number, x2: number, value: number): DimLine {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  return {
    axis: "HORIZONTAL",
    x1: left,
    y1: y,
    x2: right,
    y2: y,
    value,
    label: {
      text: String(Math.round(value)),
      x: (left + right) / 2,
      y: y - 6,
      anchor: "bottom-center",
      value: Math.round(value),
    },
  };
}

function dimVertical(x: number, y1: number, y2: number, value: number): DimLine {
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  return {
    axis: "VERTICAL",
    x1: x,
    y1: top,
    x2: x,
    y2: bottom,
    value,
    label: {
      text: String(Math.round(value)),
      x: x + 6,
      y: (top + bottom) / 2,
      anchor: "center",
      value: Math.round(value),
    },
  };
}

export function sizeDimLines(bounds: Rect): DimLine[] {
  const w = Math.round(bounds.width);
  const h = Math.round(bounds.height);
  return [
    dimHorizontal(bounds.y + bounds.height + DIM_OFFSET, bounds.x, bounds.x + bounds.width, w),
    dimVertical(bounds.x + bounds.width + DIM_OFFSET, bounds.y, bounds.y + bounds.height, h),
  ];
}

export function distanceDimLines(a: Rect, b: Rect): DimLine[] {
  if (containsRect(a, b)) return insetDimLines(b, a);
  if (containsRect(b, a)) return insetDimLines(a, b);

  const out: DimLine[] = [];
  const aRight = a.x + a.width;
  const aBottom = a.y + a.height;
  const bRight = b.x + b.width;
  const bBottom = b.y + b.height;

  if (aRight <= b.x) {
    const gap = b.x - aRight;
    const y = Math.max(a.y, b.y) + Math.min(a.height, b.height) / 2;
    out.push(dimHorizontal(y, aRight, b.x, gap));
  } else if (bRight <= a.x) {
    const gap = a.x - bRight;
    const y = Math.max(a.y, b.y) + Math.min(a.height, b.height) / 2;
    out.push(dimHorizontal(y, bRight, a.x, gap));
  }

  if (aBottom <= b.y) {
    const gap = b.y - aBottom;
    const x = Math.max(a.x, b.x) + Math.min(a.width, b.width) / 2;
    out.push(dimVertical(x, aBottom, b.y, gap));
  } else if (bBottom <= a.y) {
    const gap = a.y - bBottom;
    const x = Math.max(a.x, b.x) + Math.min(a.width, b.width) / 2;
    out.push(dimVertical(x, bBottom, a.y, gap));
  }

  return out;
}

function insetDimLines(inner: Rect, outer: Rect): DimLine[] {
  return [
    dimVertical(inner.x + inner.width / 2, outer.y, inner.y, inner.y - outer.y),
    dimVertical(
      inner.x + inner.width / 2,
      inner.y + inner.height,
      outer.y + outer.height,
      outer.y + outer.height - (inner.y + inner.height)
    ),
    dimHorizontal(inner.y + inner.height / 2, outer.x, inner.x, inner.x - outer.x),
    dimHorizontal(
      inner.y + inner.height / 2,
      inner.x + inner.width,
      outer.x + outer.width,
      outer.x + outer.width - (inner.x + inner.width)
    ),
  ].filter((d) => d.value > 0.5);
}

type AutoLayoutNode = FrameNode | ComponentNode | InstanceNode;

function isAutoLayoutContainer(node: SceneNode): node is AutoLayoutNode {
  return (
    (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") &&
    "layoutMode" in node &&
    node.layoutMode !== "NONE"
  );
}

function isTarget(node: SceneNode): node is AutoLayoutNode | FrameNode | ComponentNode | InstanceNode {
  return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE";
}

function boxOf(node: SceneNode): Rect | null {
  const b = node.absoluteBoundingBox;
  if (!b) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function uniformRadius(node: AutoLayoutNode | FrameNode | ComponentNode | InstanceNode): number | null {
  if (!("cornerRadius" in node)) return null;
  const r = node.cornerRadius;
  if (typeof r === "number" && r > 0) return Math.round(r);
  if (
    "topLeftRadius" in node &&
    typeof node.topLeftRadius === "number" &&
    node.topLeftRadius === node.topRightRadius &&
    node.topLeftRadius === node.bottomLeftRadius &&
    node.topLeftRadius === node.bottomRightRadius &&
    node.topLeftRadius > 0
  ) {
    return Math.round(node.topLeftRadius);
  }
  return null;
}

function paddingOf(node: AutoLayoutNode): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  return {
    top: node.paddingTop,
    right: node.paddingRight,
    bottom: node.paddingBottom,
    left: node.paddingLeft,
  };
}

type SpecAcc = {
  paddingBands: Specs["paddingBands"];
  gaps: Specs["gaps"];
  radiusPills: Pill[];
  paddingPills: Pill[];
};

function flowChildren(node: AutoLayoutNode): SceneNode[] {
  const out: SceneNode[] = [];
  for (const child of node.children) {
    if (child.visible === false) continue;
    if ("layoutPositioning" in child && child.layoutPositioning === "ABSOLUTE") continue;
    out.push(child);
  }
  return out;
}

function isSpacingBound(
  node: AutoLayoutNode,
  field:
    | "paddingTop"
    | "paddingRight"
    | "paddingBottom"
    | "paddingLeft"
    | "itemSpacing"
    | "counterAxisSpacing"
): boolean {
  return node.boundVariables?.[field] !== undefined;
}

function isRadiusBound(node: FrameNode | ComponentNode | InstanceNode): boolean {
  const bound = node.boundVariables;
  if (!bound) return false;
  return (
    bound.cornerRadius !== undefined ||
    (bound.topLeftRadius !== undefined &&
      bound.topRightRadius !== undefined &&
      bound.bottomLeftRadius !== undefined &&
      bound.bottomRightRadius !== undefined)
  );
}

function pushBetween(
  gaps: Specs["gaps"],
  a: Rect,
  b: Rect,
  axis: "VERTICAL" | "HORIZONTAL",
  value: number,
  bound?: boolean
): void {
  if (axis === "VERTICAL") {
    const y = a.y + a.height;
    const h = Math.max(0, b.y - y);
    gaps.push({
      value: Math.round(value),
      axis,
      bound,
      rect: {
        x: Math.min(a.x, b.x),
        y,
        width: Math.max(a.width, b.width),
        height: h > 0 ? h : value,
      },
    });
    return;
  }
  const x = a.x + a.width;
  const w = Math.max(0, b.x - x);
  gaps.push({
    value: Math.round(value),
    axis,
    bound,
    rect: {
      x,
      y: Math.min(a.y, b.y),
      width: w > 0 ? w : value,
      height: Math.max(a.height, b.height),
    },
  });
}

function pushPairs(
  gaps: Specs["gaps"],
  kids: SceneNode[],
  axis: "VERTICAL" | "HORIZONTAL",
  value: number,
  bound?: boolean
): void {
  if (value <= 0 || kids.length < 2) return;
  for (let i = 0; i < kids.length - 1; i++) {
    const a = boxOf(kids[i]);
    const b = boxOf(kids[i + 1]);
    if (!a || !b) continue;
    pushBetween(gaps, a, b, axis, value, bound);
  }
}

function unionBox(nodes: SceneNode[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const node of nodes) {
    const box = boxOf(node);
    if (!box) continue;
    any = true;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!any) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// shortcut: a new wrap line starts when the main axis jumps backward. Reverse-direction auto layout is not handled.
function splitWrapLines(node: AutoLayoutNode, kids: SceneNode[]): SceneNode[][] {
  const horizontal = node.layoutMode === "HORIZONTAL";
  const lines: SceneNode[][] = [];
  let line: SceneNode[] = [];
  let prevMain: number | null = null;
  for (const kid of kids) {
    const box = boxOf(kid);
    if (!box) continue;
    const main = horizontal ? box.x : box.y;
    if (prevMain != null && main < prevMain - 0.5 && line.length) {
      lines.push(line);
      line = [];
    }
    line.push(kid);
    prevMain = main;
  }
  if (line.length) lines.push(line);
  return lines;
}

function collectGridGaps(node: AutoLayoutNode, gaps: Specs["gaps"]): void {
  const rowGap = node.gridRowGap;
  const colGap = node.gridColumnGap;
  if (!(rowGap > 0) && !(colGap > 0)) return;
  // shortcut: grid gap bind fields vary by API; treat as hard unless itemSpacing-style bind exists
  const bound = isSpacingBound(node, "itemSpacing");
  const cells: Array<{
    box: Rect;
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
  }> = [];
  for (const child of flowChildren(node)) {
    const box = boxOf(child);
    if (!box || !("gridRowAnchorIndex" in child) || !("gridColumnAnchorIndex" in child)) continue;
    try {
      const row = child.gridRowAnchorIndex;
      const col = child.gridColumnAnchorIndex;
      const rowSpan = "gridRowSpan" in child && typeof child.gridRowSpan === "number" ? child.gridRowSpan : 1;
      const colSpan =
        "gridColumnSpan" in child && typeof child.gridColumnSpan === "number" ? child.gridColumnSpan : 1;
      cells.push({ box, row, col, rowSpan, colSpan });
    } catch {
      // child is not in the grid
    }
  }
  const byCol = new Map<number, typeof cells>();
  const byRow = new Map<number, typeof cells>();
  for (const cell of cells) {
    let colList = byCol.get(cell.col);
    if (!colList) {
      colList = [];
      byCol.set(cell.col, colList);
    }
    colList.push(cell);
    let rowList = byRow.get(cell.row);
    if (!rowList) {
      rowList = [];
      byRow.set(cell.row, rowList);
    }
    rowList.push(cell);
  }

  if (colGap > 0) {
    for (const a of cells) {
      const next = byCol.get(a.col + a.colSpan);
      if (!next) continue;
      for (const b of next) {
        const rowOverlap = a.row < b.row + b.rowSpan && b.row < a.row + a.rowSpan;
        if (rowOverlap) pushBetween(gaps, a.box, b.box, "HORIZONTAL", colGap, bound);
      }
    }
  }
  if (rowGap > 0) {
    for (const a of cells) {
      const next = byRow.get(a.row + a.rowSpan);
      if (!next) continue;
      for (const b of next) {
        const colOverlap = a.col < b.col + b.colSpan && b.col < a.col + a.colSpan;
        if (colOverlap) pushBetween(gaps, a.box, b.box, "VERTICAL", rowGap, bound);
      }
    }
  }
}

function collectNodeGaps(node: AutoLayoutNode, gaps: Specs["gaps"]): void {
  if (node.layoutMode === "GRID") {
    collectGridGaps(node, gaps);
    return;
  }
  const kids = flowChildren(node);
  const horizontal = node.layoutMode === "HORIZONTAL";
  const axis = horizontal ? "HORIZONTAL" : "VERTICAL";
  const gapBound = isSpacingBound(node, "itemSpacing");
  const primaryAuto = isPrimaryGapAuto(node);
  if (node.layoutWrap !== "WRAP") {
    if (!primaryAuto) pushPairs(gaps, kids, axis, node.itemSpacing, gapBound);
    return;
  }
  const lines = splitWrapLines(node, kids);
  if (!primaryAuto && node.itemSpacing > 0) {
    for (const line of lines) pushPairs(gaps, line, axis, node.itemSpacing, gapBound);
  }
  const cross = node.counterAxisSpacing ?? 0;
  if (cross > 0 && lines.length >= 2 && !isCounterGapAuto(node)) {
    const crossBound = isSpacingBound(node, "counterAxisSpacing");
    const crossAxis = horizontal ? "VERTICAL" : "HORIZONTAL";
    for (let i = 0; i < lines.length - 1; i++) {
      const a = unionBox(lines[i]);
      const b = unionBox(lines[i + 1]);
      if (a && b) pushBetween(gaps, a, b, crossAxis, cross, crossBound);
    }
  }
}

export function mergeSpecs(list: Specs[]): Specs | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const paddingBands: Specs["paddingBands"] = [];
  const gaps: Specs["gaps"] = [];
  const radiusPills: Pill[] = [];
  const paddingPills: Pill[] = [];
  const gapPills: Pill[] = [];

  for (const s of list) {
    minX = Math.min(minX, s.bounds.x);
    minY = Math.min(minY, s.bounds.y);
    maxX = Math.max(maxX, s.bounds.x + s.bounds.width);
    maxY = Math.max(maxY, s.bounds.y + s.bounds.height);
    paddingBands.push(...s.paddingBands);
    gaps.push(...s.gaps);
    radiusPills.push(...s.radiusPills);
    paddingPills.push(...s.paddingPills);
    gapPills.push(...s.gapPills);
  }

  const bounds: Rect = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return {
    bounds,
    outline: bounds,
    contentInset: null,
    radius: null,
    paddingBands,
    gaps,
    radiusPills,
    paddingPills,
    gapPills,
    sizeDims: sizeDimLines(bounds),
    distanceDims: [],
  };
}

function addPadding(node: AutoLayoutNode, acc: SpecAcc): void {
  const bounds = boxOf(node);
  if (!bounds) return;
  const { top, right, bottom, left } = paddingOf(node);

  if (top > 0) {
    const bound = isSpacingBound(node, "paddingTop");
    acc.paddingBands.push({
      side: "top",
      value: Math.round(top),
      bound,
      rect: {
        x: bounds.x + left,
        y: bounds.y,
        width: Math.max(0, bounds.width - left - right),
        height: top,
      },
    });
    acc.paddingPills.push({
      text: String(Math.round(top)),
      x: bounds.x + bounds.width / 2,
      y: bounds.y + top / 2,
      anchor: "center",
      value: Math.round(top),
      bound,
    });
  }
  if (bottom > 0) {
    const bound = isSpacingBound(node, "paddingBottom");
    acc.paddingBands.push({
      side: "bottom",
      value: Math.round(bottom),
      bound,
      rect: {
        x: bounds.x + left,
        y: bounds.y + bounds.height - bottom,
        width: Math.max(0, bounds.width - left - right),
        height: bottom,
      },
    });
    acc.paddingPills.push({
      text: String(Math.round(bottom)),
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height - bottom / 2,
      anchor: "center",
      value: Math.round(bottom),
      bound,
    });
  }
  if (left > 0) {
    const bound = isSpacingBound(node, "paddingLeft");
    acc.paddingBands.push({
      side: "left",
      value: Math.round(left),
      bound,
      rect: {
        x: bounds.x,
        y: bounds.y + top,
        width: left,
        height: Math.max(0, bounds.height - top - bottom),
      },
    });
    acc.paddingPills.push({
      text: String(Math.round(left)),
      x: bounds.x + left / 2,
      y: bounds.y + bounds.height / 2,
      anchor: "center",
      value: Math.round(left),
      bound,
    });
  }
  if (right > 0) {
    const bound = isSpacingBound(node, "paddingRight");
    acc.paddingBands.push({
      side: "right",
      value: Math.round(right),
      bound,
      rect: {
        x: bounds.x + bounds.width - right,
        y: bounds.y + top,
        width: right,
        height: Math.max(0, bounds.height - top - bottom),
      },
    });
    acc.paddingPills.push({
      text: String(Math.round(right)),
      x: bounds.x + bounds.width - right / 2,
      y: bounds.y + bounds.height / 2,
      anchor: "center",
      value: Math.round(right),
      bound,
    });
  }
}

function addRadius(node: SceneNode, acc: SpecAcc): void {
  if (!isTarget(node)) return;
  const bounds = boxOf(node);
  const radius = uniformRadius(node);
  if (!bounds || radius == null) return;
  acc.radiusPills.push({
    text: `r ${radius}`,
    x: bounds.x + 4,
    y: bounds.y + 4,
    anchor: "top-left",
    value: radius,
    bound: isRadiusBound(node),
  });
}

function collectSpecs(node: SceneNode, depth: number, acc: SpecAcc, budget: { n: number }): void {
  if (depth > MAX_NEST_DEPTH || budget.n >= MAX_WALK_NODES) return;
  if (node.visible === false) return;
  budget.n++;
  if (isTarget(node)) {
    addRadius(node, acc);
    if (isAutoLayoutContainer(node)) {
      addPadding(node, acc);
      collectNodeGaps(node, acc.gaps);
    }
  }
  if ("children" in node) {
    for (const child of node.children) collectSpecs(child, depth + 1, acc, budget);
  }
}

export function measure(node: SceneNode): Specs | null {
  if (!isTarget(node)) return null;
  const bounds = boxOf(node);
  if (!bounds) return null;

  const acc: SpecAcc = { paddingBands: [], gaps: [], radiusPills: [], paddingPills: [] };
  collectSpecs(node, 0, acc, { n: 0 });

  let contentInset: Rect | null = null;
  if (isAutoLayoutContainer(node)) {
    const { top, right, bottom, left } = paddingOf(node);
    if (top > 0 || right > 0 || bottom > 0 || left > 0) {
      contentInset = {
        x: bounds.x + left,
        y: bounds.y + top,
        width: Math.max(0, bounds.width - left - right),
        height: Math.max(0, bounds.height - top - bottom),
      };
    }
  }

  return {
    bounds,
    outline: bounds,
    contentInset,
    radius: uniformRadius(node),
    paddingBands: acc.paddingBands,
    gaps: acc.gaps,
    radiusPills: acc.radiusPills,
    paddingPills: acc.paddingPills,
    gapPills: [],
    sizeDims: sizeDimLines(bounds),
    distanceDims: [],
  };
}
