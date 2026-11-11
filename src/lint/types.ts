export type MatchQuality = "exact" | "nearest";

export type LintKind =
  | "spacing"
  | "border-radius"
  | "color-fill"
  | "typography"
  | "opacity"
  | "effect"
  | "stroke-weight"
  | "stroke-color"
  | "text-style"
  | "color-style"
  | "layout-no-autolayout"
  | "layout-nested-no-autolayout"
  | "layout-fixed-size"
  | "detached-instance";

export type StyleCandidate = { id: string; name: string };

export type LintIssue = {
  kind: LintKind;
  nodeId: string;
  nodeName: string;
  field: string;
  bindField?: VariableBindableNodeField | VariableBindableTextField;
  valueLabel: string;
  tokenName: string | null;
  variableId: string | null;
  matchQuality?: MatchQuality | null;
  paintIndex?: number;
  effectIndex?: number;
  effectField?: VariableBindableEffectField;
  /** Matching local styles (preferred over tokens). User picks one in UI. */
  styleCandidates?: StyleCandidate[];
  /** Multiple exact variable matches — user must pick before Fix All. */
  tokenCandidates?: StyleCandidate[];
  /** @deprecated use styleCandidates */
  styleId?: string | null;
};

export function isIssueFixable(issue: LintIssue): boolean {
  if (issue.matchQuality === "nearest") return false;
  if (issue.tokenCandidates && issue.tokenCandidates.length > 1) return false;
  if (issue.tokenCandidates && issue.tokenCandidates.length === 1) return true;
  return !!(issue.variableId || (issue.styleCandidates && issue.styleCandidates.length > 0));
}

/** Fix All passes allowNearest false. A row Fix button passes true. */
export function isIssueApplyable(issue: LintIssue, allowNearest: boolean): boolean {
  if (issue.tokenCandidates && issue.tokenCandidates.length > 0) return true;
  if (issue.matchQuality === "nearest") return allowNearest && !!issue.variableId;
  return isIssueFixable(issue);
}

export type LintResult = {
  issues: LintIssue[];
  fixableCount: number;
  tokenCount: number;
  /** Properties checked (bound + unbound). Used for coverage %. */
  checkedCount?: number;
};

export type FloatToken = { id: string; name: string; value: number };
export type ColorToken = { id: string; name: string; r: number; g: number; b: number };
export type StringToken = { id: string; name: string; value: string };

export type FloatMatch = { token: FloatToken; quality: MatchQuality };
export type ColorMatch = { token: ColorToken; quality: MatchQuality };
