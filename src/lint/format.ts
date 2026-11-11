import type { LintIssue } from "./types";

export function formatIssue(issue: LintIssue): string {
  const where = `${issue.nodeName} · ${issue.field} ${issue.valueLabel}`;
  const styles = issue.styleCandidates;
  if (styles && styles.length > 0) {
    if (styles.length === 1) return `${where} → ${styles[0].name}`;
    return `${where} → ${styles.length} styles`;
  }
  if (issue.tokenName) {
    const nearest = issue.matchQuality === "nearest" ? " (nearest)" : "";
    return `${where} → ${issue.tokenName}${nearest}`;
  }
  return `${where} (no token)`;
}

export function emptyResult(tokenCount = 0) {
  return { issues: [], fixableCount: 0, tokenCount };
}
