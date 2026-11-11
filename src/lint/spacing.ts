import {
  floatMatchFields,
  floatTokensFor,
  hasFloatScope,
  scopeMatches,
  type TokenIndex,
} from "./tokens";
import { isIssueFixable, type LintIssue, type LintResult } from "./types";
import {
  asScene,
  collect,
  isAutoLayout,
  isCounterGapAuto,
  isPrimaryGapAuto,
  type AutoLayoutNode,
} from "./walk";

export type SpacingField =
  | "paddingTop"
  | "paddingRight"
  | "paddingBottom"
  | "paddingLeft"
  | "itemSpacing"
  | "counterAxisSpacing";

const SPACING_FIELDS: SpacingField[] = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "itemSpacing",
  "counterAxisSpacing",
];

const GAP_SCOPE: VariableScope[] = ["GAP"];

const LABEL: Record<SpacingField, string> = {
  paddingTop: "padding top",
  paddingRight: "padding right",
  paddingBottom: "padding bottom",
  paddingLeft: "padding left",
  itemSpacing: "gap",
  counterAxisSpacing: "counter gap",
};

const FROM_LABEL: Record<string, SpacingField> = {
  "padding top": "paddingTop",
  "padding right": "paddingRight",
  "padding bottom": "paddingBottom",
  "padding left": "paddingLeft",
  gap: "itemSpacing",
  "counter gap": "counterAxisSpacing",
};

function isBound(node: AutoLayoutNode, field: SpacingField): boolean {
  return node.boundVariables?.[field] !== undefined;
}

function isAutoGap(node: AutoLayoutNode, field: SpacingField): boolean {
  if (field === "itemSpacing") return isPrimaryGapAuto(node);
  if (field === "counterAxisSpacing") return isCounterGapAuto(node);
  return false;
}

export async function lintSpacing(
  root: SceneNode,
  tokens: TokenIndex,
  nodesIn?: AutoLayoutNode[]
): Promise<LintResult> {
  if (!hasFloatScope(tokens, GAP_SCOPE)) {
    return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
  }
  const nodes = nodesIn ?? collect(root, isAutoLayout);
  const issues: LintIssue[] = [];
  let checkedCount = 0;

  for (const node of nodes) {
    const pool = floatTokensFor(tokens, node, GAP_SCOPE);
    for (const field of SPACING_FIELDS) {
      const value = node[field];
      if (value == null || value <= 0) continue;
      // counter gap only applies to wrap layouts
      if (field === "counterAxisSpacing" && node.layoutWrap !== "WRAP") continue;
      if (isAutoGap(node, field)) continue;
      checkedCount++;
      if (isBound(node, field)) continue;

      const match = floatMatchFields(pool, value);
      issues.push({
        kind: "spacing",
        nodeId: node.id,
        nodeName: node.name || "Untitled",
        field: LABEL[field],
        bindField: field,
        valueLabel: String(Math.round(value * 100) / 100),
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
    tokenCount: tokens.floats.filter((item) => scopeMatches(item.scopes, GAP_SCOPE)).length,
    checkedCount,
  };
}

export async function applySpacingTokens(issues: LintIssue[]): Promise<number> {
  let fixed = 0;
  for (const issue of issues) {
    if (issue.kind !== "spacing" || !issue.variableId) continue;
    const field = issue.bindField
      ? (issue.bindField as SpacingField)
      : FROM_LABEL[issue.field];
    if (!field) continue;

    const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
    if (!node || !isAutoLayout(node) || isBound(node, field)) continue;

    const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
    if (!variable) continue;

    try {
      node.setBoundVariable(field, variable);
      fixed++;
    } catch {
      // skip
    }
  }
  return fixed;
}
