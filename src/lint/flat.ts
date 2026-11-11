import { isIssueFixable, type LintIssue, type LintKind } from "./types";

export type LintCategory =
  | "text"
  | "spacing"
  | "radius"
  | "color"
  | "stroke"
  | "effect"
  | "opacity"
  | "layout";

export type FlatIssue = {
  id: string;
  category: LintCategory;
  kind: LintKind;
  title: string;
  valueLabel: string;
  nodeId: string;
  nodeName: string;
  field: string;
  paintIndex?: number;
  effectIndex?: number;
  styleCandidates: Array<{ id: string; name: string }>;
  tokenCandidates: Array<{ id: string; name: string }>;
  tokenName: string | null;
  variableId: string | null;
  matchQuality: "exact" | "nearest" | null;
  fixable: boolean;
  ambiguous: boolean;
};

const TITLE: Partial<Record<LintKind, string>> = {
  spacing: "Unbound spacing",
  "border-radius": "Missing radius token",
  "color-fill": "Missing fill style",
  typography: "Missing text style",
  opacity: "Unbound opacity",
  effect: "Missing effect style",
  "stroke-weight": "Unbound stroke weight",
  "stroke-color": "Missing stroke style",
  "layout-no-autolayout": "Missing auto layout",
  "layout-nested-no-autolayout": "Non-auto-layout layer",
  "layout-fixed-size": "Fixed width and height",
  "detached-instance": "Possible detached instance",
};

function categoryOf(kind: LintKind): LintCategory {
  switch (kind) {
    case "typography":
    case "text-style":
      return "text";
    case "spacing":
      return "spacing";
    case "border-radius":
      return "radius";
    case "color-fill":
    case "color-style":
      return "color";
    case "stroke-weight":
    case "stroke-color":
      return "stroke";
    case "effect":
      return "effect";
    case "opacity":
      return "opacity";
    case "layout-no-autolayout":
    case "layout-nested-no-autolayout":
    case "layout-fixed-size":
    case "detached-instance":
      return "layout";
    default:
      return "color";
  }
}

function titleOf(issue: LintIssue): string {
  if (issue.tokenCandidates && issue.tokenCandidates.length > 1) {
    return "Multiple token matches";
  }
  if (issue.styleCandidates && issue.styleCandidates.length > 0) {
    if (issue.kind === "color-fill") return "Missing fill style";
    if (issue.kind === "stroke-color") return "Missing stroke style";
    if (issue.kind === "typography") return "Missing text style";
    if (issue.kind === "effect") return "Missing effect style";
  }
  if (issue.kind === "spacing") {
    if (issue.field.includes("gap")) return "Unbound gap";
    return "Unbound padding";
  }
  return TITLE[issue.kind] || issue.field;
}

export function toFlatIssue(issue: LintIssue): FlatIssue {
  const tokenCandidates = issue.tokenCandidates || [];
  return {
    id: `${issue.nodeId}:${issue.kind}:${issue.paintIndex ?? issue.effectIndex ?? ""}:${issue.field}`,
    category: categoryOf(issue.kind),
    kind: issue.kind,
    title: titleOf(issue),
    valueLabel: issue.valueLabel,
    nodeId: issue.nodeId,
    nodeName: issue.nodeName,
    field: issue.field,
    paintIndex: issue.paintIndex,
    effectIndex: issue.effectIndex,
    styleCandidates: issue.styleCandidates || [],
    tokenCandidates,
    tokenName: issue.tokenName,
    variableId: issue.variableId,
    matchQuality: issue.matchQuality ?? null,
    fixable: isIssueFixable(issue),
    ambiguous: tokenCandidates.length > 1,
  };
}

export function selectApplyTargets(
  issues: FlatIssue[],
  ids: string[] | null,
  allowNearest: boolean
): FlatIssue[] {
  const picked = ids ? issues.filter((i) => ids.indexOf(i.id) !== -1) : issues.slice();
  return picked.filter((i) => {
    if (i.ambiguous) return allowNearest && (i.tokenCandidates.length > 0 || !!i.variableId);
    if (i.matchQuality === "nearest") return allowNearest && !!i.variableId;
    return i.fixable;
  });
}

export function coveragePercent(checkedCount: number, issueCount: number): number {
  if (checkedCount <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((100 * (checkedCount - issueCount)) / checkedCount)));
}

export function flattenIssues(groups: LintIssue[][]): FlatIssue[] {
  const out: FlatIssue[] = [];
  for (const group of groups) {
    for (const issue of group) out.push(toFlatIssue(issue));
  }
  return out;
}
