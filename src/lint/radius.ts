import { floatMatchFields, floatTokensFor, hasFloatScope, type TokenIndex } from "./tokens";
import { isIssueFixable, type LintIssue, type LintResult } from "./types";
import { asScene, collect, isRadiusNode, type RadiusNode } from "./walk";

function isBound(node: RadiusNode, field: VariableBindableNodeField): boolean {
  const bound = node.boundVariables;
  if (!bound) return false;
  if (field === "cornerRadius") {
    return (
      bound.cornerRadius !== undefined ||
      (bound.topLeftRadius !== undefined &&
        bound.topRightRadius !== undefined &&
        bound.bottomLeftRadius !== undefined &&
        bound.bottomRightRadius !== undefined)
    );
  }
  return bound[field as keyof typeof bound] !== undefined;
}

function collectRadiusFields(
  node: RadiusNode
): Array<{ field: VariableBindableNodeField; label: string; value: number }> {
  const out: Array<{ field: VariableBindableNodeField; label: string; value: number }> = [];
  const cr = node.cornerRadius;

  if (typeof cr === "number") {
    if (cr > 0) out.push({ field: "cornerRadius", label: "corner radius", value: cr });
    return out;
  }

  const corners: Array<[VariableBindableNodeField, string, number]> = [
    ["topLeftRadius", "radius TL", node.topLeftRadius],
    ["topRightRadius", "radius TR", node.topRightRadius],
    ["bottomLeftRadius", "radius BL", node.bottomLeftRadius],
    ["bottomRightRadius", "radius BR", node.bottomRightRadius],
  ];
  for (const [field, label, value] of corners) {
    if (typeof value === "number" && value > 0) out.push({ field, label, value });
  }
  return out;
}

const RADIUS_SCOPE: VariableScope[] = ["CORNER_RADIUS"];

export async function lintBorder(
  root: SceneNode,
  tokens: TokenIndex,
  nodesIn?: RadiusNode[]
): Promise<LintResult> {
  if (!hasFloatScope(tokens, RADIUS_SCOPE)) {
    return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
  }
  const nodes = nodesIn ?? collect(root, isRadiusNode);
  const issues: LintIssue[] = [];
  let checkedCount = 0;

  for (const node of nodes) {
    const pool = floatTokensFor(tokens, node, RADIUS_SCOPE);
    for (const corner of collectRadiusFields(node)) {
      checkedCount++;
      if (isBound(node, corner.field)) continue;
      const match = floatMatchFields(pool, corner.value);
      issues.push({
        kind: "border-radius",
        nodeId: node.id,
        nodeName: node.name || "Untitled",
        field: corner.label,
        bindField: corner.field,
        valueLabel: String(Math.round(corner.value * 100) / 100),
        tokenName: match.tokenName,
        variableId: match.variableId,
        matchQuality: match.matchQuality,
        tokenCandidates: match.tokenCandidates,
      });
    }
  }

  return {
    issues,
    fixableCount: issues.filter(isIssueFixable).length,
    tokenCount: tokens.floats.length,
    checkedCount,
  };
}

export async function applyBorderTokens(issues: LintIssue[]): Promise<number> {
  let fixed = 0;
  for (const issue of issues) {
    if (!issue.variableId || issue.kind !== "border-radius" || !issue.bindField) continue;

    const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
    if (!node || !isRadiusNode(node)) continue;
    if (isBound(node, issue.bindField as VariableBindableNodeField)) continue;

    const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
    if (!variable) continue;

    try {
      if (issue.bindField === "cornerRadius") {
        node.setBoundVariable("topLeftRadius", variable);
        node.setBoundVariable("topRightRadius", variable);
        node.setBoundVariable("bottomLeftRadius", variable);
        node.setBoundVariable("bottomRightRadius", variable);
      } else {
        node.setBoundVariable(issue.bindField as VariableBindableNodeField, variable);
      }
      fixed++;
    } catch {
      // skip
    }
  }
  return fixed;
}
