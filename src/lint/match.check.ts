import { selectApplyTargets, coveragePercent, type FlatIssue } from "./flat";
import {
  exactFloatTokens,
  floatMatchFields,
  matchFloatToken,
  scopeMatches,
} from "./tokens";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(scopeMatches(["GAP"], ["GAP"]), "gap scope");
assert(scopeMatches(["ALL_SCOPES"], ["FONT_SIZE"]), "all scopes");
assert(!scopeMatches(["FONT_SIZE"], ["GAP"]), "font size is not gap");
assert(scopeMatches([], ["GAP"]), "empty scope matches every field");
assert(scopeMatches(["TEXT_FILL", "ALL_FILLS"], ["TEXT_FILL", "ALL_FILLS"]), "text fill");
assert(!scopeMatches(["TEXT_FILL"], ["FRAME_FILL", "ALL_FILLS"]), "text fill is not a frame fill");

const tokens = [
  { id: "a", name: "space/8", value: 8 },
  { id: "b", name: "space/12", value: 12 },
  { id: "c", name: "space/8-alt", value: 8 },
];
const exact = matchFloatToken(tokens, 8);
assert(exact?.quality === "exact" && exact.token.id === "a", "exact 8");
const near = matchFloatToken(tokens, 9);
assert(near?.quality === "nearest" && near.token.id === "a", "nearest 9");
assert(matchFloatToken(tokens, 10) === null, "10 is out of range");

const exacts = exactFloatTokens(tokens, 8);
assert(exacts.length === 2, "two exact 8 tokens");
const ambiguous = floatMatchFields(tokens, 8);
assert(
  !!ambiguous.tokenCandidates && ambiguous.tokenCandidates.length === 2 && !ambiguous.variableId,
  "ambiguous exact match"
);

assert(coveragePercent(10, 2) === 80, "coverage 80");
assert(coveragePercent(0, 0) === 100, "empty coverage pristine");

function flat(
  quality: "exact" | "nearest" | null,
  id: string,
  extra: Partial<FlatIssue> = {}
): FlatIssue {
  return {
    id,
    category: "spacing",
    kind: "spacing",
    title: "",
    valueLabel: "",
    nodeId: "1",
    nodeName: "",
    field: "",
    styleCandidates: [],
    tokenCandidates: [],
    tokenName: "t",
    variableId: "v",
    matchQuality: quality,
    fixable: quality !== "nearest",
    ambiguous: false,
    ...extra,
  };
}

const issues = [flat("exact", "e"), flat("nearest", "n")];
const fixAll = selectApplyTargets(issues, null, false);
assert(fixAll.length === 1 && fixAll[0].id === "e", "fix all skips nearest");
const fixOne = selectApplyTargets(issues, ["n"], true);
assert(fixOne.length === 1 && fixOne[0].id === "n", "fix one keeps nearest");

const ambiguousIssue = flat("exact", "m", {
  fixable: false,
  ambiguous: true,
  variableId: null,
  tokenCandidates: [
    { id: "a", name: "space/8" },
    { id: "c", name: "space/8-alt" },
  ],
});
assert(
  selectApplyTargets([ambiguousIssue], null, false).length === 0,
  "fix all skips ambiguous"
);
assert(
  selectApplyTargets([ambiguousIssue], ["m"], true).length === 1,
  "fix one keeps ambiguous"
);

console.log("ok");
