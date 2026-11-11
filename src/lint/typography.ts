import type { StyleApplySelection } from "./color";
import { loadTextStyles, matchTextStyles } from "./styleMatch";
import {
  floatMatchFields,
  floatTokensFor,
  hasFloatScope,
  hasStringScope,
  matchStringToken,
  stringTokensFor,
  type TokenIndex,
} from "./tokens";
import { isIssueFixable, type LintIssue, type LintResult } from "./types";
import { asScene, collect } from "./walk";

function isText(node: SceneNode): node is TextNode {
  return node.type === "TEXT";
}

function hasTextStyle(node: TextNode): boolean {
  const id = node.textStyleId;
  if (id === figma.mixed) return true;
  return typeof id === "string" && id !== "";
}

function isTextFieldBound(node: TextNode, field: VariableBindableTextField): boolean {
  const bound = node.boundVariables?.[field];
  return Array.isArray(bound) ? bound.length > 0 : bound !== undefined;
}

function lineHeightPx(node: TextNode): number | null {
  const lh = node.lineHeight;
  if (lh === figma.mixed) return null;
  if (lh.unit === "PIXELS") return lh.value;
  return null;
}

function letterSpacingPx(node: TextNode): number | null {
  const ls = node.letterSpacing;
  if (ls === figma.mixed) return null;
  if (ls.unit === "PIXELS") return ls.value;
  return null;
}

function pushFloat(
  issues: LintIssue[],
  tokens: TokenIndex,
  node: TextNode,
  scope: VariableScope,
  field: string,
  bindField: VariableBindableTextField,
  value: number,
  maxDelta?: number
): void {
  if (!hasFloatScope(tokens, [scope])) return;
  const match = floatMatchFields(floatTokensFor(tokens, node, [scope]), value, maxDelta);
  issues.push({
    kind: "typography",
    nodeId: node.id,
    nodeName: node.name || "Untitled",
    field,
    bindField,
    valueLabel: String(value),
    tokenName: match.tokenName,
    variableId: match.variableId,
    matchQuality: match.matchQuality,
    tokenCandidates: match.tokenCandidates,
  });
}

function pushString(
  issues: LintIssue[],
  tokens: TokenIndex,
  node: TextNode,
  scope: VariableScope,
  field: string,
  bindField: VariableBindableTextField,
  value: string
): void {
  if (!hasStringScope(tokens, [scope])) return;
  const token = matchStringToken(stringTokensFor(tokens, node, [scope]), value);
  issues.push({
    kind: "typography",
    nodeId: node.id,
    nodeName: node.name || "Untitled",
    field,
    bindField,
    valueLabel: value,
    tokenName: token?.name ?? null,
    variableId: token?.id ?? null,
    matchQuality: token ? "exact" : null,
  });
}

export async function lintTypography(
  root: SceneNode,
  tokens: TokenIndex,
  nodesIn?: TextNode[],
  textStylesIn?: TextStyle[]
): Promise<LintResult> {
  const textStyles = textStylesIn ?? (await loadTextStyles());
  const nodes = nodesIn ?? collect(root, isText);
  const issues: LintIssue[] = [];
  let checkedCount = 0;

  for (const node of nodes) {
    checkedCount++;
    if (hasTextStyle(node)) continue;

    const styles = matchTextStyles(textStyles, node);
    if (styles.length > 0) {
      const label =
        node.fontName !== figma.mixed
          ? `${node.fontName.family} ${typeof node.fontSize === "number" ? node.fontSize : ""}`
          : "text";
      issues.push({
        kind: "typography",
        nodeId: node.id,
        nodeName: node.name || "Untitled",
        field: "text style",
        valueLabel: label.trim(),
        tokenName: null,
        variableId: null,
        styleCandidates: styles,
      });
      continue;
    }

    if (node.fontSize !== figma.mixed && typeof node.fontSize === "number") {
      if (!isTextFieldBound(node, "fontSize")) {
        pushFloat(issues, tokens, node, "FONT_SIZE", "font size", "fontSize", node.fontSize);
      }
    }

    if (node.fontWeight !== figma.mixed && typeof node.fontWeight === "number") {
      if (!isTextFieldBound(node, "fontWeight")) {
        pushFloat(issues, tokens, node, "FONT_WEIGHT", "font weight", "fontWeight", node.fontWeight, 0);
      }
    }

    const lh = lineHeightPx(node);
    if (lh != null && !isTextFieldBound(node, "lineHeight")) {
      pushFloat(issues, tokens, node, "LINE_HEIGHT", "line height", "lineHeight", lh);
    }

    const ls = letterSpacingPx(node);
    if (ls != null && ls !== 0 && !isTextFieldBound(node, "letterSpacing")) {
      pushFloat(issues, tokens, node, "LETTER_SPACING", "letter spacing", "letterSpacing", ls);
    }

    if (node.fontName !== figma.mixed) {
      if (!isTextFieldBound(node, "fontFamily")) {
        pushString(issues, tokens, node, "FONT_FAMILY", "font family", "fontFamily", node.fontName.family);
      }
      if (!isTextFieldBound(node, "fontStyle")) {
        pushString(issues, tokens, node, "FONT_STYLE", "font style", "fontStyle", node.fontName.style);
      }
    }
  }

  return {
    issues,
    fixableCount: issues.filter(isIssueFixable).length,
    tokenCount: textStyles.length + tokens.floats.length + tokens.strings.length,
    checkedCount,
  };
}

export async function applyTypographyTokens(
  issues: LintIssue[],
  selections: StyleApplySelection[] = []
): Promise<number> {
  let fixed = 0;
  const selectMap = new Map(selections.map((s) => [s.nodeId, s.styleId || null]));

  for (const issue of issues) {
    if (issue.kind !== "typography") continue;
    const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
    if (!node || node.type !== "TEXT") continue;

    try {
      if (issue.styleCandidates && issue.styleCandidates.length > 0) {
        const picked = selectMap.get(issue.nodeId) ?? issue.styleCandidates[0].id;
        if (hasTextStyle(node)) continue;
        await figma.loadFontAsync(node.fontName !== figma.mixed ? node.fontName : { family: "Inter", style: "Regular" });
        node.textStyleId = picked;
        fixed++;
        continue;
      }

      if (!issue.variableId || !issue.bindField) continue;
      const field = issue.bindField as VariableBindableTextField;
      if (isTextFieldBound(node, field)) continue;
      const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
      if (!variable) continue;
      node.setBoundVariable(field, variable);
      fixed++;
    } catch {
      // skip
    }
  }
  return fixed;
}
