import { MAX_NEST_DEPTH } from "../theme";
import {
  isAutoLayout,
  isBlendNode,
  isEffectNode,
  isGeometryNode,
  isRadiusNode,
  isStrokeNode,
  walkTree,
  type AutoLayoutNode,
  type BlendNode,
  type EffectNode,
  type GeometryNode,
  type RadiusNode,
  type StrokeNode,
} from "./walk";

export type LayoutContainer = FrameNode | ComponentNode | InstanceNode;

export type LintScan = {
  autoLayout: AutoLayoutNode[];
  radius: RadiusNode[];
  geometry: GeometryNode[];
  text: TextNode[];
  blend: BlendNode[];
  effect: EffectNode[];
  stroke: StrokeNode[];
  layoutContainers: LayoutContainer[];
};

function isLayoutContainer(node: SceneNode): node is LayoutContainer {
  return (
    (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") &&
    "layoutMode" in node
  );
}

/** One tree walk → buckets for all linters (single MAX_WALK_NODES budget). */
export function scanLintTree(root: SceneNode): LintScan {
  const scan: LintScan = {
    autoLayout: [],
    radius: [],
    geometry: [],
    text: [],
    blend: [],
    effect: [],
    stroke: [],
    layoutContainers: [],
  };
  const budget = { n: 0 };
  walkTree(
    root,
    0,
    MAX_NEST_DEPTH,
    (n) => {
      if (isAutoLayout(n)) scan.autoLayout.push(n);
      if (isRadiusNode(n)) scan.radius.push(n);
      if (isGeometryNode(n)) scan.geometry.push(n);
      if (n.type === "TEXT") scan.text.push(n);
      if (isBlendNode(n)) scan.blend.push(n);
      if (isEffectNode(n)) scan.effect.push(n);
      if (isStrokeNode(n)) scan.stroke.push(n);
      if (isLayoutContainer(n)) scan.layoutContainers.push(n);
    },
    budget
  );
  return scan;
}
