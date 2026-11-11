import { loadPaintStyles, matchPaintStyles, paintRole, rankPaintStyles } from "./styleMatch";
import {
  colorMatchFields,
  colorTokensFor,
  fillScopes,
  hasColorScope,
  rgbLabel,
  type TokenIndex,
} from "./tokens";
import { isIssueFixable, type LintIssue, type LintResult } from "./types";
import { asScene, collect, isGeometryNode, type GeometryNode } from "./walk";

export type StyleApplySelection = {
  nodeId: string;
  paintIndex?: number;
  styleId?: string | null;
  issueId?: string;
  variableId?: string | null;
};

function hasFillStyle(node: GeometryNode): boolean {
  const id = node.fillStyleId as string | typeof figma.mixed;
  if (id === figma.mixed) return true;
  return typeof id === "string" && id !== "";
}

function isFillColorBound(node: GeometryNode, paintIndex: number): boolean {
  const fillsAlias = node.boundVariables?.fills;
  if (fillsAlias && fillsAlias[paintIndex]) return true;
  const paint = Array.isArray(node.fills) ? node.fills[paintIndex] : null;
  if (paint && "boundVariables" in paint && paint.boundVariables?.color) return true;
  return false;
}

export async function lintColor(
  root: SceneNode,
  tokens: TokenIndex,
  nodesIn?: GeometryNode[],
  paintStylesIn?: PaintStyle[]
): Promise<LintResult> {
  const paintStyles = paintStylesIn ?? (await loadPaintStyles());
  const nodes = nodesIn ?? collect(root, isGeometryNode);
  const issues: LintIssue[] = [];
  let checkedCount = 0;

  for (const node of nodes) {
    if (!Array.isArray(node.fills)) continue;
    const allowed = fillScopes(node);
    const scoped = hasColorScope(tokens, allowed);
    const pool = scoped ? colorTokensFor(tokens, node, allowed) : [];
    const styled = hasFillStyle(node);

    for (let i = 0; i < node.fills.length; i++) {
      const paint = node.fills[i];
      if (paint.type !== "SOLID" || paint.visible === false) continue;
      checkedCount++;
      if (styled || isFillColorBound(node, i)) continue;

      const styles = rankPaintStyles(matchPaintStyles(paintStyles, paint.color), paintRole(node));
      if (styles.length > 0) {
        issues.push({
          kind: "color-fill",
          nodeId: node.id,
          nodeName: node.name || "Untitled",
          field: node.type === "TEXT" ? "text fill" : "fill",
          valueLabel: rgbLabel(paint.color),
          tokenName: null,
          variableId: null,
          paintIndex: i,
          styleCandidates: styles,
        });
        continue;
      }

      if (!scoped) continue;

      const match = colorMatchFields(pool, paint.color);
      issues.push({
        kind: "color-fill",
        nodeId: node.id,
        nodeName: node.name || "Untitled",
        field: node.type === "TEXT" ? "text fill" : "fill",
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
    tokenCount: paintStyles.length + tokens.colors.length,
    checkedCount,
  };
}

export async function applyColorTokens(
  issues: LintIssue[],
  selections: StyleApplySelection[] = []
): Promise<number> {
  let fixed = 0;
  const selectMap = new Map(
    selections.map((s) => [`${s.nodeId}:${s.paintIndex ?? 0}`, s.styleId || null])
  );

  for (const issue of issues) {
    if (issue.kind !== "color-fill") continue;
    const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
    if (!node || !isGeometryNode(node)) continue;

    const index = issue.paintIndex ?? 0;
    const key = `${issue.nodeId}:${index}`;
    const picked =
      selectMap.get(key) ??
      (issue.styleCandidates && issue.styleCandidates.length > 0
        ? issue.styleCandidates[0].id
        : null);

    try {
      if (picked) {
        if (hasFillStyle(node)) continue;
        node.fillStyleId = picked;
        fixed++;
        continue;
      }

      if (!issue.variableId || !Array.isArray(node.fills)) continue;
      if (isFillColorBound(node, index)) continue;
      const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
      if (!variable) continue;
      const paints = node.fills.slice();
      const paint = paints[index];
      if (!paint || paint.type !== "SOLID") continue;
      paints[index] = figma.variables.setBoundVariableForPaint(paint, "color", variable);
      node.fills = paints;
      fixed++;
    } catch {
      // skip
    }
  }
  return fixed;
}
