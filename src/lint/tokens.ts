import type { ColorMatch, ColorToken, FloatMatch, FloatToken, StringToken } from "./types";

export type { ColorMatch, ColorToken, FloatMatch, FloatToken, StringToken };

type ScopedVar = {
  id: string;
  name: string;
  scopes: VariableScope[];
  variable: Variable;
};

export type TokenIndex = {
  floats: ScopedVar[];
  colors: ScopedVar[];
  strings: ScopedVar[];
  cache: Map<string, VariableValue | null>;
  floatPoolCache: Map<string, FloatToken[]>;
  colorPoolCache: Map<string, ColorToken[]>;
  stringPoolCache: Map<string, StringToken[]>;
};

let sessionTokenIndex: TokenIndex | null = null;

export function clearTokenIndexCache(): void {
  sessionTokenIndex = null;
}

/**
 * Drop resolve/pool maps only. Prefer clearTokenIndexCache on variable edits.
 * Kept for callers that need a soft reset without refetching variables.
 */
export function resetTokenPools(index: TokenIndex): void {
  index.cache.clear();
  index.floatPoolCache.clear();
  index.colorPoolCache.clear();
  index.stringPoolCache.clear();
}

/** Empty scopes mean the variable shows everywhere. Same as ALL_SCOPES. */
export function scopeMatches(
  scopes: readonly VariableScope[],
  allowed: readonly VariableScope[]
): boolean {
  if (scopes.length === 0 || scopes.indexOf("ALL_SCOPES") !== -1) return true;
  for (let i = 0; i < allowed.length; i++) {
    if (scopes.indexOf(allowed[i]) !== -1) return true;
  }
  return false;
}

export function fillScopes(node: SceneNode): VariableScope[] {
  if (node.type === "TEXT") return ["TEXT_FILL", "ALL_FILLS"];
  if (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE" ||
    node.type === "COMPONENT_SET" ||
    node.type === "SECTION"
  ) {
    return ["FRAME_FILL", "ALL_FILLS"];
  }
  return ["SHAPE_FILL", "ALL_FILLS"];
}

export async function loadTokenIndex(force = false): Promise<TokenIndex> {
  if (!force && sessionTokenIndex) return sessionTokenIndex;
  const vars = await figma.variables.getLocalVariablesAsync();
  const index: TokenIndex = {
    floats: [],
    colors: [],
    strings: [],
    cache: new Map(),
    floatPoolCache: new Map(),
    colorPoolCache: new Map(),
    stringPoolCache: new Map(),
  };
  for (const variable of vars) {
    const item: ScopedVar = {
      id: variable.id,
      name: variable.name,
      scopes: variable.scopes || [],
      variable,
    };
    if (variable.resolvedType === "FLOAT") index.floats.push(item);
    else if (variable.resolvedType === "COLOR") index.colors.push(item);
    else if (variable.resolvedType === "STRING") index.strings.push(item);
  }
  sessionTokenIndex = index;
  return index;
}

function scopeKey(allowed: readonly VariableScope[]): string {
  return allowed.join(",");
}

export function hasFloatScope(index: TokenIndex, allowed: readonly VariableScope[]): boolean {
  return index.floats.some((item) => scopeMatches(item.scopes, allowed));
}

export function hasColorScope(index: TokenIndex, allowed: readonly VariableScope[]): boolean {
  return index.colors.some((item) => scopeMatches(item.scopes, allowed));
}

export function hasStringScope(index: TokenIndex, allowed: readonly VariableScope[]): boolean {
  return index.strings.some((item) => scopeMatches(item.scopes, allowed));
}

function modeKey(node: SceneNode): string {
  const modes = node.resolvedVariableModes;
  const ids = Object.keys(modes).sort();
  let out = "";
  for (const id of ids) out += id + "=" + modes[id] + "\n";
  return out;
}

function poolKey(node: SceneNode, allowed: readonly VariableScope[]): string {
  // mode + scope — all nodes in same collection modes share one pool
  return modeKey(node) + "\0" + scopeKey(allowed);
}

function resolvedValue(index: TokenIndex, variable: Variable, node: SceneNode): VariableValue | null {
  const key = variable.id + "\0" + modeKey(node);
  if (index.cache.has(key)) return index.cache.get(key) ?? null;
  let value: VariableValue | null = null;
  try {
    value = variable.resolveForConsumer(node).value;
  } catch {
    value = null;
  }
  if (value && typeof value === "object" && "type" in value && value.type === "VARIABLE_ALIAS") {
    value = null;
  }
  index.cache.set(key, value);
  return value;
}

function asRgb(value: VariableValue): RGB | null {
  if (!value || typeof value !== "object" || !("r" in value) || !("g" in value) || !("b" in value)) {
    return null;
  }
  return { r: value.r, g: value.g, b: value.b };
}

export function floatTokensFor(
  index: TokenIndex,
  node: SceneNode,
  allowed: readonly VariableScope[]
): FloatToken[] {
  const key = poolKey(node, allowed);
  const hit = index.floatPoolCache.get(key);
  if (hit) return hit;
  const out: FloatToken[] = [];
  for (const item of index.floats) {
    if (!scopeMatches(item.scopes, allowed)) continue;
    const value = resolvedValue(index, item.variable, node);
    if (typeof value !== "number") continue;
    out.push({ id: item.id, name: item.name, value });
  }
  index.floatPoolCache.set(key, out);
  return out;
}

export function colorTokensFor(
  index: TokenIndex,
  node: SceneNode,
  allowed: readonly VariableScope[]
): ColorToken[] {
  const key = poolKey(node, allowed);
  const hit = index.colorPoolCache.get(key);
  if (hit) return hit;
  const out: ColorToken[] = [];
  for (const item of index.colors) {
    if (!scopeMatches(item.scopes, allowed)) continue;
    const value = resolvedValue(index, item.variable, node);
    if (value == null) continue;
    const rgb = asRgb(value);
    if (!rgb) continue;
    out.push({ id: item.id, name: item.name, r: rgb.r, g: rgb.g, b: rgb.b });
  }
  index.colorPoolCache.set(key, out);
  return out;
}

export function stringTokensFor(
  index: TokenIndex,
  node: SceneNode,
  allowed: readonly VariableScope[]
): StringToken[] {
  const key = poolKey(node, allowed);
  const hit = index.stringPoolCache.get(key);
  if (hit) return hit;
  const out: StringToken[] = [];
  for (const item of index.strings) {
    if (!scopeMatches(item.scopes, allowed)) continue;
    const value = resolvedValue(index, item.variable, node);
    if (typeof value !== "string") continue;
    out.push({ id: item.id, name: item.name, value });
  }
  index.stringPoolCache.set(key, out);
  return out;
}

export function exactFloatTokens(tokens: FloatToken[], value: number): FloatToken[] {
  const rounded = Math.round(value * 1000) / 1000;
  return tokens.filter((t) => Math.abs(t.value - rounded) < 0.001);
}

export function exactColorTokens(tokens: ColorToken[], color: RGB): ColorToken[] {
  return tokens.filter(
    (t) =>
      Math.abs(t.r - color.r) < 0.01 &&
      Math.abs(t.g - color.g) < 0.01 &&
      Math.abs(t.b - color.b) < 0.01
  );
}

/** Exact first (all ties); else nearest within maxDelta (default ±1). */
export function matchFloatToken(
  tokens: FloatToken[],
  value: number,
  maxDelta = 1
): FloatMatch | null {
  const exacts = exactFloatTokens(tokens, value);
  if (exacts.length === 1) return { token: exacts[0], quality: "exact" };
  if (exacts.length > 1) return { token: exacts[0], quality: "exact" };

  const rounded = Math.round(value * 1000) / 1000;
  let nearest: FloatToken | null = null;
  let best = Infinity;

  for (const t of tokens) {
    const d = Math.abs(t.value - rounded);
    if (d <= maxDelta && d < best) {
      best = d;
      nearest = t;
    }
  }

  if (nearest) return { token: nearest, quality: "nearest" };
  return null;
}

/** Exact RGB first; else nearest if each channel within maxChannelDelta (default 3/255). */
export function matchColorToken(
  tokens: ColorToken[],
  color: RGB,
  maxChannelDelta = 3 / 255
): ColorMatch | null {
  const exacts = exactColorTokens(tokens, color);
  if (exacts.length >= 1) return { token: exacts[0], quality: "exact" };

  let nearest: ColorToken | null = null;
  let bestDist = Infinity;

  for (const t of tokens) {
    const dr = Math.abs(t.r - color.r);
    const dg = Math.abs(t.g - color.g);
    const db = Math.abs(t.b - color.b);
    const maxC = Math.max(dr, dg, db);
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (maxC <= maxChannelDelta && dist < bestDist) {
      bestDist = dist;
      nearest = t;
    }
  }

  if (nearest) return { token: nearest, quality: "nearest" };
  return null;
}

/** Build float lint fields; marks ambiguous when several tokens share the value. */
export function floatMatchFields(
  tokens: FloatToken[],
  value: number,
  maxDelta = 1
): {
  tokenName: string | null;
  variableId: string | null;
  matchQuality: "exact" | "nearest" | null;
  tokenCandidates?: Array<{ id: string; name: string }>;
} {
  const exacts = exactFloatTokens(tokens, value);
  if (exacts.length > 1) {
    return {
      tokenName: null,
      variableId: null,
      matchQuality: "exact",
      tokenCandidates: exacts.map((t) => ({ id: t.id, name: t.name })),
    };
  }
  const match = matchFloatToken(tokens, value, maxDelta);
  return {
    tokenName: match?.token.name ?? null,
    variableId: match?.token.id ?? null,
    matchQuality: match?.quality ?? null,
  };
}

export function colorMatchFields(
  tokens: ColorToken[],
  color: RGB,
  maxChannelDelta = 3 / 255
): {
  tokenName: string | null;
  variableId: string | null;
  matchQuality: "exact" | "nearest" | null;
  tokenCandidates?: Array<{ id: string; name: string }>;
} {
  const exacts = exactColorTokens(tokens, color);
  if (exacts.length > 1) {
    return {
      tokenName: null,
      variableId: null,
      matchQuality: "exact",
      tokenCandidates: exacts.map((t) => ({ id: t.id, name: t.name })),
    };
  }
  const match = matchColorToken(tokens, color, maxChannelDelta);
  return {
    tokenName: match?.token.name ?? null,
    variableId: match?.token.id ?? null,
    matchQuality: match?.quality ?? null,
  };
}

export function matchStringToken(tokens: StringToken[], value: string): StringToken | null {
  const needle = value.trim().toLowerCase();
  return tokens.find((t) => t.value.trim().toLowerCase() === needle) || null;
}

export function rgbLabel(color: RGB): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
