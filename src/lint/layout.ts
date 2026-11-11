import type { LayoutContainer } from "./scan";
import type { LintIssue, LintResult } from "./types";
import { collect, isAutoLayout } from "./walk";

function isLayoutContainer(node: SceneNode): node is LayoutContainer {
  return (
    (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") &&
    "layoutMode" in node
  );
}

function visibleChildCount(node: LayoutContainer): number {
  return node.children.filter((c) => c.visible !== false).length;
}

function parentIsAutoLayout(node: LayoutContainer): boolean {
  const parent = node.parent;
  if (!parent || parent.type === "PAGE" || parent.type === "DOCUMENT") return false;
  return isAutoLayout(parent as SceneNode);
}

function isFixedBothAxes(node: LayoutContainer): boolean {
  return (
    "layoutSizingHorizontal" in node &&
    "layoutSizingVertical" in node &&
    node.layoutSizingHorizontal === "FIXED" &&
    node.layoutSizingVertical === "FIXED"
  );
}

export async function lintLayout(
  root: SceneNode,
  nodesIn?: LayoutContainer[]
): Promise<LintResult> {
  // Parent/root: AL + fixed W×H is fine. Only lint subframes when root is AL.
  if (!isLayoutContainer(root) || !isAutoLayout(root)) {
    return { issues: [], fixableCount: 0, tokenCount: 0 };
  }

  const nodes = nodesIn ?? collect(root, isLayoutContainer);
  const issues: LintIssue[] = [];

  for (const node of nodes) {
    if (node.id === root.id) continue;

    const kids = visibleChildCount(node);

    if (node.layoutMode === "NONE" && kids >= 2) {
      const nested = parentIsAutoLayout(node);
      issues.push({
        kind: nested ? "layout-nested-no-autolayout" : "layout-no-autolayout",
        nodeId: node.id,
        nodeName: node.name,
        field: nested ? "nested layout" : "layout",
        valueLabel: "NONE",
        tokenName: null,
        variableId: null,
      });
    }

    if (kids >= 1 && isFixedBothAxes(node)) {
      issues.push({
        kind: "layout-fixed-size",
        nodeId: node.id,
        nodeName: node.name,
        field: "size",
        valueLabel: "FIXED × FIXED",
        tokenName: null,
        variableId: null,
      });
    }
  }

  return { issues, fixableCount: 0, tokenCount: 0 };
}
