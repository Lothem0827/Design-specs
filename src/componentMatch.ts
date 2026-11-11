import type { LintIssue, LintResult } from "./lint/types";

const FINGERPRINT_DEPTH = 3;
const SIZE_ROUND = 4;
const SPACE_ROUND = 4;
const TOP_N = 5;
const SCORE_THRESHOLD = 0.7;
const MATCH_COLLECT_DEPTH = 20;

export type ComponentCandidate = {
  componentId: string;
  name: string;
  score: number;
  preview?: string;
};

export type ComponentMatch = {
  nodeId: string;
  nodeName: string;
  candidates: ComponentCandidate[];
};

export type ReplaceItem = {
  nodeId: string;
  componentId: string;
};

export type Fingerprint = {
  childCount: number;
  width: number;
  height: number;
  layoutMode: string;
  paddingKey: string;
  itemSpacing: number;
  typeCounts: string;
  typePath: string;
  hasText: boolean;
  textLenBucket: number;
  hasRadius: boolean;
  hasFill: boolean;
};

const SHAPE_TYPES = new Set<NodeType>([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "RECTANGLE",
  "POLYGON",
  "STAR",
  "LINE",
]);

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function subtreeHasText(node: SceneNode, depth: number): boolean {
  if (node.type === "TEXT") return true;
  if (depth >= FINGERPRINT_DEPTH || !("children" in node)) return false;
  for (const child of node.children) {
    if (subtreeHasText(child, depth + 1)) return true;
  }
  return false;
}

/** BOX / TEXT / SHAPE. Icon instances (no text) collapse to SHAPE like vectors. */
function typeKey(node: SceneNode): string {
  if (node.type === "TEXT") return "TEXT";
  if (SHAPE_TYPES.has(node.type)) return "SHAPE";
  if (node.type === "INSTANCE" && !subtreeHasText(node, 0)) return "SHAPE";
  if (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE" ||
    node.type === "COMPONENT_SET"
  ) {
    return "BOX";
  }
  return node.type;
}

function isShapeLeaf(node: SceneNode): boolean {
  return SHAPE_TYPES.has(node.type) || (node.type === "INSTANCE" && !subtreeHasText(node, 0));
}

function isContainer(
  node: SceneNode
): node is FrameNode | ComponentNode | InstanceNode | ComponentSetNode {
  return (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE" ||
    node.type === "COMPONENT_SET"
  );
}

function layoutPaddingKey(node: FrameNode | ComponentNode | InstanceNode): string {
  if (!("layoutMode" in node) || node.layoutMode === "NONE") return "none";
  return [
    roundTo(node.paddingTop, SPACE_ROUND),
    roundTo(node.paddingRight, SPACE_ROUND),
    roundTo(node.paddingBottom, SPACE_ROUND),
    roundTo(node.paddingLeft, SPACE_ROUND),
  ].join(",");
}

function hasSolidFill(node: SceneNode): boolean {
  if (!("fills" in node)) return false;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return false;
  return fills.some((p) => p.visible !== false && p.type === "SOLID");
}

function hasCornerRadius(node: SceneNode): boolean {
  if (!("cornerRadius" in node)) return false;
  const r = node.cornerRadius;
  if (r === figma.mixed) return true;
  return typeof r === "number" && r > 0;
}

function walkFingerprint(
  node: SceneNode,
  depth: number,
  types: string[],
  counts: Map<string, number>
): { hasText: boolean; textLen: number } {
  // Groups are layout-only wrappers — skip so Group+Vector matches bare Vector
  if (node.type === "GROUP") {
    let hasText = false;
    let textLen = 0;
    if (depth < FINGERPRINT_DEPTH && "children" in node) {
      for (const child of node.children) {
        const nested = walkFingerprint(child, depth + 1, types, counts);
        hasText = hasText || nested.hasText;
        textLen += nested.textLen;
      }
    }
    return { hasText, textLen };
  }

  const key = typeKey(node);
  counts.set(key, (counts.get(key) || 0) + 1);
  types.push(key);

  let hasText = node.type === "TEXT";
  let textLen = node.type === "TEXT" && "characters" in node ? node.characters.length : 0;

  // Shape / icon-instance leaves: don't recurse into boolean ops or icon guts
  if (isShapeLeaf(node) || depth >= FINGERPRINT_DEPTH || !("children" in node)) {
    return { hasText, textLen };
  }

  for (const child of node.children) {
    const nested = walkFingerprint(child, depth + 1, types, counts);
    hasText = hasText || nested.hasText;
    textLen += nested.textLen;
  }
  return { hasText, textLen };
}

function fingerprint(node: SceneNode): Fingerprint {
  const types: string[] = [];
  const counts = new Map<string, number>();
  const text = walkFingerprint(node, 0, types, counts);

  const layoutMode =
    isContainer(node) && node.type !== "COMPONENT_SET" && "layoutMode" in node
      ? node.layoutMode
      : "NONE";
  const itemSpacing =
    isContainer(node) &&
    node.type !== "COMPONENT_SET" &&
    "itemSpacing" in node &&
    layoutMode !== "NONE"
      ? roundTo(node.itemSpacing, SPACE_ROUND)
      : 0;
  const paddingKey =
    isContainer(node) && node.type !== "COMPONENT_SET"
      ? layoutPaddingKey(node)
      : "none";

  const countKey = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${t}:${n}`)
    .join("|");

  return {
    childCount: "children" in node ? node.children.length : 0,
    width: roundTo(node.width, SIZE_ROUND),
    height: roundTo(node.height, SIZE_ROUND),
    layoutMode,
    paddingKey,
    itemSpacing,
    typeCounts: countKey,
    typePath: types.join(">"),
    hasText: text.hasText,
    textLenBucket: roundTo(text.textLen, 8),
    hasRadius: hasCornerRadius(node),
    hasFill: hasSolidFill(node),
  };
}

/** Exported for componentMatch.check.ts */
export function scorePair(a: Fingerprint, b: Fingerprint): number {
  let score = 0;
  let weight = 0;

  const add = (w: number, ok: boolean) => {
    weight += w;
    if (ok) score += w;
  };

  const exactSize = a.width === b.width && a.height === b.height;
  const nearSize =
    !exactSize &&
    Math.abs(a.width - b.width) <= SIZE_ROUND * 2 &&
    Math.abs(a.height - b.height) <= SIZE_ROUND * 2;

  add(0.22, a.typeCounts === b.typeCounts);
  add(0.14, a.typePath === b.typePath);
  add(0.12, a.childCount === b.childCount);
  add(0.12, exactSize);
  add(0.08, nearSize);
  add(0.1, a.layoutMode === b.layoutMode);
  add(0.08, a.paddingKey === b.paddingKey);
  add(0.06, a.itemSpacing === b.itemSpacing);
  add(0.04, a.hasText === b.hasText);
  add(0.02, a.textLenBucket === b.textLenBucket);
  add(0.01, a.hasRadius === b.hasRadius);
  add(0.01, a.hasFill === b.hasFill);

  return weight === 0 ? 0 : score / weight;
}

type CatalogEntry = { component: ComponentNode; fp: Fingerprint };

/** Shared across matchSelection + lintDetached within one pass. */
let passCatalog: CatalogEntry[] | null = null;
const previewCache = new Map<string, string>();
const PREVIEW_WIDTH = 280;

export function beginComponentPass(): void {
  passCatalog = null;
  previewCache.clear();
}

async function exportComponentPreview(componentId: string): Promise<string | undefined> {
  const cached = previewCache.get(componentId);
  if (cached) return cached;
  const node = await figma.getNodeByIdAsync(componentId);
  if (!node || node.type !== "COMPONENT") return undefined;
  try {
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "WIDTH", value: PREVIEW_WIDTH },
    });
    const dataUrl = "data:image/png;base64," + figma.base64Encode(bytes);
    previewCache.set(componentId, dataUrl);
    return dataUrl;
  } catch {
    return undefined;
  }
}

/** Attach cached PNG data-URL previews to unique candidate ids. */
export async function attachCandidatePreviews(
  matches: ComponentMatch[]
): Promise<ComponentMatch[]> {
  const ids = new Set<string>();
  for (const match of matches) {
    for (const c of match.candidates) ids.add(c.componentId);
  }
  await Promise.all([...ids].map((id) => exportComponentPreview(id)));
  return matches.map((match) => ({
    ...match,
    candidates: match.candidates.map((c) => {
      const preview = previewCache.get(c.componentId);
      return preview ? { ...c, preview } : { ...c };
    }),
  }));
}

function getPassCatalog(): CatalogEntry[] {
  if (!passCatalog) {
    const nodes = figma.root.findAllWithCriteria({ types: ["COMPONENT"] });
    passCatalog = nodes.map((component) => ({ component, fp: fingerprint(component) }));
  }
  return passCatalog;
}

function catalogEntries(excludeIds: Set<string>): CatalogEntry[] {
  return getPassCatalog().filter((e) => !excludeIds.has(e.component.id));
}

function collectFromFrame(root: FrameNode, out: FrameNode[], seen: Set<string>): void {
  const stack: Array<{ node: SceneNode; depth: number }> = [{ node: root, depth: 0 }];

  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > MATCH_COLLECT_DEPTH) continue;

    if (node.type === "FRAME") {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        out.push(node);
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], depth: depth + 1 });
      }
      continue;
    }

    // Do not descend into instances or component masters
    if (
      node.type === "INSTANCE" ||
      node.type === "COMPONENT" ||
      node.type === "COMPONENT_SET"
    ) {
      continue;
    }

    if ("children" in node && depth < MATCH_COLLECT_DEPTH) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], depth: depth + 1 });
      }
    }
  }
}

function collectFrameTargets(selection: readonly SceneNode[]): FrameNode[] {
  const out: FrameNode[] = [];
  const seen = new Set<string>();
  for (const node of selection) {
    if (node.type === "FRAME") {
      collectFromFrame(node, out, seen);
    }
  }
  return out;
}

function rankAgainstCatalog(
  target: FrameNode,
  cached: Array<{ component: ComponentNode; fp: Fingerprint }>
): ComponentCandidate[] {
  const targetFp = fingerprint(target);
  return cached
    .map(({ component, fp }) => ({
      componentId: component.id,
      name: component.name,
      score: scorePair(targetFp, fp),
    }))
    .filter((c) => c.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);
}

export function matchSelection(selection: readonly SceneNode[]): ComponentMatch[] {
  const targets = collectFrameTargets(selection);
  if (!targets.length) return [];

  const exclude = new Set(targets.map((t) => t.id));
  const cached = catalogEntries(exclude);

  const matches: ComponentMatch[] = [];
  for (const target of targets) {
    const ranked = rankAgainstCatalog(target, cached);
    if (!ranked.length) continue;
    matches.push({
      nodeId: target.id,
      nodeName: target.name,
      candidates: ranked,
    });
  }
  return matches;
}

/** Frames that look like detached component instances. */
export async function lintDetached(root: SceneNode): Promise<LintResult> {
  const frames: FrameNode[] = [];
  const seen = new Set<string>();
  if (root.type === "FRAME") {
    collectFromFrame(root, frames, seen);
  } else if ("children" in root) {
    for (const child of root.children) {
      if (child.type === "FRAME") collectFromFrame(child, frames, seen);
    }
  }

  if (!frames.length) {
    return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
  }

  const exclude = new Set(frames.map((f) => f.id));
  const cached = catalogEntries(exclude);
  if (!cached.length) {
    return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: frames.length };
  }
  const issues: LintIssue[] = [];

  for (const frame of frames) {
    if (frame.id === root.id) continue;
    const ranked = rankAgainstCatalog(frame, cached);
    if (!ranked.length) continue;
    const best = ranked[0];
    issues.push({
      kind: "detached-instance",
      nodeId: frame.id,
      nodeName: frame.name || "Untitled",
      field: "component",
      valueLabel: `${best.name} · ${Math.round(best.score * 100)}%`,
      tokenName: best.name,
      variableId: null,
    });
  }

  return {
    issues,
    fixableCount: 0,
    tokenCount: cached.length,
    checkedCount: Math.max(0, frames.length - (root.type === "FRAME" ? 1 : 0)),
  };
}

// shortcut: no override map, add when designers need text/state carry-over
export async function replaceWithComponent(item: ReplaceItem): Promise<boolean> {
  const node = await figma.getNodeByIdAsync(item.nodeId);
  const component = await figma.getNodeByIdAsync(item.componentId);

  if (!node || node.type !== "FRAME") return false;
  if (!component || component.type !== "COMPONENT") return false;

  const parent = node.parent;
  if (!parent || !("children" in parent)) return false;

  const index = parent.children.indexOf(node);
  if (index < 0) return false;

  const x = node.x;
  const y = node.y;
  const w = node.width;
  const h = node.height;

  const instance = component.createInstance();
  parent.insertChild(index, instance);
  instance.x = x;
  instance.y = y;
  try {
    instance.resize(w, h);
  } catch {
    // some instances lock size; keep default
  }

  node.remove();
  return true;
}

export async function replaceWithComponents(items: ReplaceItem[]): Promise<number> {
  let done = 0;
  for (const item of items) {
    if (await replaceWithComponent(item)) done += 1;
  }
  return done;
}
