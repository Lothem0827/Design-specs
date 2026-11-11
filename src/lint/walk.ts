import { MAX_NEST_DEPTH, MAX_WALK_NODES } from "../theme";

export type AutoLayoutNode = FrameNode | ComponentNode | InstanceNode;
export type RadiusNode = SceneNode & CornerMixin & RectangleCornerMixin;
export type StrokeNode = SceneNode & MinimalStrokesMixin;
export type GeometryNode = SceneNode & MinimalFillsMixin;
export type BlendNode = SceneNode & BlendMixin;
export type EffectNode = SceneNode & BlendMixin;

export function isAutoLayout(node: SceneNode): node is AutoLayoutNode {
  return (
    (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") &&
    "layoutMode" in node &&
    node.layoutMode !== "NONE"
  );
}

/** Figma UI gap "Auto" → space distribution, not a fixed token value. */
export function isPrimaryGapAuto(node: AutoLayoutNode): boolean {
  const align = node.primaryAxisAlignItems;
  return (
    align === "SPACE_BETWEEN" || align === "SPACE_EVENLY" || align === "SPACE_AROUND"
  );
}

export function isCounterGapAuto(node: AutoLayoutNode): boolean {
  return node.layoutWrap === "WRAP" && node.counterAxisAlignContent === "SPACE_BETWEEN";
}

export function isRadiusNode(node: SceneNode): node is RadiusNode {
  return "topLeftRadius" in node && "cornerRadius" in node;
}

export function asScene(node: BaseNode | null): SceneNode | null {
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") return null;
  return node as SceneNode;
}

export function isStrokeNode(node: SceneNode): node is StrokeNode {
  return "strokes" in node && "strokeWeight" in node;
}

export function isGeometryNode(node: SceneNode): node is GeometryNode {
  return "fills" in node;
}

export function isBlendNode(node: SceneNode): node is BlendNode {
  return "opacity" in node;
}

export function isEffectNode(node: SceneNode): node is EffectNode {
  return "effects" in node;
}

export function walkTree(
  node: SceneNode,
  depth: number,
  maxDepth: number,
  visit: (n: SceneNode) => void,
  budget: { n: number } = { n: 0 }
): void {
  if (depth > maxDepth || budget.n >= MAX_WALK_NODES) return;
  if (node.visible === false) return;
  budget.n++;
  visit(node);
  if ("children" in node) {
    for (const child of node.children) {
      walkTree(child, depth + 1, maxDepth, visit, budget);
    }
  }
}

export function collect<T extends SceneNode>(
  root: SceneNode,
  pred: (n: SceneNode) => n is T,
  maxDepth = MAX_NEST_DEPTH
): T[] {
  const out: T[] = [];
  const budget = { n: 0 };
  walkTree(root, 0, maxDepth, (n) => {
    if (pred(n)) out.push(n);
  }, budget);
  return out;
}
