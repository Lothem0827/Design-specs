import type { StyleApplySelection } from "./color";
import { loadPaintStyles, matchPaintStyles, paintRole, rankPaintStyles } from "./styleMatch";
import {
  colorMatchFields,
  colorTokensFor,
  floatMatchFields,
  floatTokensFor,
  hasColorScope,
  hasFloatScope,
  rgbLabel,
  type TokenIndex,
} from "./tokens";
import { isIssueFixable, type LintIssue, type LintResult } from "./types";
import { asScene, collect, isStrokeNode, type StrokeNode } from "./walk";

function isWeightBound(node: StrokeNode): boolean {
  const bound = node.boundVariables;
  if (!bound) return false;
  return (
    bound.strokeWeight !== undefined ||
    bound.strokeTopWeight !== undefined ||
    bound.strokeRightWeight !== undefined ||
    bound.strokeBottomWeight !== undefined ||
    bound.strokeLeftWeight !== undefined
  );
}

function hasStrokeStyle(node: StrokeNode): boolean {
  return typeof node.strokeStyleId === "string" && node.strokeStyleId !== "";
}

function isColorBound(node: StrokeNode, paintIndex: number): boolean {
  const strokesAlias = node.boundVariables?.strokes;
  if (strokesAlias && strokesAlias[paintIndex]) return true;
  const paint = node.strokes[paintIndex];
  if (paint && "boundVariables" in paint && paint.boundVariables?.color) return true;
  return false;
}

const WEIGHT_SCOPE: VariableScope[] = ["STROKE_FLOAT"];
const STROKE_COLOR_SCOPE: VariableScope[] = ["STROKE_COLOR"];

export async function lintStroke(
  root: SceneNode,
  tokens: TokenIndex,
  nodesIn?: StrokeNode[],
  paintStylesIn?: PaintStyle[]
): Promise<LintResult> {
  const paintStyles = paintStylesIn ?? (await loadPaintStyles());
  const weightTokens = hasFloatScope(tokens, WEIGHT_SCOPE);
  const colorTokens = hasColorScope(tokens, STROKE_COLOR_SCOPE);
  const nodes = nodesIn ?? collect(root, isStrokeNode);
  const issues: LintIssue[] = [];
  let checkedCount = 0;

  for (const node of nodes) {
    const strokes = node.strokes || [];
    if (strokes.length === 0) continue;

    const weight = typeof node.strokeWeight === "number" ? node.strokeWeight : 0;
    if (weight > 0 && weightTokens) {
      checkedCount++;
      if (!isWeightBound(node)) {
        const match = floatMatchFields(floatTokensFor(tokens, node, WEIGHT_SCOPE), weight);
        issues.push({
          kind: "stroke-weight",
          nodeId: node.id,
          nodeName: node.name || "Untitled",
          field: "stroke weight",
          bindField: "strokeWeight",
          valueLabel: String(Math.round(weight * 100) / 100),
          tokenName: match.tokenName,
          variableId: match.variableId,
          matchQuality: match.matchQuality,
          tokenCandidates: match.tokenCandidates,
        });
      }
    }

    const styled = hasStrokeStyle(node);

    for (let i = 0; i < strokes.length; i++) {
      const paint = strokes[i];
      if (paint.type !== "SOLID" || paint.visible === false) continue;
      checkedCount++;
      if (styled || isColorBound(node, i)) continue;

      const styles = rankPaintStyles(matchPaintStyles(paintStyles, paint.color), paintRole(node));
      if (styles.length > 0) {
        issues.push({
          kind: "stroke-color",
          nodeId: node.id,
          nodeName: node.name || "Untitled",
          field: "stroke color",
          valueLabel: rgbLabel(paint.color),
          tokenName: null,
          variableId: null,
          paintIndex: i,
          styleCandidates: styles,
        });
        continue;
      }

      if (!colorTokens) continue;

      const match = colorMatchFields(colorTokensFor(tokens, node, STROKE_COLOR_SCOPE), paint.color);
      issues.push({
        kind: "stroke-color",
        nodeId: node.id,
        nodeName: node.name || "Untitled",
        field: "stroke color",
        valueLabel: rgbLabel(paint.color),
        tokenName: match.tokenName,
        variableId: match.variableId,
        matchQuality: match.matchQuality,
        paintIndex: i,
        tokenCandidates: match.tokenCandidates,
      });
    }
  }

  return {
    issues,
    fixableCount: issues.filter(isIssueFixable).length,
    tokenCount: paintStyles.length + tokens.floats.length + tokens.colors.length,
    checkedCount,
  };
}

export async function applyStrokeTokens(
  issues: LintIssue[],
  selections: StyleApplySelection[] = []
): Promise<number> {
  let fixed = 0;
  const selectMap = new Map(
    selections.map((s) => [`${s.nodeId}:${s.paintIndex ?? 0}`, s.styleId || null])
  );

  for (const issue of issues) {
    if (issue.kind !== "stroke-weight" && issue.kind !== "stroke-color") continue;
    const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
    if (!node || !isStrokeNode(node)) continue;

    try {
      if (issue.kind === "stroke-weight") {
        if (!issue.variableId || isWeightBound(node)) continue;
        const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
        if (!variable) continue;
        node.setBoundVariable("strokeWeight", variable);
        fixed++;
        continue;
      }

      const index = issue.paintIndex ?? 0;
      const key = `${issue.nodeId}:${index}`;
      const picked =
        selectMap.get(key) ??
        (issue.styleCandidates && issue.styleCandidates.length > 0
          ? issue.styleCandidates[0].id
          : null);

      if (picked) {
        if (hasStrokeStyle(node)) continue;
        node.strokeStyleId = picked;
        fixed++;
        continue;
      }

      if (!issue.variableId || isColorBound(node, index)) continue;
      const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
      if (!variable) continue;
      const paints = node.strokes.slice();
      const paint = paints[index];
      if (!paint || paint.type !== "SOLID") continue;
      paints[index] = figma.variables.setBoundVariableForPaint(paint, "color", variable);
      node.strokes = paints;
      fixed++;
    } catch {
      // skip
    }
  }
  return fixed;
}
