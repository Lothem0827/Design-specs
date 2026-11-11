import type { StyleApplySelection } from "./color";
import { loadEffectStyles, matchEffectStyles } from "./styleMatch";
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
import { asScene, collect, isEffectNode, type EffectNode } from "./walk";

type EffectField = VariableBindableEffectField;
type BindableEffect = DropShadowEffect | InnerShadowEffect | BlurEffect;

function isBindableEffect(effect: Effect): effect is BindableEffect {
  return (
    effect.type === "DROP_SHADOW" ||
    effect.type === "INNER_SHADOW" ||
    effect.type === "LAYER_BLUR" ||
    effect.type === "BACKGROUND_BLUR"
  );
}

function effectBound(effect: BindableEffect, field: EffectField): boolean {
  const bv = effect.boundVariables as Partial<Record<EffectField, VariableAlias>> | undefined;
  return bv?.[field] !== undefined;
}

function hasEffectStyle(node: EffectNode): boolean {
  return "effectStyleId" in node && typeof node.effectStyleId === "string" && node.effectStyleId !== "";
}

const EFFECT_FLOAT: VariableScope[] = ["EFFECT_FLOAT"];
const EFFECT_COLOR: VariableScope[] = ["EFFECT_COLOR"];

export async function lintEffects(
  root: SceneNode,
  tokens: TokenIndex,
  nodesIn?: EffectNode[],
  effectStylesIn?: EffectStyle[]
): Promise<LintResult> {
  const effectStyles = effectStylesIn ?? (await loadEffectStyles());
  const floatTokens = hasFloatScope(tokens, EFFECT_FLOAT);
  const colorTokens = hasColorScope(tokens, EFFECT_COLOR);
  const nodes = nodesIn ?? collect(root, isEffectNode);
  const issues: LintIssue[] = [];
  let checkedCount = 0;

  for (const node of nodes) {
    if (!Array.isArray(node.effects) || node.effects.length === 0) continue;
    checkedCount++;
    if (hasEffectStyle(node)) continue;

    const styles = matchEffectStyles(effectStyles, node.effects);
    if (styles.length > 0) {
      issues.push({
        kind: "effect",
        nodeId: node.id,
        nodeName: node.name || "Untitled",
        field: "effect style",
        valueLabel: `${node.effects.filter((e) => e.visible).length} effects`,
        tokenName: null,
        variableId: null,
        styleCandidates: styles,
      });
      continue;
    }

    for (let i = 0; i < node.effects.length; i++) {
      const effect = node.effects[i];
      if (!effect.visible || !isBindableEffect(effect)) continue;

      if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
        if (!effectBound(effect, "color") && colorTokens) {
          const match = colorMatchFields(colorTokensFor(tokens, node, EFFECT_COLOR), effect.color);
          issues.push({
            kind: "effect",
            nodeId: node.id,
            nodeName: node.name || "Untitled",
            field: `${effect.type === "DROP_SHADOW" ? "shadow" : "inner shadow"} color`,
            valueLabel: rgbLabel(effect.color),
            tokenName: match.tokenName,
            variableId: match.variableId,
            matchQuality: match.matchQuality,
            effectIndex: i,
            effectField: "color",
            tokenCandidates: match.tokenCandidates,
          });
        }

        if (floatTokens) {
          const pool = floatTokensFor(tokens, node, EFFECT_FLOAT);
          for (const [field, label, value] of [
            ["radius", "shadow radius", effect.radius],
            ["spread", "shadow spread", effect.spread],
            ["offsetX", "shadow x", effect.offset.x],
            ["offsetY", "shadow y", effect.offset.y],
          ] as Array<[EffectField, string, number]>) {
            if (value === 0 && (field === "spread" || field === "offsetX" || field === "offsetY")) {
              continue;
            }
            if (effectBound(effect, field)) continue;
            const match = floatMatchFields(pool, value);
            issues.push({
              kind: "effect",
              nodeId: node.id,
              nodeName: node.name || "Untitled",
              field: label,
              valueLabel: String(Math.round(value * 100) / 100),
              tokenName: match.tokenName,
              variableId: match.variableId,
              matchQuality: match.matchQuality,
              effectIndex: i,
              effectField: field,
              tokenCandidates: match.tokenCandidates,
            });
          }
        }
      }

      if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR") {
        if (floatTokens && !effectBound(effect, "radius") && effect.radius > 0) {
          const match = floatMatchFields(floatTokensFor(tokens, node, EFFECT_FLOAT), effect.radius);
          issues.push({
            kind: "effect",
            nodeId: node.id,
            nodeName: node.name || "Untitled",
            field: "blur radius",
            valueLabel: String(Math.round(effect.radius * 100) / 100),
            tokenName: match.tokenName,
            variableId: match.variableId,
            matchQuality: match.matchQuality,
            effectIndex: i,
            effectField: "radius",
            tokenCandidates: match.tokenCandidates,
          });
        }
      }
    }
  }

  return {
    issues,
    fixableCount: issues.filter(isIssueFixable).length,
    tokenCount: effectStyles.length + tokens.floats.length + tokens.colors.length,
    checkedCount,
  };
}

export async function applyEffectTokens(
  issues: LintIssue[],
  selections: StyleApplySelection[] = []
): Promise<number> {
  let fixed = 0;
  const selectMap = new Map(selections.map((s) => [s.nodeId, s.styleId || null]));

  for (const issue of issues) {
    if (issue.kind !== "effect") continue;
    const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
    if (!node || !isEffectNode(node)) continue;

    try {
      if (issue.styleCandidates && issue.styleCandidates.length > 0) {
        const picked = selectMap.get(issue.nodeId) ?? issue.styleCandidates[0].id;
        if (hasEffectStyle(node)) continue;
        if ("effectStyleId" in node) {
          (node as GeometryMixin & BlendMixin & { effectStyleId: string }).effectStyleId = picked;
          fixed++;
        }
        continue;
      }

      if (!issue.variableId || issue.effectIndex == null || !issue.effectField) continue;
      if (!Array.isArray(node.effects)) continue;

      const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
      if (!variable) continue;

      const effects = node.effects.slice();
      const effect = effects[issue.effectIndex];
      if (!effect || !isBindableEffect(effect)) continue;
      if (effectBound(effect, issue.effectField)) continue;

      effects[issue.effectIndex] = figma.variables.setBoundVariableForEffect(
        effect,
        issue.effectField,
        variable
      );
      node.effects = effects;
      fixed++;
    } catch {
      // skip
    }
  }
  return fixed;
}
