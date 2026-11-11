import { floatMatchFields, floatTokensFor, hasFloatScope, type TokenIndex } from "./tokens";
import { isIssueFixable, type LintIssue, type LintResult } from "./types";
import { asScene, collect, isBlendNode, type BlendNode } from "./walk";

function isBound(node: BlendNode): boolean {
  return node.boundVariables?.opacity !== undefined;
}

const OPACITY_SCOPE: VariableScope[] = ["OPACITY"];

export async function lintOpacity(
  root: SceneNode,
  tokens: TokenIndex,
  nodesIn?: BlendNode[]
): Promise<LintResult> {
  if (!hasFloatScope(tokens, OPACITY_SCOPE)) {
    return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
  }
  const nodes = nodesIn ?? collect(root, isBlendNode);
  const issues: LintIssue[] = [];
  let checkedCount = 0;

  for (const node of nodes) {
    if (typeof node.opacity !== "number") continue;
    if (node.opacity >= 0.999) continue;
    checkedCount++;
    if (isBound(node)) continue;

    const pool = floatTokensFor(tokens, node, OPACITY_SCOPE);
    const match = floatMatchFields(pool, node.opacity, 0.02);
    issues.push({
      kind: "opacity",
      nodeId: node.id,
      nodeName: node.name || "Untitled",
      field: "opacity",
      bindField: "opacity",
      valueLabel: String(Math.round(node.opacity * 1000) / 1000),
      tokenName: match.tokenName,
      variableId: match.variableId,
      matchQuality: match.matchQuality,
      tokenCandidates: match.tokenCandidates,
    });
  }

  return {
    issues,
    fixableCount: issues.filter(isIssueFixable).length,
    tokenCount: tokens.floats.length,
    checkedCount,
  };
}

export async function applyOpacityTokens(issues: LintIssue[]): Promise<number> {
  let fixed = 0;
  for (const issue of issues) {
    if (issue.kind !== "opacity" || !issue.variableId) continue;
    const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
    if (!node || !isBlendNode(node) || isBound(node)) continue;

    const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
    if (!variable) continue;

    try {
      node.setBoundVariable("opacity", variable);
      fixed++;
    } catch {
      // skip
    }
  }
  return fixed;
}
