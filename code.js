"use strict";
(() => {
  // src/componentMatch.ts
  var FINGERPRINT_DEPTH = 3;
  var SIZE_ROUND = 4;
  var SPACE_ROUND = 4;
  var TOP_N = 5;
  var SCORE_THRESHOLD = 0.7;
  var MATCH_COLLECT_DEPTH = 20;
  var SHAPE_TYPES = /* @__PURE__ */ new Set([
    "VECTOR",
    "BOOLEAN_OPERATION",
    "ELLIPSE",
    "RECTANGLE",
    "POLYGON",
    "STAR",
    "LINE"
  ]);
  function roundTo(n, step) {
    return Math.round(n / step) * step;
  }
  function subtreeHasText(node, depth) {
    if (node.type === "TEXT") return true;
    if (depth >= FINGERPRINT_DEPTH || !("children" in node)) return false;
    for (const child of node.children) {
      if (subtreeHasText(child, depth + 1)) return true;
    }
    return false;
  }
  function typeKey(node) {
    if (node.type === "TEXT") return "TEXT";
    if (SHAPE_TYPES.has(node.type)) return "SHAPE";
    if (node.type === "INSTANCE" && !subtreeHasText(node, 0)) return "SHAPE";
    if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET") {
      return "BOX";
    }
    return node.type;
  }
  function isShapeLeaf(node) {
    return SHAPE_TYPES.has(node.type) || node.type === "INSTANCE" && !subtreeHasText(node, 0);
  }
  function isContainer(node) {
    return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET";
  }
  function layoutPaddingKey(node) {
    if (!("layoutMode" in node) || node.layoutMode === "NONE") return "none";
    return [
      roundTo(node.paddingTop, SPACE_ROUND),
      roundTo(node.paddingRight, SPACE_ROUND),
      roundTo(node.paddingBottom, SPACE_ROUND),
      roundTo(node.paddingLeft, SPACE_ROUND)
    ].join(",");
  }
  function hasSolidFill(node) {
    if (!("fills" in node)) return false;
    const fills = node.fills;
    if (fills === figma.mixed || !Array.isArray(fills)) return false;
    return fills.some((p) => p.visible !== false && p.type === "SOLID");
  }
  function hasCornerRadius(node) {
    if (!("cornerRadius" in node)) return false;
    const r = node.cornerRadius;
    if (r === figma.mixed) return true;
    return typeof r === "number" && r > 0;
  }
  function walkFingerprint(node, depth, types, counts) {
    if (node.type === "GROUP") {
      let hasText2 = false;
      let textLen2 = 0;
      if (depth < FINGERPRINT_DEPTH && "children" in node) {
        for (const child of node.children) {
          const nested = walkFingerprint(child, depth + 1, types, counts);
          hasText2 = hasText2 || nested.hasText;
          textLen2 += nested.textLen;
        }
      }
      return { hasText: hasText2, textLen: textLen2 };
    }
    const key = typeKey(node);
    counts.set(key, (counts.get(key) || 0) + 1);
    types.push(key);
    let hasText = node.type === "TEXT";
    let textLen = node.type === "TEXT" && "characters" in node ? node.characters.length : 0;
    if (isShapeLeaf(node) || depth >= FINGERPRINT_DEPTH || !("children" in node)) {
      return { hasText, textLen };
    }
    for (const child of node.children) {
      const nested = walkFingerprint(child, depth + 1, types, counts);
      hasText = hasText || nested.hasText;
      textLen += nested.textLen;
    }
    return { hasText, textLen };
  }
  function fingerprint(node) {
    const types = [];
    const counts = /* @__PURE__ */ new Map();
    const text = walkFingerprint(node, 0, types, counts);
    const layoutMode = isContainer(node) && node.type !== "COMPONENT_SET" && "layoutMode" in node ? node.layoutMode : "NONE";
    const itemSpacing = isContainer(node) && node.type !== "COMPONENT_SET" && "itemSpacing" in node && layoutMode !== "NONE" ? roundTo(node.itemSpacing, SPACE_ROUND) : 0;
    const paddingKey = isContainer(node) && node.type !== "COMPONENT_SET" ? layoutPaddingKey(node) : "none";
    const countKey = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${t}:${n}`).join("|");
    return {
      childCount: "children" in node ? node.children.length : 0,
      width: roundTo(node.width, SIZE_ROUND),
      height: roundTo(node.height, SIZE_ROUND),
      layoutMode,
      paddingKey,
      itemSpacing,
      typeCounts: countKey,
      typePath: types.join(">"),
      hasText: text.hasText,
      textLenBucket: roundTo(text.textLen, 8),
      hasRadius: hasCornerRadius(node),
      hasFill: hasSolidFill(node)
    };
  }
  function scorePair(a, b) {
    let score = 0;
    let weight = 0;
    const add = (w, ok) => {
      weight += w;
      if (ok) score += w;
    };
    const exactSize = a.width === b.width && a.height === b.height;
    const nearSize = !exactSize && Math.abs(a.width - b.width) <= SIZE_ROUND * 2 && Math.abs(a.height - b.height) <= SIZE_ROUND * 2;
    add(0.22, a.typeCounts === b.typeCounts);
    add(0.14, a.typePath === b.typePath);
    add(0.12, a.childCount === b.childCount);
    add(0.12, exactSize);
    add(0.08, nearSize);
    add(0.1, a.layoutMode === b.layoutMode);
    add(0.08, a.paddingKey === b.paddingKey);
    add(0.06, a.itemSpacing === b.itemSpacing);
    add(0.04, a.hasText === b.hasText);
    add(0.02, a.textLenBucket === b.textLenBucket);
    add(0.01, a.hasRadius === b.hasRadius);
    add(0.01, a.hasFill === b.hasFill);
    return weight === 0 ? 0 : score / weight;
  }
  var passCatalog = null;
  var previewCache = /* @__PURE__ */ new Map();
  var PREVIEW_WIDTH = 280;
  function beginComponentPass() {
    passCatalog = null;
    previewCache.clear();
  }
  async function exportComponentPreview(componentId) {
    const cached = previewCache.get(componentId);
    if (cached) return cached;
    const node = await figma.getNodeByIdAsync(componentId);
    if (!node || node.type !== "COMPONENT") return void 0;
    try {
      const bytes = await node.exportAsync({
        format: "PNG",
        constraint: { type: "WIDTH", value: PREVIEW_WIDTH }
      });
      const dataUrl = "data:image/png;base64," + figma.base64Encode(bytes);
      previewCache.set(componentId, dataUrl);
      return dataUrl;
    } catch {
      return void 0;
    }
  }
  async function attachCandidatePreviews(matches) {
    const ids = /* @__PURE__ */ new Set();
    for (const match of matches) {
      for (const c of match.candidates) ids.add(c.componentId);
    }
    await Promise.all([...ids].map((id) => exportComponentPreview(id)));
    return matches.map((match) => ({
      ...match,
      candidates: match.candidates.map((c) => {
        const preview = previewCache.get(c.componentId);
        return preview ? { ...c, preview } : { ...c };
      })
    }));
  }
  function getPassCatalog() {
    if (!passCatalog) {
      const nodes = figma.root.findAllWithCriteria({ types: ["COMPONENT"] });
      passCatalog = nodes.map((component) => ({ component, fp: fingerprint(component) }));
    }
    return passCatalog;
  }
  function catalogEntries(excludeIds) {
    return getPassCatalog().filter((e) => !excludeIds.has(e.component.id));
  }
  function collectFromFrame(root, out, seen) {
    const stack = [{ node: root, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (depth > MATCH_COLLECT_DEPTH) continue;
      if (node.type === "FRAME") {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          out.push(node);
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push({ node: node.children[i], depth: depth + 1 });
        }
        continue;
      }
      if (node.type === "INSTANCE" || node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
        continue;
      }
      if ("children" in node && depth < MATCH_COLLECT_DEPTH) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push({ node: node.children[i], depth: depth + 1 });
        }
      }
    }
  }
  function collectFrameTargets(selection) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const node of selection) {
      if (node.type === "FRAME") {
        collectFromFrame(node, out, seen);
      }
    }
    return out;
  }
  function rankAgainstCatalog(target, cached) {
    const targetFp = fingerprint(target);
    return cached.map(({ component, fp }) => ({
      componentId: component.id,
      name: component.name,
      score: scorePair(targetFp, fp)
    })).filter((c) => c.score >= SCORE_THRESHOLD).sort((a, b) => b.score - a.score).slice(0, TOP_N);
  }
  function matchSelection(selection) {
    const targets = collectFrameTargets(selection);
    if (!targets.length) return [];
    const exclude = new Set(targets.map((t) => t.id));
    const cached = catalogEntries(exclude);
    const matches = [];
    for (const target of targets) {
      const ranked = rankAgainstCatalog(target, cached);
      if (!ranked.length) continue;
      matches.push({
        nodeId: target.id,
        nodeName: target.name,
        candidates: ranked
      });
    }
    return matches;
  }
  async function lintDetached(root) {
    const frames = [];
    const seen = /* @__PURE__ */ new Set();
    if (root.type === "FRAME") {
      collectFromFrame(root, frames, seen);
    } else if ("children" in root) {
      for (const child of root.children) {
        if (child.type === "FRAME") collectFromFrame(child, frames, seen);
      }
    }
    if (!frames.length) {
      return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
    }
    const exclude = new Set(frames.map((f) => f.id));
    const cached = catalogEntries(exclude);
    if (!cached.length) {
      return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: frames.length };
    }
    const issues = [];
    for (const frame of frames) {
      if (frame.id === root.id) continue;
      const ranked = rankAgainstCatalog(frame, cached);
      if (!ranked.length) continue;
      const best = ranked[0];
      issues.push({
        kind: "detached-instance",
        nodeId: frame.id,
        nodeName: frame.name || "Untitled",
        field: "component",
        valueLabel: `${best.name} \xB7 ${Math.round(best.score * 100)}%`,
        tokenName: best.name,
        variableId: null
      });
    }
    return {
      issues,
      fixableCount: 0,
      tokenCount: cached.length,
      checkedCount: Math.max(0, frames.length - (root.type === "FRAME" ? 1 : 0))
    };
  }
  async function replaceWithComponent(item) {
    const node = await figma.getNodeByIdAsync(item.nodeId);
    const component = await figma.getNodeByIdAsync(item.componentId);
    if (!node || node.type !== "FRAME") return false;
    if (!component || component.type !== "COMPONENT") return false;
    const parent = node.parent;
    if (!parent || !("children" in parent)) return false;
    const index = parent.children.indexOf(node);
    if (index < 0) return false;
    const x = node.x;
    const y = node.y;
    const w = node.width;
    const h = node.height;
    const instance = component.createInstance();
    parent.insertChild(index, instance);
    instance.x = x;
    instance.y = y;
    try {
      instance.resize(w, h);
    } catch {
    }
    node.remove();
    return true;
  }
  async function replaceWithComponents(items) {
    let done = 0;
    for (const item of items) {
      if (await replaceWithComponent(item)) done += 1;
    }
    return done;
  }

  // src/lint/types.ts
  function isIssueFixable(issue) {
    if (issue.matchQuality === "nearest") return false;
    if (issue.tokenCandidates && issue.tokenCandidates.length > 1) return false;
    if (issue.tokenCandidates && issue.tokenCandidates.length === 1) return true;
    return !!(issue.variableId || issue.styleCandidates && issue.styleCandidates.length > 0);
  }
  function isIssueApplyable(issue, allowNearest) {
    if (issue.tokenCandidates && issue.tokenCandidates.length > 0) return true;
    if (issue.matchQuality === "nearest") return allowNearest && !!issue.variableId;
    return isIssueFixable(issue);
  }

  // src/lint/tokens.ts
  var sessionTokenIndex = null;
  function clearTokenIndexCache() {
    sessionTokenIndex = null;
  }
  function scopeMatches(scopes, allowed) {
    if (scopes.length === 0 || scopes.indexOf("ALL_SCOPES") !== -1) return true;
    for (let i = 0; i < allowed.length; i++) {
      if (scopes.indexOf(allowed[i]) !== -1) return true;
    }
    return false;
  }
  function fillScopes(node) {
    if (node.type === "TEXT") return ["TEXT_FILL", "ALL_FILLS"];
    if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET" || node.type === "SECTION") {
      return ["FRAME_FILL", "ALL_FILLS"];
    }
    return ["SHAPE_FILL", "ALL_FILLS"];
  }
  async function loadTokenIndex(force = false) {
    if (!force && sessionTokenIndex) return sessionTokenIndex;
    const vars = await figma.variables.getLocalVariablesAsync();
    const index = {
      floats: [],
      colors: [],
      strings: [],
      cache: /* @__PURE__ */ new Map(),
      floatPoolCache: /* @__PURE__ */ new Map(),
      colorPoolCache: /* @__PURE__ */ new Map(),
      stringPoolCache: /* @__PURE__ */ new Map()
    };
    for (const variable of vars) {
      const item = {
        id: variable.id,
        name: variable.name,
        scopes: variable.scopes || [],
        variable
      };
      if (variable.resolvedType === "FLOAT") index.floats.push(item);
      else if (variable.resolvedType === "COLOR") index.colors.push(item);
      else if (variable.resolvedType === "STRING") index.strings.push(item);
    }
    sessionTokenIndex = index;
    return index;
  }
  function scopeKey(allowed) {
    return allowed.join(",");
  }
  function hasFloatScope(index, allowed) {
    return index.floats.some((item) => scopeMatches(item.scopes, allowed));
  }
  function hasColorScope(index, allowed) {
    return index.colors.some((item) => scopeMatches(item.scopes, allowed));
  }
  function hasStringScope(index, allowed) {
    return index.strings.some((item) => scopeMatches(item.scopes, allowed));
  }
  function modeKey(node) {
    const modes = node.resolvedVariableModes;
    const ids = Object.keys(modes).sort();
    let out = "";
    for (const id of ids) out += id + "=" + modes[id] + "\n";
    return out;
  }
  function poolKey(node, allowed) {
    return modeKey(node) + "\0" + scopeKey(allowed);
  }
  function resolvedValue(index, variable, node) {
    var _a;
    const key = variable.id + "\0" + modeKey(node);
    if (index.cache.has(key)) return (_a = index.cache.get(key)) != null ? _a : null;
    let value = null;
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
  function asRgb(value) {
    if (!value || typeof value !== "object" || !("r" in value) || !("g" in value) || !("b" in value)) {
      return null;
    }
    return { r: value.r, g: value.g, b: value.b };
  }
  function floatTokensFor(index, node, allowed) {
    const key = poolKey(node, allowed);
    const hit = index.floatPoolCache.get(key);
    if (hit) return hit;
    const out = [];
    for (const item of index.floats) {
      if (!scopeMatches(item.scopes, allowed)) continue;
      const value = resolvedValue(index, item.variable, node);
      if (typeof value !== "number") continue;
      out.push({ id: item.id, name: item.name, value });
    }
    index.floatPoolCache.set(key, out);
    return out;
  }
  function colorTokensFor(index, node, allowed) {
    const key = poolKey(node, allowed);
    const hit = index.colorPoolCache.get(key);
    if (hit) return hit;
    const out = [];
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
  function stringTokensFor(index, node, allowed) {
    const key = poolKey(node, allowed);
    const hit = index.stringPoolCache.get(key);
    if (hit) return hit;
    const out = [];
    for (const item of index.strings) {
      if (!scopeMatches(item.scopes, allowed)) continue;
      const value = resolvedValue(index, item.variable, node);
      if (typeof value !== "string") continue;
      out.push({ id: item.id, name: item.name, value });
    }
    index.stringPoolCache.set(key, out);
    return out;
  }
  function exactFloatTokens(tokens, value) {
    const rounded = Math.round(value * 1e3) / 1e3;
    return tokens.filter((t) => Math.abs(t.value - rounded) < 1e-3);
  }
  function exactColorTokens(tokens, color) {
    return tokens.filter(
      (t) => Math.abs(t.r - color.r) < 0.01 && Math.abs(t.g - color.g) < 0.01 && Math.abs(t.b - color.b) < 0.01
    );
  }
  function matchFloatToken(tokens, value, maxDelta = 1) {
    const exacts = exactFloatTokens(tokens, value);
    if (exacts.length === 1) return { token: exacts[0], quality: "exact" };
    if (exacts.length > 1) return { token: exacts[0], quality: "exact" };
    const rounded = Math.round(value * 1e3) / 1e3;
    let nearest = null;
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
  function matchColorToken(tokens, color, maxChannelDelta = 3 / 255) {
    const exacts = exactColorTokens(tokens, color);
    if (exacts.length >= 1) return { token: exacts[0], quality: "exact" };
    let nearest = null;
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
  function floatMatchFields(tokens, value, maxDelta = 1) {
    var _a, _b, _c;
    const exacts = exactFloatTokens(tokens, value);
    if (exacts.length > 1) {
      return {
        tokenName: null,
        variableId: null,
        matchQuality: "exact",
        tokenCandidates: exacts.map((t) => ({ id: t.id, name: t.name }))
      };
    }
    const match = matchFloatToken(tokens, value, maxDelta);
    return {
      tokenName: (_a = match == null ? void 0 : match.token.name) != null ? _a : null,
      variableId: (_b = match == null ? void 0 : match.token.id) != null ? _b : null,
      matchQuality: (_c = match == null ? void 0 : match.quality) != null ? _c : null
    };
  }
  function colorMatchFields(tokens, color, maxChannelDelta = 3 / 255) {
    var _a, _b, _c;
    const exacts = exactColorTokens(tokens, color);
    if (exacts.length > 1) {
      return {
        tokenName: null,
        variableId: null,
        matchQuality: "exact",
        tokenCandidates: exacts.map((t) => ({ id: t.id, name: t.name }))
      };
    }
    const match = matchColorToken(tokens, color, maxChannelDelta);
    return {
      tokenName: (_a = match == null ? void 0 : match.token.name) != null ? _a : null,
      variableId: (_b = match == null ? void 0 : match.token.id) != null ? _b : null,
      matchQuality: (_c = match == null ? void 0 : match.quality) != null ? _c : null
    };
  }
  function matchStringToken(tokens, value) {
    const needle = value.trim().toLowerCase();
    return tokens.find((t) => t.value.trim().toLowerCase() === needle) || null;
  }
  function rgbLabel(color) {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }

  // src/lint/flat.ts
  var TITLE = {
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
    "detached-instance": "Possible detached instance"
  };
  function categoryOf(kind) {
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
  function titleOf(issue) {
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
  function toFlatIssue(issue) {
    var _a, _b, _c;
    const tokenCandidates = issue.tokenCandidates || [];
    return {
      id: `${issue.nodeId}:${issue.kind}:${(_b = (_a = issue.paintIndex) != null ? _a : issue.effectIndex) != null ? _b : ""}:${issue.field}`,
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
      matchQuality: (_c = issue.matchQuality) != null ? _c : null,
      fixable: isIssueFixable(issue),
      ambiguous: tokenCandidates.length > 1
    };
  }
  function selectApplyTargets(issues, ids, allowNearest) {
    const picked = ids ? issues.filter((i) => ids.indexOf(i.id) !== -1) : issues.slice();
    return picked.filter((i) => {
      if (i.ambiguous) return allowNearest && (i.tokenCandidates.length > 0 || !!i.variableId);
      if (i.matchQuality === "nearest") return allowNearest && !!i.variableId;
      return i.fixable;
    });
  }
  function coveragePercent(checkedCount, issueCount) {
    if (checkedCount <= 0) return 100;
    return Math.max(0, Math.min(100, Math.round(100 * (checkedCount - issueCount) / checkedCount)));
  }
  function flattenIssues(groups) {
    const out = [];
    for (const group of groups) {
      for (const issue of group) out.push(toFlatIssue(issue));
    }
    return out;
  }

  // src/theme.ts
  var OVERLAY_NAME = "__design-specs-overlay";
  var GREEN_PAD = { r: 0.18, g: 0.64, b: 0.37 };
  var YELLOW_GAP = { r: 0.96, g: 0.78, b: 0.18 };
  var BLUE_RADIUS = { r: 0.2, g: 0.45, b: 0.95 };
  var RED = { r: 0.9, g: 0.22, b: 0.2 };
  var PURPLE = { r: 0.67, g: 0.45, b: 0.9 };
  var GRAY = { r: 0.55, g: 0.55, b: 0.55 };
  var PAD_FILL_OPACITY = 0.22;
  var GAP_FILL_OPACITY = 0.22;
  var OUTLINE_STROKE_WEIGHT = 1.5;
  var DIM_STROKE_WEIGHT = 1.25;
  var DIM_TICK = 6;
  var DIM_OFFSET = 10;
  var DASH_PATTERN = [4, 4];
  var PILL_RADIUS = 3;
  var PILL_PAD_X = 4;
  var PILL_PAD_Y = 2;
  var LABEL_FONT_SIZE = 8;
  var labelFont = { family: "Inter", style: "Medium" };
  function setLabelFont(font) {
    labelFont = font;
  }
  var MAX_NEST_DEPTH = 12;
  var MAX_WALK_NODES = 2500;
  var COMPACT_MAX = 80;

  // src/lint/walk.ts
  function isAutoLayout(node) {
    return (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") && "layoutMode" in node && node.layoutMode !== "NONE";
  }
  function isPrimaryGapAuto(node) {
    const align = node.primaryAxisAlignItems;
    return align === "SPACE_BETWEEN" || align === "SPACE_EVENLY" || align === "SPACE_AROUND";
  }
  function isCounterGapAuto(node) {
    return node.layoutWrap === "WRAP" && node.counterAxisAlignContent === "SPACE_BETWEEN";
  }
  function isRadiusNode(node) {
    return "topLeftRadius" in node && "cornerRadius" in node;
  }
  function asScene(node) {
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") return null;
    return node;
  }
  function isStrokeNode(node) {
    return "strokes" in node && "strokeWeight" in node;
  }
  function isGeometryNode(node) {
    return "fills" in node;
  }
  function isBlendNode(node) {
    return "opacity" in node;
  }
  function isEffectNode(node) {
    return "effects" in node;
  }
  function walkTree(node, depth, maxDepth, visit, budget = { n: 0 }) {
    if (depth > maxDepth || budget.n >= MAX_WALK_NODES) return;
    if (node.visible === false) return;
    budget.n++;
    visit(node);
    if ("children" in node) {
      for (const child of node.children) {
        walkTree(child, depth + 1, maxDepth, visit, budget);
      }
    }
  }
  function collect(root, pred, maxDepth = MAX_NEST_DEPTH) {
    const out = [];
    const budget = { n: 0 };
    walkTree(root, 0, maxDepth, (n) => {
      if (pred(n)) out.push(n);
    }, budget);
    return out;
  }

  // src/lint/spacing.ts
  var SPACING_FIELDS = [
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "itemSpacing",
    "counterAxisSpacing"
  ];
  var GAP_SCOPE = ["GAP"];
  var LABEL = {
    paddingTop: "padding top",
    paddingRight: "padding right",
    paddingBottom: "padding bottom",
    paddingLeft: "padding left",
    itemSpacing: "gap",
    counterAxisSpacing: "counter gap"
  };
  var FROM_LABEL = {
    "padding top": "paddingTop",
    "padding right": "paddingRight",
    "padding bottom": "paddingBottom",
    "padding left": "paddingLeft",
    gap: "itemSpacing",
    "counter gap": "counterAxisSpacing"
  };
  function isBound(node, field) {
    var _a;
    return ((_a = node.boundVariables) == null ? void 0 : _a[field]) !== void 0;
  }
  function isAutoGap(node, field) {
    if (field === "itemSpacing") return isPrimaryGapAuto(node);
    if (field === "counterAxisSpacing") return isCounterGapAuto(node);
    return false;
  }
  async function lintSpacing(root, tokens, nodesIn) {
    if (!hasFloatScope(tokens, GAP_SCOPE)) {
      return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
    }
    const nodes = nodesIn != null ? nodesIn : collect(root, isAutoLayout);
    const issues = [];
    let checkedCount = 0;
    for (const node of nodes) {
      const pool = floatTokensFor(tokens, node, GAP_SCOPE);
      for (const field of SPACING_FIELDS) {
        const value = node[field];
        if (value == null || value <= 0) continue;
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
          tokenCandidates: match.tokenCandidates
        });
      }
    }
    return {
      issues,
      fixableCount: issues.filter(isIssueFixable).length,
      tokenCount: tokens.floats.filter((item) => scopeMatches(item.scopes, GAP_SCOPE)).length,
      checkedCount
    };
  }
  async function applySpacingTokens(issues) {
    let fixed = 0;
    for (const issue of issues) {
      if (issue.kind !== "spacing" || !issue.variableId) continue;
      const field = issue.bindField ? issue.bindField : FROM_LABEL[issue.field];
      if (!field) continue;
      const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
      if (!node || !isAutoLayout(node) || isBound(node, field)) continue;
      const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
      if (!variable) continue;
      try {
        node.setBoundVariable(field, variable);
        fixed++;
      } catch {
      }
    }
    return fixed;
  }

  // src/lint/radius.ts
  function isBound2(node, field) {
    const bound = node.boundVariables;
    if (!bound) return false;
    if (field === "cornerRadius") {
      return bound.cornerRadius !== void 0 || bound.topLeftRadius !== void 0 && bound.topRightRadius !== void 0 && bound.bottomLeftRadius !== void 0 && bound.bottomRightRadius !== void 0;
    }
    return bound[field] !== void 0;
  }
  function collectRadiusFields(node) {
    const out = [];
    const cr = node.cornerRadius;
    if (typeof cr === "number") {
      if (cr > 0) out.push({ field: "cornerRadius", label: "corner radius", value: cr });
      return out;
    }
    const corners = [
      ["topLeftRadius", "radius TL", node.topLeftRadius],
      ["topRightRadius", "radius TR", node.topRightRadius],
      ["bottomLeftRadius", "radius BL", node.bottomLeftRadius],
      ["bottomRightRadius", "radius BR", node.bottomRightRadius]
    ];
    for (const [field, label, value] of corners) {
      if (typeof value === "number" && value > 0) out.push({ field, label, value });
    }
    return out;
  }
  var RADIUS_SCOPE = ["CORNER_RADIUS"];
  async function lintBorder(root, tokens, nodesIn) {
    if (!hasFloatScope(tokens, RADIUS_SCOPE)) {
      return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
    }
    const nodes = nodesIn != null ? nodesIn : collect(root, isRadiusNode);
    const issues = [];
    let checkedCount = 0;
    for (const node of nodes) {
      const pool = floatTokensFor(tokens, node, RADIUS_SCOPE);
      for (const corner of collectRadiusFields(node)) {
        checkedCount++;
        if (isBound2(node, corner.field)) continue;
        const match = floatMatchFields(pool, corner.value);
        issues.push({
          kind: "border-radius",
          nodeId: node.id,
          nodeName: node.name || "Untitled",
          field: corner.label,
          bindField: corner.field,
          valueLabel: String(Math.round(corner.value * 100) / 100),
          tokenName: match.tokenName,
          variableId: match.variableId,
          matchQuality: match.matchQuality,
          tokenCandidates: match.tokenCandidates
        });
      }
    }
    return {
      issues,
      fixableCount: issues.filter(isIssueFixable).length,
      tokenCount: tokens.floats.length,
      checkedCount
    };
  }
  async function applyBorderTokens(issues) {
    let fixed = 0;
    for (const issue of issues) {
      if (!issue.variableId || issue.kind !== "border-radius" || !issue.bindField) continue;
      const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
      if (!node || !isRadiusNode(node)) continue;
      if (isBound2(node, issue.bindField)) continue;
      const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
      if (!variable) continue;
      try {
        if (issue.bindField === "cornerRadius") {
          node.setBoundVariable("topLeftRadius", variable);
          node.setBoundVariable("topRightRadius", variable);
          node.setBoundVariable("bottomLeftRadius", variable);
          node.setBoundVariable("bottomRightRadius", variable);
        } else {
          node.setBoundVariable(issue.bindField, variable);
        }
        fixed++;
      } catch {
      }
    }
    return fixed;
  }

  // src/lint/styleMatch.ts
  var CHANNEL = 3 / 255;
  var paintStylesCache = null;
  var textStylesCache = null;
  var effectStylesCache = null;
  function clearStyleCaches() {
    paintStylesCache = null;
    textStylesCache = null;
    effectStylesCache = null;
  }
  function colorsClose(a, b, maxChannel = CHANNEL) {
    return Math.abs(a.r - b.r) <= maxChannel && Math.abs(a.g - b.g) <= maxChannel && Math.abs(a.b - b.b) <= maxChannel;
  }
  function solidFromPaints(paints) {
    for (const p of paints) {
      if (p.type === "SOLID" && p.visible !== false) return p;
    }
    return null;
  }
  async function loadPaintStyles() {
    if (paintStylesCache) return paintStylesCache;
    paintStylesCache = await figma.getLocalPaintStylesAsync();
    return paintStylesCache;
  }
  async function loadTextStyles() {
    if (textStylesCache) return textStylesCache;
    textStylesCache = await figma.getLocalTextStylesAsync();
    return textStylesCache;
  }
  async function loadEffectStyles() {
    if (effectStylesCache) return effectStylesCache;
    effectStylesCache = await figma.getLocalEffectStylesAsync();
    return effectStylesCache;
  }
  function matchPaintStyles(styles, color) {
    const out = [];
    for (const style of styles) {
      const solid = solidFromPaints(style.paints);
      if (solid && colorsClose(solid.color, color)) {
        out.push({ id: style.id, name: style.name });
      }
    }
    return out;
  }
  function isIconLike(node) {
    const name = (node.name || "").toLowerCase();
    if (/icon|ico|glyph|symbol/.test(name)) return true;
    if (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION" || node.type === "STAR" || node.type === "POLYGON" || node.type === "LINE" || node.type === "ELLIPSE") {
      return true;
    }
    if ((node.type === "FRAME" || node.type === "INSTANCE" || node.type === "COMPONENT") && "width" in node && typeof node.width === "number" && typeof node.height === "number" && node.width <= 48 && node.height <= 48) {
      return true;
    }
    return false;
  }
  function paintRole(node) {
    if (node.type === "TEXT") return "text";
    if (isIconLike(node)) return "icon";
    if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET" || node.type === "RECTANGLE" || node.type === "SECTION") {
      return "bg";
    }
    return "other";
  }
  function rankPaintStyles(candidates, role) {
    if (candidates.length <= 1 || role === "other") return candidates;
    const re = role === "text" ? /text/i : role === "icon" ? /icon/i : /background|\bbg\b/i;
    const preferred = candidates.filter((c) => re.test(c.name));
    if (preferred.length === 0) return candidates;
    const rest = candidates.filter((c) => !re.test(c.name));
    return [...preferred, ...rest];
  }
  function matchTextStyles(styles, node) {
    if (node.fontSize === figma.mixed || typeof node.fontSize !== "number") return [];
    if (node.fontName === figma.mixed) return [];
    const family = node.fontName.family;
    const styleName = node.fontName.style;
    const size = node.fontSize;
    const out = [];
    for (const style of styles) {
      if (style.fontSize !== size) continue;
      if (style.fontName.family !== family) continue;
      if (style.fontName.style !== styleName) continue;
      out.push({ id: style.id, name: style.name });
    }
    return out;
  }
  function effectRoughEqual(a, b) {
    var _a, _b;
    if (a.type !== b.type || a.visible !== b.visible) return false;
    if ((a.type === "DROP_SHADOW" || a.type === "INNER_SHADOW") && (b.type === "DROP_SHADOW" || b.type === "INNER_SHADOW")) {
      const aSpread = (_a = a.spread) != null ? _a : 0;
      const bSpread = (_b = b.spread) != null ? _b : 0;
      return colorsClose(a.color, b.color) && Math.abs(a.radius - b.radius) < 0.5 && Math.abs(aSpread - bSpread) < 0.5 && Math.abs(a.offset.x - b.offset.x) < 0.5 && Math.abs(a.offset.y - b.offset.y) < 0.5;
    }
    if ((a.type === "LAYER_BLUR" || a.type === "BACKGROUND_BLUR") && (b.type === "LAYER_BLUR" || b.type === "BACKGROUND_BLUR")) {
      return Math.abs(a.radius - b.radius) < 0.5;
    }
    return false;
  }
  function matchEffectStyles(styles, effects) {
    const visible = effects.filter((e) => e.visible);
    if (visible.length === 0) return [];
    const out = [];
    for (const style of styles) {
      const se = style.effects.filter((e) => e.visible);
      if (se.length !== visible.length) continue;
      let ok = true;
      for (let i = 0; i < visible.length; i++) {
        if (!effectRoughEqual(visible[i], se[i])) {
          ok = false;
          break;
        }
      }
      if (ok) out.push({ id: style.id, name: style.name });
    }
    return out;
  }

  // src/lint/color.ts
  function hasFillStyle(node) {
    const id = node.fillStyleId;
    if (id === figma.mixed) return true;
    return typeof id === "string" && id !== "";
  }
  function isFillColorBound(node, paintIndex) {
    var _a, _b;
    const fillsAlias = (_a = node.boundVariables) == null ? void 0 : _a.fills;
    if (fillsAlias && fillsAlias[paintIndex]) return true;
    const paint = Array.isArray(node.fills) ? node.fills[paintIndex] : null;
    if (paint && "boundVariables" in paint && ((_b = paint.boundVariables) == null ? void 0 : _b.color)) return true;
    return false;
  }
  async function lintColor(root, tokens, nodesIn, paintStylesIn) {
    const paintStyles = paintStylesIn != null ? paintStylesIn : await loadPaintStyles();
    const nodes = nodesIn != null ? nodesIn : collect(root, isGeometryNode);
    const issues = [];
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
            styleCandidates: styles
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
          tokenCandidates: match.tokenCandidates
        });
      }
    }
    return {
      issues,
      fixableCount: issues.filter(isIssueFixable).length,
      tokenCount: paintStyles.length + tokens.colors.length,
      checkedCount
    };
  }
  async function applyColorTokens(issues, selections = []) {
    var _a, _b;
    let fixed = 0;
    const selectMap = new Map(
      selections.map((s) => {
        var _a2;
        return [`${s.nodeId}:${(_a2 = s.paintIndex) != null ? _a2 : 0}`, s.styleId || null];
      })
    );
    for (const issue of issues) {
      if (issue.kind !== "color-fill") continue;
      const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
      if (!node || !isGeometryNode(node)) continue;
      const index = (_a = issue.paintIndex) != null ? _a : 0;
      const key = `${issue.nodeId}:${index}`;
      const picked = (_b = selectMap.get(key)) != null ? _b : issue.styleCandidates && issue.styleCandidates.length > 0 ? issue.styleCandidates[0].id : null;
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
      }
    }
    return fixed;
  }

  // src/lint/typography.ts
  function isText(node) {
    return node.type === "TEXT";
  }
  function hasTextStyle(node) {
    const id = node.textStyleId;
    if (id === figma.mixed) return true;
    return typeof id === "string" && id !== "";
  }
  function isTextFieldBound(node, field) {
    var _a;
    const bound = (_a = node.boundVariables) == null ? void 0 : _a[field];
    return Array.isArray(bound) ? bound.length > 0 : bound !== void 0;
  }
  function lineHeightPx(node) {
    const lh = node.lineHeight;
    if (lh === figma.mixed) return null;
    if (lh.unit === "PIXELS") return lh.value;
    return null;
  }
  function letterSpacingPx(node) {
    const ls = node.letterSpacing;
    if (ls === figma.mixed) return null;
    if (ls.unit === "PIXELS") return ls.value;
    return null;
  }
  function pushFloat(issues, tokens, node, scope, field, bindField, value, maxDelta) {
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
      tokenCandidates: match.tokenCandidates
    });
  }
  function pushString(issues, tokens, node, scope, field, bindField, value) {
    var _a, _b;
    if (!hasStringScope(tokens, [scope])) return;
    const token = matchStringToken(stringTokensFor(tokens, node, [scope]), value);
    issues.push({
      kind: "typography",
      nodeId: node.id,
      nodeName: node.name || "Untitled",
      field,
      bindField,
      valueLabel: value,
      tokenName: (_a = token == null ? void 0 : token.name) != null ? _a : null,
      variableId: (_b = token == null ? void 0 : token.id) != null ? _b : null,
      matchQuality: token ? "exact" : null
    });
  }
  async function lintTypography(root, tokens, nodesIn, textStylesIn) {
    const textStyles = textStylesIn != null ? textStylesIn : await loadTextStyles();
    const nodes = nodesIn != null ? nodesIn : collect(root, isText);
    const issues = [];
    let checkedCount = 0;
    for (const node of nodes) {
      checkedCount++;
      if (hasTextStyle(node)) continue;
      const styles = matchTextStyles(textStyles, node);
      if (styles.length > 0) {
        const label = node.fontName !== figma.mixed ? `${node.fontName.family} ${typeof node.fontSize === "number" ? node.fontSize : ""}` : "text";
        issues.push({
          kind: "typography",
          nodeId: node.id,
          nodeName: node.name || "Untitled",
          field: "text style",
          valueLabel: label.trim(),
          tokenName: null,
          variableId: null,
          styleCandidates: styles
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
      checkedCount
    };
  }
  async function applyTypographyTokens(issues, selections = []) {
    var _a;
    let fixed = 0;
    const selectMap = new Map(selections.map((s) => [s.nodeId, s.styleId || null]));
    for (const issue of issues) {
      if (issue.kind !== "typography") continue;
      const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
      if (!node || node.type !== "TEXT") continue;
      try {
        if (issue.styleCandidates && issue.styleCandidates.length > 0) {
          const picked = (_a = selectMap.get(issue.nodeId)) != null ? _a : issue.styleCandidates[0].id;
          if (hasTextStyle(node)) continue;
          await figma.loadFontAsync(node.fontName !== figma.mixed ? node.fontName : { family: "Inter", style: "Regular" });
          node.textStyleId = picked;
          fixed++;
          continue;
        }
        if (!issue.variableId || !issue.bindField) continue;
        const field = issue.bindField;
        if (isTextFieldBound(node, field)) continue;
        const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
        if (!variable) continue;
        node.setBoundVariable(field, variable);
        fixed++;
      } catch {
      }
    }
    return fixed;
  }

  // src/lint/opacity.ts
  function isBound3(node) {
    var _a;
    return ((_a = node.boundVariables) == null ? void 0 : _a.opacity) !== void 0;
  }
  var OPACITY_SCOPE = ["OPACITY"];
  async function lintOpacity(root, tokens, nodesIn) {
    if (!hasFloatScope(tokens, OPACITY_SCOPE)) {
      return { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
    }
    const nodes = nodesIn != null ? nodesIn : collect(root, isBlendNode);
    const issues = [];
    let checkedCount = 0;
    for (const node of nodes) {
      if (typeof node.opacity !== "number") continue;
      if (node.opacity >= 0.999) continue;
      checkedCount++;
      if (isBound3(node)) continue;
      const pool = floatTokensFor(tokens, node, OPACITY_SCOPE);
      const match = floatMatchFields(pool, node.opacity, 0.02);
      issues.push({
        kind: "opacity",
        nodeId: node.id,
        nodeName: node.name || "Untitled",
        field: "opacity",
        bindField: "opacity",
        valueLabel: String(Math.round(node.opacity * 1e3) / 1e3),
        tokenName: match.tokenName,
        variableId: match.variableId,
        matchQuality: match.matchQuality,
        tokenCandidates: match.tokenCandidates
      });
    }
    return {
      issues,
      fixableCount: issues.filter(isIssueFixable).length,
      tokenCount: tokens.floats.length,
      checkedCount
    };
  }
  async function applyOpacityTokens(issues) {
    let fixed = 0;
    for (const issue of issues) {
      if (issue.kind !== "opacity" || !issue.variableId) continue;
      const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
      if (!node || !isBlendNode(node) || isBound3(node)) continue;
      const variable = await figma.variables.getVariableByIdAsync(issue.variableId);
      if (!variable) continue;
      try {
        node.setBoundVariable("opacity", variable);
        fixed++;
      } catch {
      }
    }
    return fixed;
  }

  // src/lint/effects.ts
  function isBindableEffect(effect) {
    return effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW" || effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR";
  }
  function effectBound(effect, field) {
    const bv = effect.boundVariables;
    return (bv == null ? void 0 : bv[field]) !== void 0;
  }
  function hasEffectStyle(node) {
    return "effectStyleId" in node && typeof node.effectStyleId === "string" && node.effectStyleId !== "";
  }
  var EFFECT_FLOAT = ["EFFECT_FLOAT"];
  var EFFECT_COLOR = ["EFFECT_COLOR"];
  async function lintEffects(root, tokens, nodesIn, effectStylesIn) {
    const effectStyles = effectStylesIn != null ? effectStylesIn : await loadEffectStyles();
    const floatTokens = hasFloatScope(tokens, EFFECT_FLOAT);
    const colorTokens = hasColorScope(tokens, EFFECT_COLOR);
    const nodes = nodesIn != null ? nodesIn : collect(root, isEffectNode);
    const issues = [];
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
          styleCandidates: styles
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
              tokenCandidates: match.tokenCandidates
            });
          }
          if (floatTokens) {
            const pool = floatTokensFor(tokens, node, EFFECT_FLOAT);
            for (const [field, label, value] of [
              ["radius", "shadow radius", effect.radius],
              ["spread", "shadow spread", effect.spread],
              ["offsetX", "shadow x", effect.offset.x],
              ["offsetY", "shadow y", effect.offset.y]
            ]) {
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
                tokenCandidates: match.tokenCandidates
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
              tokenCandidates: match.tokenCandidates
            });
          }
        }
      }
    }
    return {
      issues,
      fixableCount: issues.filter(isIssueFixable).length,
      tokenCount: effectStyles.length + tokens.floats.length + tokens.colors.length,
      checkedCount
    };
  }
  async function applyEffectTokens(issues, selections = []) {
    var _a;
    let fixed = 0;
    const selectMap = new Map(selections.map((s) => [s.nodeId, s.styleId || null]));
    for (const issue of issues) {
      if (issue.kind !== "effect") continue;
      const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
      if (!node || !isEffectNode(node)) continue;
      try {
        if (issue.styleCandidates && issue.styleCandidates.length > 0) {
          const picked = (_a = selectMap.get(issue.nodeId)) != null ? _a : issue.styleCandidates[0].id;
          if (hasEffectStyle(node)) continue;
          if ("effectStyleId" in node) {
            node.effectStyleId = picked;
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
      }
    }
    return fixed;
  }

  // src/lint/stroke.ts
  function isWeightBound(node) {
    const bound = node.boundVariables;
    if (!bound) return false;
    return bound.strokeWeight !== void 0 || bound.strokeTopWeight !== void 0 || bound.strokeRightWeight !== void 0 || bound.strokeBottomWeight !== void 0 || bound.strokeLeftWeight !== void 0;
  }
  function hasStrokeStyle(node) {
    return typeof node.strokeStyleId === "string" && node.strokeStyleId !== "";
  }
  function isColorBound(node, paintIndex) {
    var _a, _b;
    const strokesAlias = (_a = node.boundVariables) == null ? void 0 : _a.strokes;
    if (strokesAlias && strokesAlias[paintIndex]) return true;
    const paint = node.strokes[paintIndex];
    if (paint && "boundVariables" in paint && ((_b = paint.boundVariables) == null ? void 0 : _b.color)) return true;
    return false;
  }
  var WEIGHT_SCOPE = ["STROKE_FLOAT"];
  var STROKE_COLOR_SCOPE = ["STROKE_COLOR"];
  async function lintStroke(root, tokens, nodesIn, paintStylesIn) {
    const paintStyles = paintStylesIn != null ? paintStylesIn : await loadPaintStyles();
    const weightTokens = hasFloatScope(tokens, WEIGHT_SCOPE);
    const colorTokens = hasColorScope(tokens, STROKE_COLOR_SCOPE);
    const nodes = nodesIn != null ? nodesIn : collect(root, isStrokeNode);
    const issues = [];
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
            tokenCandidates: match.tokenCandidates
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
            styleCandidates: styles
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
          tokenCandidates: match.tokenCandidates
        });
      }
    }
    return {
      issues,
      fixableCount: issues.filter(isIssueFixable).length,
      tokenCount: paintStyles.length + tokens.floats.length + tokens.colors.length,
      checkedCount
    };
  }
  async function applyStrokeTokens(issues, selections = []) {
    var _a, _b;
    let fixed = 0;
    const selectMap = new Map(
      selections.map((s) => {
        var _a2;
        return [`${s.nodeId}:${(_a2 = s.paintIndex) != null ? _a2 : 0}`, s.styleId || null];
      })
    );
    for (const issue of issues) {
      if (issue.kind !== "stroke-weight" && issue.kind !== "stroke-color") continue;
      const node = asScene(await figma.getNodeByIdAsync(issue.nodeId));
      if (!node || !isStrokeNode(node)) continue;
      try {
        if (issue.kind === "stroke-weight") {
          if (!issue.variableId || isWeightBound(node)) continue;
          const variable2 = await figma.variables.getVariableByIdAsync(issue.variableId);
          if (!variable2) continue;
          node.setBoundVariable("strokeWeight", variable2);
          fixed++;
          continue;
        }
        const index = (_a = issue.paintIndex) != null ? _a : 0;
        const key = `${issue.nodeId}:${index}`;
        const picked = (_b = selectMap.get(key)) != null ? _b : issue.styleCandidates && issue.styleCandidates.length > 0 ? issue.styleCandidates[0].id : null;
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
      }
    }
    return fixed;
  }

  // src/lint/layout.ts
  function isLayoutContainer(node) {
    return (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") && "layoutMode" in node;
  }
  function visibleChildCount(node) {
    return node.children.filter((c) => c.visible !== false).length;
  }
  function parentIsAutoLayout(node) {
    const parent = node.parent;
    if (!parent || parent.type === "PAGE" || parent.type === "DOCUMENT") return false;
    return isAutoLayout(parent);
  }
  function isFixedBothAxes(node) {
    return "layoutSizingHorizontal" in node && "layoutSizingVertical" in node && node.layoutSizingHorizontal === "FIXED" && node.layoutSizingVertical === "FIXED";
  }
  async function lintLayout(root, nodesIn) {
    if (!isLayoutContainer(root) || !isAutoLayout(root)) {
      return { issues: [], fixableCount: 0, tokenCount: 0 };
    }
    const nodes = nodesIn != null ? nodesIn : collect(root, isLayoutContainer);
    const issues = [];
    for (const node of nodes) {
      if (node.id === root.id) continue;
      const kids = visibleChildCount(node);
      if (node.layoutMode === "NONE" && kids >= 2) {
        const nested = parentIsAutoLayout(node);
        issues.push({
          kind: nested ? "layout-nested-no-autolayout" : "layout-no-autolayout",
          nodeId: node.id,
          nodeName: node.name,
          field: nested ? "nested layout" : "layout",
          valueLabel: "NONE",
          tokenName: null,
          variableId: null
        });
      }
      if (kids >= 1 && isFixedBothAxes(node)) {
        issues.push({
          kind: "layout-fixed-size",
          nodeId: node.id,
          nodeName: node.name,
          field: "size",
          valueLabel: "FIXED \xD7 FIXED",
          tokenName: null,
          variableId: null
        });
      }
    }
    return { issues, fixableCount: 0, tokenCount: 0 };
  }

  // src/lint/scan.ts
  function isLayoutContainer2(node) {
    return (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") && "layoutMode" in node;
  }
  function scanLintTree(root) {
    const scan = {
      autoLayout: [],
      radius: [],
      geometry: [],
      text: [],
      blend: [],
      effect: [],
      stroke: [],
      layoutContainers: []
    };
    const budget = { n: 0 };
    walkTree(
      root,
      0,
      MAX_NEST_DEPTH,
      (n) => {
        if (isAutoLayout(n)) scan.autoLayout.push(n);
        if (isRadiusNode(n)) scan.radius.push(n);
        if (isGeometryNode(n)) scan.geometry.push(n);
        if (n.type === "TEXT") scan.text.push(n);
        if (isBlendNode(n)) scan.blend.push(n);
        if (isEffectNode(n)) scan.effect.push(n);
        if (isStrokeNode(n)) scan.stroke.push(n);
        if (isLayoutContainer2(n)) scan.layoutContainers.push(n);
      },
      budget
    );
    return scan;
  }

  // src/measure.ts
  function distinctSpacingValues(specs) {
    if (!specs) return [];
    const set = /* @__PURE__ */ new Set();
    for (const band of specs.paddingBands) set.add(band.value);
    for (const gap of specs.gaps) set.add(gap.value);
    return [...set].sort((a, b) => a - b);
  }
  function containsRect(outer, inner) {
    return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
  }
  function dimHorizontal(y, x1, x2, value) {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    return {
      axis: "HORIZONTAL",
      x1: left,
      y1: y,
      x2: right,
      y2: y,
      value,
      label: {
        text: String(Math.round(value)),
        x: (left + right) / 2,
        y: y - 6,
        anchor: "bottom-center",
        value: Math.round(value)
      }
    };
  }
  function dimVertical(x, y1, y2, value) {
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    return {
      axis: "VERTICAL",
      x1: x,
      y1: top,
      x2: x,
      y2: bottom,
      value,
      label: {
        text: String(Math.round(value)),
        x: x + 6,
        y: (top + bottom) / 2,
        anchor: "center",
        value: Math.round(value)
      }
    };
  }
  function sizeDimLines(bounds) {
    const w = Math.round(bounds.width);
    const h = Math.round(bounds.height);
    return [
      dimHorizontal(bounds.y + bounds.height + DIM_OFFSET, bounds.x, bounds.x + bounds.width, w),
      dimVertical(bounds.x + bounds.width + DIM_OFFSET, bounds.y, bounds.y + bounds.height, h)
    ];
  }
  function distanceDimLines(a, b) {
    if (containsRect(a, b)) return insetDimLines(b, a);
    if (containsRect(b, a)) return insetDimLines(a, b);
    const out = [];
    const aRight = a.x + a.width;
    const aBottom = a.y + a.height;
    const bRight = b.x + b.width;
    const bBottom = b.y + b.height;
    if (aRight <= b.x) {
      const gap = b.x - aRight;
      const y = Math.max(a.y, b.y) + Math.min(a.height, b.height) / 2;
      out.push(dimHorizontal(y, aRight, b.x, gap));
    } else if (bRight <= a.x) {
      const gap = a.x - bRight;
      const y = Math.max(a.y, b.y) + Math.min(a.height, b.height) / 2;
      out.push(dimHorizontal(y, bRight, a.x, gap));
    }
    if (aBottom <= b.y) {
      const gap = b.y - aBottom;
      const x = Math.max(a.x, b.x) + Math.min(a.width, b.width) / 2;
      out.push(dimVertical(x, aBottom, b.y, gap));
    } else if (bBottom <= a.y) {
      const gap = a.y - bBottom;
      const x = Math.max(a.x, b.x) + Math.min(a.width, b.width) / 2;
      out.push(dimVertical(x, bBottom, a.y, gap));
    }
    return out;
  }
  function insetDimLines(inner, outer) {
    return [
      dimVertical(inner.x + inner.width / 2, outer.y, inner.y, inner.y - outer.y),
      dimVertical(
        inner.x + inner.width / 2,
        inner.y + inner.height,
        outer.y + outer.height,
        outer.y + outer.height - (inner.y + inner.height)
      ),
      dimHorizontal(inner.y + inner.height / 2, outer.x, inner.x, inner.x - outer.x),
      dimHorizontal(
        inner.y + inner.height / 2,
        inner.x + inner.width,
        outer.x + outer.width,
        outer.x + outer.width - (inner.x + inner.width)
      )
    ].filter((d) => d.value > 0.5);
  }
  function isAutoLayoutContainer(node) {
    return (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") && "layoutMode" in node && node.layoutMode !== "NONE";
  }
  function isTarget(node) {
    return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE";
  }
  function boxOf(node) {
    const b = node.absoluteBoundingBox;
    if (!b) return null;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  function uniformRadius(node) {
    if (!("cornerRadius" in node)) return null;
    const r = node.cornerRadius;
    if (typeof r === "number" && r > 0) return Math.round(r);
    if ("topLeftRadius" in node && typeof node.topLeftRadius === "number" && node.topLeftRadius === node.topRightRadius && node.topLeftRadius === node.bottomLeftRadius && node.topLeftRadius === node.bottomRightRadius && node.topLeftRadius > 0) {
      return Math.round(node.topLeftRadius);
    }
    return null;
  }
  function paddingOf(node) {
    return {
      top: node.paddingTop,
      right: node.paddingRight,
      bottom: node.paddingBottom,
      left: node.paddingLeft
    };
  }
  function flowChildren(node) {
    const out = [];
    for (const child of node.children) {
      if (child.visible === false) continue;
      if ("layoutPositioning" in child && child.layoutPositioning === "ABSOLUTE") continue;
      out.push(child);
    }
    return out;
  }
  function isSpacingBound(node, field) {
    var _a;
    return ((_a = node.boundVariables) == null ? void 0 : _a[field]) !== void 0;
  }
  function isRadiusBound(node) {
    const bound = node.boundVariables;
    if (!bound) return false;
    return bound.cornerRadius !== void 0 || bound.topLeftRadius !== void 0 && bound.topRightRadius !== void 0 && bound.bottomLeftRadius !== void 0 && bound.bottomRightRadius !== void 0;
  }
  function pushBetween(gaps, a, b, axis, value, bound) {
    if (axis === "VERTICAL") {
      const y = a.y + a.height;
      const h = Math.max(0, b.y - y);
      gaps.push({
        value: Math.round(value),
        axis,
        bound,
        rect: {
          x: Math.min(a.x, b.x),
          y,
          width: Math.max(a.width, b.width),
          height: h > 0 ? h : value
        }
      });
      return;
    }
    const x = a.x + a.width;
    const w = Math.max(0, b.x - x);
    gaps.push({
      value: Math.round(value),
      axis,
      bound,
      rect: {
        x,
        y: Math.min(a.y, b.y),
        width: w > 0 ? w : value,
        height: Math.max(a.height, b.height)
      }
    });
  }
  function pushPairs(gaps, kids, axis, value, bound) {
    if (value <= 0 || kids.length < 2) return;
    for (let i = 0; i < kids.length - 1; i++) {
      const a = boxOf(kids[i]);
      const b = boxOf(kids[i + 1]);
      if (!a || !b) continue;
      pushBetween(gaps, a, b, axis, value, bound);
    }
  }
  function unionBox(nodes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    for (const node of nodes) {
      const box = boxOf(node);
      if (!box) continue;
      any = true;
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.width);
      maxY = Math.max(maxY, box.y + box.height);
    }
    if (!any) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  function splitWrapLines(node, kids) {
    const horizontal = node.layoutMode === "HORIZONTAL";
    const lines = [];
    let line = [];
    let prevMain = null;
    for (const kid of kids) {
      const box = boxOf(kid);
      if (!box) continue;
      const main = horizontal ? box.x : box.y;
      if (prevMain != null && main < prevMain - 0.5 && line.length) {
        lines.push(line);
        line = [];
      }
      line.push(kid);
      prevMain = main;
    }
    if (line.length) lines.push(line);
    return lines;
  }
  function collectGridGaps(node, gaps) {
    const rowGap = node.gridRowGap;
    const colGap = node.gridColumnGap;
    if (!(rowGap > 0) && !(colGap > 0)) return;
    const bound = isSpacingBound(node, "itemSpacing");
    const cells = [];
    for (const child of flowChildren(node)) {
      const box = boxOf(child);
      if (!box || !("gridRowAnchorIndex" in child) || !("gridColumnAnchorIndex" in child)) continue;
      try {
        const row = child.gridRowAnchorIndex;
        const col = child.gridColumnAnchorIndex;
        const rowSpan = "gridRowSpan" in child && typeof child.gridRowSpan === "number" ? child.gridRowSpan : 1;
        const colSpan = "gridColumnSpan" in child && typeof child.gridColumnSpan === "number" ? child.gridColumnSpan : 1;
        cells.push({ box, row, col, rowSpan, colSpan });
      } catch {
      }
    }
    const byCol = /* @__PURE__ */ new Map();
    const byRow = /* @__PURE__ */ new Map();
    for (const cell of cells) {
      let colList = byCol.get(cell.col);
      if (!colList) {
        colList = [];
        byCol.set(cell.col, colList);
      }
      colList.push(cell);
      let rowList = byRow.get(cell.row);
      if (!rowList) {
        rowList = [];
        byRow.set(cell.row, rowList);
      }
      rowList.push(cell);
    }
    if (colGap > 0) {
      for (const a of cells) {
        const next = byCol.get(a.col + a.colSpan);
        if (!next) continue;
        for (const b of next) {
          const rowOverlap = a.row < b.row + b.rowSpan && b.row < a.row + a.rowSpan;
          if (rowOverlap) pushBetween(gaps, a.box, b.box, "HORIZONTAL", colGap, bound);
        }
      }
    }
    if (rowGap > 0) {
      for (const a of cells) {
        const next = byRow.get(a.row + a.rowSpan);
        if (!next) continue;
        for (const b of next) {
          const colOverlap = a.col < b.col + b.colSpan && b.col < a.col + a.colSpan;
          if (colOverlap) pushBetween(gaps, a.box, b.box, "VERTICAL", rowGap, bound);
        }
      }
    }
  }
  function collectNodeGaps(node, gaps) {
    var _a;
    if (node.layoutMode === "GRID") {
      collectGridGaps(node, gaps);
      return;
    }
    const kids = flowChildren(node);
    const horizontal = node.layoutMode === "HORIZONTAL";
    const axis = horizontal ? "HORIZONTAL" : "VERTICAL";
    const gapBound = isSpacingBound(node, "itemSpacing");
    const primaryAuto = isPrimaryGapAuto(node);
    if (node.layoutWrap !== "WRAP") {
      if (!primaryAuto) pushPairs(gaps, kids, axis, node.itemSpacing, gapBound);
      return;
    }
    const lines = splitWrapLines(node, kids);
    if (!primaryAuto && node.itemSpacing > 0) {
      for (const line of lines) pushPairs(gaps, line, axis, node.itemSpacing, gapBound);
    }
    const cross = (_a = node.counterAxisSpacing) != null ? _a : 0;
    if (cross > 0 && lines.length >= 2 && !isCounterGapAuto(node)) {
      const crossBound = isSpacingBound(node, "counterAxisSpacing");
      const crossAxis = horizontal ? "VERTICAL" : "HORIZONTAL";
      for (let i = 0; i < lines.length - 1; i++) {
        const a = unionBox(lines[i]);
        const b = unionBox(lines[i + 1]);
        if (a && b) pushBetween(gaps, a, b, crossAxis, cross, crossBound);
      }
    }
  }
  function mergeSpecs(list) {
    if (list.length === 0) return null;
    if (list.length === 1) return list[0];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const paddingBands = [];
    const gaps = [];
    const radiusPills = [];
    const paddingPills = [];
    const gapPills = [];
    for (const s of list) {
      minX = Math.min(minX, s.bounds.x);
      minY = Math.min(minY, s.bounds.y);
      maxX = Math.max(maxX, s.bounds.x + s.bounds.width);
      maxY = Math.max(maxY, s.bounds.y + s.bounds.height);
      paddingBands.push(...s.paddingBands);
      gaps.push(...s.gaps);
      radiusPills.push(...s.radiusPills);
      paddingPills.push(...s.paddingPills);
      gapPills.push(...s.gapPills);
    }
    const bounds = {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
    return {
      bounds,
      outline: bounds,
      contentInset: null,
      radius: null,
      paddingBands,
      gaps,
      radiusPills,
      paddingPills,
      gapPills,
      sizeDims: sizeDimLines(bounds),
      distanceDims: []
    };
  }
  function addPadding(node, acc) {
    const bounds = boxOf(node);
    if (!bounds) return;
    const { top, right, bottom, left } = paddingOf(node);
    if (top > 0) {
      const bound = isSpacingBound(node, "paddingTop");
      acc.paddingBands.push({
        side: "top",
        value: Math.round(top),
        bound,
        rect: {
          x: bounds.x + left,
          y: bounds.y,
          width: Math.max(0, bounds.width - left - right),
          height: top
        }
      });
      acc.paddingPills.push({
        text: String(Math.round(top)),
        x: bounds.x + bounds.width / 2,
        y: bounds.y + top / 2,
        anchor: "center",
        value: Math.round(top),
        bound
      });
    }
    if (bottom > 0) {
      const bound = isSpacingBound(node, "paddingBottom");
      acc.paddingBands.push({
        side: "bottom",
        value: Math.round(bottom),
        bound,
        rect: {
          x: bounds.x + left,
          y: bounds.y + bounds.height - bottom,
          width: Math.max(0, bounds.width - left - right),
          height: bottom
        }
      });
      acc.paddingPills.push({
        text: String(Math.round(bottom)),
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height - bottom / 2,
        anchor: "center",
        value: Math.round(bottom),
        bound
      });
    }
    if (left > 0) {
      const bound = isSpacingBound(node, "paddingLeft");
      acc.paddingBands.push({
        side: "left",
        value: Math.round(left),
        bound,
        rect: {
          x: bounds.x,
          y: bounds.y + top,
          width: left,
          height: Math.max(0, bounds.height - top - bottom)
        }
      });
      acc.paddingPills.push({
        text: String(Math.round(left)),
        x: bounds.x + left / 2,
        y: bounds.y + bounds.height / 2,
        anchor: "center",
        value: Math.round(left),
        bound
      });
    }
    if (right > 0) {
      const bound = isSpacingBound(node, "paddingRight");
      acc.paddingBands.push({
        side: "right",
        value: Math.round(right),
        bound,
        rect: {
          x: bounds.x + bounds.width - right,
          y: bounds.y + top,
          width: right,
          height: Math.max(0, bounds.height - top - bottom)
        }
      });
      acc.paddingPills.push({
        text: String(Math.round(right)),
        x: bounds.x + bounds.width - right / 2,
        y: bounds.y + bounds.height / 2,
        anchor: "center",
        value: Math.round(right),
        bound
      });
    }
  }
  function addRadius(node, acc) {
    if (!isTarget(node)) return;
    const bounds = boxOf(node);
    const radius = uniformRadius(node);
    if (!bounds || radius == null) return;
    acc.radiusPills.push({
      text: `r ${radius}`,
      x: bounds.x + 4,
      y: bounds.y + 4,
      anchor: "top-left",
      value: radius,
      bound: isRadiusBound(node)
    });
  }
  function collectSpecs(node, depth, acc, budget) {
    if (depth > MAX_NEST_DEPTH || budget.n >= MAX_WALK_NODES) return;
    if (node.visible === false) return;
    budget.n++;
    if (isTarget(node)) {
      addRadius(node, acc);
      if (isAutoLayoutContainer(node)) {
        addPadding(node, acc);
        collectNodeGaps(node, acc.gaps);
      }
    }
    if ("children" in node) {
      for (const child of node.children) collectSpecs(child, depth + 1, acc, budget);
    }
  }
  function measure(node) {
    if (!isTarget(node)) return null;
    const bounds = boxOf(node);
    if (!bounds) return null;
    const acc = { paddingBands: [], gaps: [], radiusPills: [], paddingPills: [] };
    collectSpecs(node, 0, acc, { n: 0 });
    let contentInset = null;
    if (isAutoLayoutContainer(node)) {
      const { top, right, bottom, left } = paddingOf(node);
      if (top > 0 || right > 0 || bottom > 0 || left > 0) {
        contentInset = {
          x: bounds.x + left,
          y: bounds.y + top,
          width: Math.max(0, bounds.width - left - right),
          height: Math.max(0, bounds.height - top - bottom)
        };
      }
    }
    return {
      bounds,
      outline: bounds,
      contentInset,
      radius: uniformRadius(node),
      paddingBands: acc.paddingBands,
      gaps: acc.gaps,
      radiusPills: acc.radiusPills,
      paddingPills: acc.paddingPills,
      gapPills: [],
      sizeDims: sizeDimLines(bounds),
      distanceDims: []
    };
  }

  // src/options.ts
  var DEFAULT_COLORS = {
    radius: "#3373F2",
    padding: "#2EA35F",
    gap: "#F5C72E"
  };
  var DEFAULT_OPTIONS = {
    radius: true,
    padding: true,
    gap: true,
    layout: true,
    components: true,
    distance: true,
    colors: { ...DEFAULT_COLORS },
    labelFontSize: 8,
    pillSize: 1,
    overlayOpacity: 0.22,
    pillOpacity: 1
  };
  var OPTIONS_STORAGE_KEY = "design-specs-show-options";
  var IGNORED_LAYERS_STORAGE_KEY = "design-specs-ignored-layers";
  var HEX_RE = /^#?([0-9a-fA-F]{6})$/;
  function sanitizeHex(value, fallback) {
    if (typeof value !== "string") return fallback;
    const m = HEX_RE.exec(value.trim());
    if (!m) return fallback;
    return ("#" + m[1]).toUpperCase();
  }
  function sanitizeColors(raw) {
    const c = raw && typeof raw === "object" ? raw : {};
    return {
      radius: sanitizeHex(c.radius, DEFAULT_COLORS.radius),
      padding: sanitizeHex(c.padding, DEFAULT_COLORS.padding),
      gap: sanitizeHex(c.gap, DEFAULT_COLORS.gap)
    };
  }
  function clampLabelFontSize(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return DEFAULT_OPTIONS.labelFontSize;
    return Math.min(16, Math.max(6, Math.round(n)));
  }
  function clampPillSize(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return DEFAULT_OPTIONS.pillSize;
    return Math.min(2, Math.max(0.5, Math.round(n * 100) / 100));
  }
  function clampOverlayOpacity(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return DEFAULT_OPTIONS.overlayOpacity;
    return Math.min(1, Math.max(0.05, Math.round(n * 100) / 100));
  }
  function clampPillOpacity(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return DEFAULT_OPTIONS.pillOpacity;
    return Math.min(1, Math.max(0.05, Math.round(n * 100) / 100));
  }
  function hexToRgb(hex) {
    const m = HEX_RE.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return {
      r: (n >> 16 & 255) / 255,
      g: (n >> 8 & 255) / 255,
      b: (n & 255) / 255
    };
  }

  // src/overlay.ts
  var OVERLAY_MARK = "designSpecs";
  var PILL_MARK = "pill";
  var STICKY_EXTRA = "stickyExtra";
  var PILL_FIT = 14;
  function markStickyExtra(node) {
    node.setPluginData(STICKY_EXTRA, "1");
  }
  function takeBudget(items, limit, prefer) {
    if (items.length <= limit) return items.slice();
    const priority = [];
    const rest = [];
    for (const item of items) {
      if (prefer(item)) priority.push(item);
      else rest.push(item);
    }
    if (priority.length >= limit) return priority.slice(0, limit);
    return [...priority, ...rest.slice(0, limit - priority.length)];
  }
  var liveOverlay = null;
  function findLiveOverlay() {
    if (liveOverlay && !liveOverlay.removed) return liveOverlay;
    liveOverlay = null;
    for (const child of figma.currentPage.children) {
      if (child.name !== OVERLAY_NAME || child.type !== "GROUP") continue;
      if (child.getPluginData(OVERLAY_MARK) === "1") {
        liveOverlay = child;
        return liveOverlay;
      }
    }
    return null;
  }
  function removeExistingOverlay() {
    liveOverlay = null;
    for (const child of [...figma.currentPage.children]) {
      if (child.name !== OVERLAY_NAME) continue;
      const marked = child.getPluginData(OVERLAY_MARK) === "1";
      const legacy = "locked" in child && child.locked;
      if (marked || legacy) child.remove();
    }
  }
  function placePill(frame, x, y, anchor) {
    const w = frame.width;
    const h = frame.height;
    if (anchor === "center") {
      frame.x = x - w / 2;
      frame.y = y - h / 2;
    } else if (anchor === "top-left") {
      frame.x = x;
      frame.y = y;
    } else {
      frame.x = x - w / 2;
      frame.y = y;
    }
  }
  function solidPaint(color, opacity = 1) {
    return { type: "SOLID", color, opacity };
  }
  function sameColor(a, b) {
    return Math.abs(a.r - b.r) < 0.01 && Math.abs(a.g - b.g) < 0.01 && Math.abs(a.b - b.b) < 0.01;
  }
  function pillScale(spacePx) {
    const bySpace = spacePx > 0 ? spacePx / PILL_FIT : 1;
    return Math.max(0.08, Math.min(1.5, bySpace));
  }
  function makeRect(name, rect, opts) {
    const r = figma.createRectangle();
    r.name = name;
    r.x = rect.x;
    r.y = rect.y;
    r.resize(Math.max(rect.width, 0.01), Math.max(rect.height, 0.01));
    r.fills = [solidPaint(opts.color, opts.fillOpacity)];
    r.strokes = [];
    return r;
  }
  function makeDashedBorder(name, rect, color) {
    const r = figma.createRectangle();
    r.name = name;
    r.x = rect.x;
    r.y = rect.y;
    r.resize(Math.max(rect.width, 0.01), Math.max(rect.height, 0.01));
    r.fills = [];
    r.strokes = [solidPaint(color, 1)];
    r.strokeWeight = OUTLINE_STROKE_WEIGHT;
    r.dashPattern = DASH_PATTERN;
    return r;
  }
  function gapLabelPoint(gap) {
    return {
      x: gap.rect.x + gap.rect.width / 2,
      y: gap.rect.y + gap.rect.height / 2
    };
  }
  function matchesFocus(value, focusValue) {
    if (focusValue == null) return true;
    if (value == null) return false;
    return Math.abs(value - focusValue) < 1e-3;
  }
  function makePill(pill, color, scale, style, spacePx, opacity = 1) {
    const frame = figma.createFrame();
    frame.name = `label:${pill.text}`;
    frame.layoutMode = "HORIZONTAL";
    frame.primaryAxisSizingMode = "AUTO";
    frame.counterAxisSizingMode = "AUTO";
    const size = style.pillSize;
    const padX = Math.max(0.5, PILL_PAD_X * size * scale);
    const padY = Math.max(0.25, PILL_PAD_Y * size * scale);
    frame.paddingLeft = padX;
    frame.paddingRight = padX;
    frame.paddingTop = padY;
    frame.paddingBottom = padY;
    frame.cornerRadius = Math.max(0.5, PILL_RADIUS * size * scale);
    frame.fills = [solidPaint(color, opacity)];
    frame.strokes = [];
    frame.primaryAxisAlignItems = "CENTER";
    frame.counterAxisAlignItems = "CENTER";
    frame.setPluginData(PILL_MARK, "1");
    frame.setPluginData("spacePx", String(spacePx));
    frame.setPluginData("anchor", pill.anchor);
    frame.setPluginData("ax", String(pill.x));
    frame.setPluginData("ay", String(pill.y));
    if (pill.value != null) frame.setPluginData("spacingValue", String(pill.value));
    if (sameColor(color, RED)) frame.setPluginData("error", "1");
    const text = figma.createText();
    text.fontName = labelFont;
    text.fontSize = Math.max(1, Math.round(style.labelFontSize * scale * 10) / 10);
    text.characters = pill.text;
    text.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity }];
    frame.appendChild(text);
    placePill(frame, pill.x, pill.y, pill.anchor);
    return frame;
  }
  function kindColor(kind, options2) {
    var _a, _b, _c, _d, _e, _f;
    const hex = kind === "padding" ? (_b = (_a = options2.colors) == null ? void 0 : _a.padding) != null ? _b : DEFAULT_COLORS.padding : kind === "gap" ? (_d = (_c = options2.colors) == null ? void 0 : _c.gap) != null ? _d : DEFAULT_COLORS.gap : (_f = (_e = options2.colors) == null ? void 0 : _e.radius) != null ? _f : DEFAULT_COLORS.radius;
    const parsed = hexToRgb(hex);
    if (parsed) return parsed;
    if (kind === "padding") return GREEN_PAD;
    if (kind === "gap") return YELLOW_GAP;
    return BLUE_RADIUS;
  }
  function pillColor(kind, opts, options2) {
    if (opts.bound === false) return RED;
    return kindColor(kind, options2);
  }
  function bandColor(bound, soft) {
    if (bound === false) return RED;
    return soft;
  }
  function pushBand(soft, hard, node, color) {
    if (sameColor(color, RED)) hard.push(node);
    else soft.push(node);
  }
  function makeDimNodes(dim, color, sticky = false) {
    const nodes = [];
    const thick = DIM_STROKE_WEIGHT;
    if (dim.axis === "HORIZONTAL") {
      const line = figma.createRectangle();
      line.name = `dim-h-${dim.value}`;
      line.x = dim.x1;
      line.y = dim.y1 - thick / 2;
      line.resize(Math.max(dim.x2 - dim.x1, 0.01), thick);
      line.fills = [solidPaint(color, 1)];
      line.strokes = [];
      nodes.push(line);
      const tickL = figma.createRectangle();
      tickL.name = "tick";
      tickL.x = dim.x1 - thick / 2;
      tickL.y = dim.y1 - DIM_TICK / 2;
      tickL.resize(thick, DIM_TICK);
      tickL.fills = [solidPaint(color, 1)];
      tickL.strokes = [];
      nodes.push(tickL);
      const tickR = figma.createRectangle();
      tickR.name = "tick";
      tickR.x = dim.x2 - thick / 2;
      tickR.y = dim.y1 - DIM_TICK / 2;
      tickR.resize(thick, DIM_TICK);
      tickR.fills = [solidPaint(color, 1)];
      tickR.strokes = [];
      nodes.push(tickR);
    } else {
      const line = figma.createRectangle();
      line.name = `dim-v-${dim.value}`;
      line.x = dim.x1 - thick / 2;
      line.y = dim.y1;
      line.resize(thick, Math.max(dim.y2 - dim.y1, 0.01));
      line.fills = [solidPaint(color, 1)];
      line.strokes = [];
      nodes.push(line);
      const tickT = figma.createRectangle();
      tickT.name = "tick";
      tickT.x = dim.x1 - DIM_TICK / 2;
      tickT.y = dim.y1 - thick / 2;
      tickT.resize(DIM_TICK, thick);
      tickT.fills = [solidPaint(color, 1)];
      tickT.strokes = [];
      nodes.push(tickT);
      const tickB = figma.createRectangle();
      tickB.name = "tick";
      tickB.x = dim.x1 - DIM_TICK / 2;
      tickB.y = dim.y2 - thick / 2;
      tickB.resize(DIM_TICK, thick);
      tickB.fills = [solidPaint(color, 1)];
      tickB.strokes = [];
      nodes.push(tickB);
    }
    if (sticky) {
      for (const n of nodes) markStickyExtra(n);
    }
    return nodes;
  }
  function removeStickyExtras(group) {
    const doomed = [];
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.getPluginData(STICKY_EXTRA) === "1") doomed.push(node);
        else if ("children" in node) walk(node.children);
      }
    };
    walk(group.children);
    for (const node of doomed) {
      if (!node.removed) node.remove();
    }
  }
  function patchStickyOverlayExtras(group, options2, extras) {
    var _a, _b, _c;
    const wasLocked = group.locked;
    if (wasLocked) group.locked = false;
    const pillStyle = {
      labelFontSize: (_a = options2.labelFontSize) != null ? _a : LABEL_FONT_SIZE,
      pillSize: (_b = options2.pillSize) != null ? _b : 1
    };
    const pillOpacity = (_c = options2.pillOpacity) != null ? _c : 1;
    try {
      removeStickyExtras(group);
      const add = [];
      if (options2.distance) {
        for (const dim of extras.distanceDims) {
          add.push(...makeDimNodes(dim, GRAY, true));
          const len = dim.axis === "HORIZONTAL" ? Math.abs(dim.x2 - dim.x1) : Math.abs(dim.y2 - dim.y1);
          const space = Math.max(len * 0.15, 8);
          const pill = makePill(
            dim.label,
            GRAY,
            pillScale(space),
            pillStyle,
            space,
            pillOpacity
          );
          markStickyExtra(pill);
          add.push(pill);
        }
      }
      if (options2.components) {
        for (let i = 0; i < extras.componentRects.length; i++) {
          const border = makeDashedBorder(
            `not-component-${i}`,
            extras.componentRects[i],
            PURPLE
          );
          markStickyExtra(border);
          add.push(border);
        }
      }
      for (const node of add) group.appendChild(node);
    } finally {
      if (wasLocked) group.locked = true;
    }
  }
  async function drawOverlay(specs, options2, highlights = { layoutRects: [], componentRects: [] }, stillValid = () => true, extras = {}) {
    var _a, _b, _c, _d, _e, _f, _g;
    const focusValue = (_a = extras.focusValue) != null ? _a : null;
    const anyOn = options2.radius || options2.padding || options2.gap || options2.layout || options2.components || options2.distance;
    const softUnder = [];
    const hardUnder = [];
    const softPills = [];
    const hardPills = [];
    const queuedPills = [];
    const pillStyle = {
      labelFontSize: (_b = options2.labelFontSize) != null ? _b : LABEL_FONT_SIZE,
      pillSize: (_c = options2.pillSize) != null ? _c : 1
    };
    const pillOpacity = (_d = options2.pillOpacity) != null ? _d : 1;
    const padSoft = kindColor("padding", options2);
    const gapSoft = kindColor("gap", options2);
    const queuePill = (pill, color, spacePx, stickyExtra = false) => {
      queuedPills.push({ pill, color, spacePx, stickyExtra });
    };
    const flushPills = () => {
      const priority = [];
      const rest = [];
      for (const item of queuedPills) {
        const isError = sameColor(item.color, RED);
        const focused = focusValue != null && matchesFocus(item.pill.value, focusValue);
        if (isError || focused) priority.push(item);
        else rest.push(item);
      }
      const chosen = priority.length >= COMPACT_MAX ? priority.slice(0, COMPACT_MAX) : [...priority, ...rest.slice(0, COMPACT_MAX - priority.length)];
      for (const item of chosen) {
        const node = makePill(
          item.pill,
          item.color,
          pillScale(item.spacePx),
          pillStyle,
          item.spacePx,
          pillOpacity
        );
        if (item.stickyExtra) markStickyExtra(node);
        if (sameColor(item.color, RED)) hardPills.push(node);
        else softPills.push(node);
      }
    };
    if (specs && options2.padding) {
      const bands = specs.paddingBands.filter((band) => matchesFocus(band.value, focusValue));
      const chosen = takeBudget(bands, COMPACT_MAX, (band) => band.bound === false);
      for (const band of chosen) {
        const color = bandColor(band.bound, padSoft);
        pushBand(
          softUnder,
          hardUnder,
          makeRect(`pad-${band.side}`, band.rect, {
            color,
            fillOpacity: (_e = options2.overlayOpacity) != null ? _e : PAD_FILL_OPACITY
          }),
          color
        );
      }
    }
    if (specs && options2.gap) {
      const gaps = specs.gaps.filter((gap) => matchesFocus(gap.value, focusValue));
      const chosen = takeBudget(gaps, COMPACT_MAX, (gap) => gap.bound === false);
      for (const gap of chosen) {
        const color = bandColor(gap.bound, gapSoft);
        pushBand(
          softUnder,
          hardUnder,
          makeRect(`gap-fill`, gap.rect, {
            color,
            fillOpacity: (_f = options2.overlayOpacity) != null ? _f : GAP_FILL_OPACITY
          }),
          color
        );
      }
    }
    if (anyOn && options2.layout) {
      for (let i = 0; i < highlights.layoutRects.length; i++) {
        softUnder.push(makeDashedBorder(`layout-${i}`, highlights.layoutRects[i], GRAY));
      }
    }
    if (anyOn && options2.components) {
      for (let i = 0; i < highlights.componentRects.length; i++) {
        const border = makeDashedBorder(
          `not-component-${i}`,
          highlights.componentRects[i],
          PURPLE
        );
        markStickyExtra(border);
        softUnder.push(border);
      }
    }
    if (specs && options2.distance && focusValue == null) {
      for (const dim of specs.distanceDims) {
        softUnder.push(...makeDimNodes(dim, GRAY, true));
        const len = dim.axis === "HORIZONTAL" ? Math.abs(dim.x2 - dim.x1) : Math.abs(dim.y2 - dim.y1);
        queuePill(dim.label, GRAY, Math.max(len * 0.15, 8), true);
      }
    }
    if (anyOn && specs && options2.radius && focusValue == null) {
      for (const pill of specs.radiusPills) {
        const space = pill.value != null ? Math.max(pill.value, 8) : 12;
        queuePill(
          pill,
          pillColor("radius", { bound: pill.bound }, options2),
          space
        );
      }
    }
    if (anyOn && specs && options2.padding) {
      for (let i = 0; i < specs.paddingPills.length; i++) {
        const pill = specs.paddingPills[i];
        if (!matchesFocus(pill.value, focusValue)) continue;
        const band = specs.paddingBands[i];
        const space = band ? Math.min(band.rect.width, band.rect.height) : (_g = pill.value) != null ? _g : 8;
        queuePill(
          pill,
          pillColor("padding", { bound: pill.bound }, options2),
          space
        );
      }
    }
    if (anyOn && specs && options2.gap) {
      for (const gap of specs.gaps) {
        if (!matchesFocus(gap.value, focusValue)) continue;
        const pt = gapLabelPoint(gap);
        const space = Math.min(gap.rect.width, gap.rect.height);
        queuePill(
          {
            text: String(gap.value),
            x: pt.x,
            y: pt.y,
            anchor: "center",
            value: gap.value,
            bound: gap.bound
          },
          pillColor("gap", { bound: gap.bound }, options2),
          space
        );
      }
    }
    flushPills();
    const nodes = [...softUnder, ...hardUnder, ...softPills, ...hardPills];
    if (!stillValid()) {
      for (const node of nodes) node.remove();
      return null;
    }
    removeExistingOverlay();
    if (nodes.length === 0) {
      liveOverlay = null;
      return null;
    }
    const group = figma.group(nodes, figma.currentPage);
    group.name = OVERLAY_NAME;
    group.setPluginData(OVERLAY_MARK, "1");
    group.locked = true;
    figma.currentPage.appendChild(group);
    liveOverlay = group;
    return group;
  }

  // src/code.ts
  var options = { ...DEFAULT_OPTIONS, colors: { ...DEFAULT_OPTIONS.colors } };
  var ignoredLayers = [];
  var fontReady = null;
  var passId = 0;
  var ignoreMemo = /* @__PURE__ */ new Map();
  var flatIssues = [];
  var layoutFlatIssues = [];
  var lastMatches = [];
  var lintRootIds = [];
  var focusSpacingValue = null;
  var lastSpacingValues = [];
  var lastCoverage = 100;
  var selectionDebounceTimer = null;
  var cachedSpecs = null;
  var cachedSpecsRootKey = "";
  var forceFullLint = false;
  var SELECTION_DEBOUNCE_MS = 120;
  function rootsKey(roots) {
    return roots.map((r) => r.id).join("\0");
  }
  function clearSpecsCache() {
    cachedSpecs = null;
    cachedSpecsRootKey = "";
  }
  var lastIssues = {
    spacing: [],
    border: [],
    color: [],
    type: [],
    opacity: [],
    effects: [],
    stroke: [],
    layout: [],
    detached: []
  };
  function isSupported(node) {
    return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE";
  }
  function isUnderRoot(node, root) {
    let cur = node;
    while (cur) {
      if (cur.id === root.id) return true;
      if (cur.type === "PAGE" || cur.type === "DOCUMENT") return false;
      cur = cur.parent;
    }
    return false;
  }
  function isUnderAnyRoot(node, roots) {
    return roots.some((root) => isUnderRoot(node, root));
  }
  function nestCollapse(nodes) {
    return nodes.filter((node) => !nodes.some((other) => other !== node && isUnderRoot(node, other)));
  }
  function resolveRootsFromSelection(selection) {
    return nestCollapse(selection.filter(isSupported));
  }
  async function resolveLintRoots() {
    const roots = [];
    for (const id of lintRootIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node || node.type === "DOCUMENT" || node.type === "PAGE") continue;
      const scene = node;
      if (isSupported(scene)) roots.push(scene);
    }
    return roots;
  }
  async function rectsForIds(ids) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = await figma.getNodeByIdAsync(id);
      if (!node || node.type === "DOCUMENT" || node.type === "PAGE") continue;
      const b = node.absoluteBoundingBox;
      if (!b) continue;
      out.push({ x: b.x, y: b.y, width: b.width, height: b.height });
    }
    return out;
  }
  function selectionDistanceDims() {
    if (!options.distance) return [];
    const sel = figma.currentPage.selection;
    if (sel.length !== 2) return [];
    const a = sel[0].absoluteBoundingBox;
    const b = sel[1].absoluteBoundingBox;
    if (!a || !b) return [];
    return distanceDimLines(
      { x: a.x, y: a.y, width: a.width, height: a.height },
      { x: b.x, y: b.y, width: b.width, height: b.height }
    );
  }
  async function paintOverlay(roots, gen, specsIn) {
    const stale = () => gen !== void 0 && gen !== passId;
    await ensureFont();
    if (stale()) return;
    let specs;
    if (specsIn !== void 0) {
      specs = specsIn;
    } else if (cachedSpecs && cachedSpecsRootKey === rootsKey(roots)) {
      specs = cachedSpecs;
    } else {
      const measured = [];
      for (const root of roots) {
        const next = measure(root);
        if (next) measured.push(next);
      }
      specs = mergeSpecs(measured);
      cachedSpecs = specs;
      cachedSpecsRootKey = rootsKey(roots);
    }
    if (specs) {
      specs.distanceDims = selectionDistanceDims();
      specs.sizeDims = [];
      lastSpacingValues = distinctSpacingValues(specs);
    } else {
      lastSpacingValues = [];
    }
    figma.ui.postMessage({
      type: "spacing-values",
      values: lastSpacingValues,
      focusValue: focusSpacingValue
    });
    const layoutSource = options.layout ? await withoutIgnored(layoutFlatIssues) : [];
    if (stale()) return;
    const layoutRects = options.layout ? await rectsForIds(layoutSource.map((i) => i.nodeId)) : [];
    const componentRects = options.components ? await rectsForIds(lastMatches.map((m) => m.nodeId)) : [];
    if (stale()) return;
    await drawOverlay(
      specs,
      options,
      { layoutRects, componentRects },
      () => !stale(),
      { focusValue: focusSpacingValue }
    );
  }
  async function clearLintTarget(status, gen) {
    if (gen !== passId) return;
    lintRootIds = [];
    clearSpecsCache();
    const live = await refreshLint([], gen);
    if (!live) return;
    await paintOverlay([], gen, null);
    if (gen !== passId) return;
    setStatus(status);
  }
  async function applyLintTarget(roots, gen) {
    if (gen !== passId) return;
    if (roots.length === 0) {
      await clearLintTarget("Select a frame", gen);
      return;
    }
    await postScanning();
    if (gen !== passId) return;
    const measured = [];
    for (const root of roots) {
      const specs = measure(root);
      if (specs) measured.push(specs);
    }
    if (gen !== passId) return;
    if (measured.length === 0) {
      await clearLintTarget("Could not read bounds", gen);
      return;
    }
    lintRootIds = roots.map((r) => r.id);
    cachedSpecs = mergeSpecs(measured);
    cachedSpecsRootKey = rootsKey(roots);
    const live = await refreshLint(roots, gen);
    if (!live) return;
    await paintOverlay(roots, gen, cachedSpecs);
    if (gen !== passId) return;
    setStatus(roots.length === 1 ? "Specs on canvas" : `${roots.length} frames`);
  }
  async function loadLabelFont() {
    const candidates = [
      labelFont,
      { family: "Inter", style: "Regular" },
      { family: "Roboto", style: "Medium" },
      { family: "Roboto", style: "Regular" }
    ];
    for (const font of candidates) {
      try {
        await figma.loadFontAsync(font);
        setLabelFont(font);
        return;
      } catch {
      }
    }
    throw new Error("No label font available");
  }
  function ensureFont() {
    if (!fontReady) {
      fontReady = loadLabelFont().catch((err) => {
        fontReady = null;
        throw err;
      });
    }
    return fontReady;
  }
  function setStatus(message) {
    figma.ui.postMessage({ type: "status", message });
  }
  async function postScanning() {
    figma.ui.postMessage({ type: "lint-scanning" });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  function ignoredIdSet() {
    return new Set(ignoredLayers.map((l) => l.id));
  }
  async function nodeIgnored(nodeId) {
    const known = ignoreMemo.get(nodeId);
    if (known !== void 0) return known;
    const ignored = ignoredIdSet();
    if (ignored.size === 0) {
      ignoreMemo.set(nodeId, false);
      return false;
    }
    const start = await figma.getNodeByIdAsync(nodeId);
    if (!start) {
      ignoreMemo.set(nodeId, false);
      return false;
    }
    const chain = [];
    let cur = start;
    let hidden = false;
    while (cur) {
      const seen = ignoreMemo.get(cur.id);
      if (seen !== void 0) {
        hidden = seen;
        break;
      }
      if (cur.type === "PAGE" || cur.type === "DOCUMENT") break;
      chain.push(cur.id);
      if (ignored.has(cur.id)) {
        hidden = true;
        break;
      }
      cur = cur.parent;
    }
    for (const id of chain) ignoreMemo.set(id, hidden);
    return hidden;
  }
  async function withoutIgnored(issues) {
    const out = [];
    for (const issue of issues) {
      if (!await nodeIgnored(issue.nodeId)) out.push(issue);
    }
    return out;
  }
  function sendLint(visible, visibleLayout) {
    const fixableCount = visible.filter((i) => i.fixable).length;
    figma.ui.postMessage({
      type: "lint-results",
      issues: visible,
      ignoredLayers,
      fixableCount,
      totalCount: visible.length,
      coveragePercent: lastCoverage
    });
    figma.ui.postMessage({
      type: "layout-results",
      issues: visibleLayout,
      totalCount: visibleLayout.length
    });
  }
  async function postLintResults() {
    ignoreMemo.clear();
    sendLint(await withoutIgnored(flatIssues), await withoutIgnored(layoutFlatIssues));
  }
  function selectionHasFrameTargets(selection) {
    return selection.some((n) => n.type === "FRAME");
  }
  async function refreshComponentMatches(selection, gen, opts) {
    if (!options.components) {
      lastMatches = [];
      if (gen === passId) {
        figma.ui.postMessage({ type: "component-matches", matches: lastMatches });
      }
      return;
    }
    if ((opts == null ? void 0 : opts.skipCatalogIfNoFrames) && !selectionHasFrameTargets(selection)) {
      if (lastMatches.length) {
        lastMatches = [];
        if (gen === passId) {
          figma.ui.postMessage({ type: "component-matches", matches: lastMatches });
        }
      }
      return;
    }
    beginComponentPass();
    const matches = matchSelection(selection);
    const withPreviews = await attachCandidatePreviews(matches);
    if (gen !== passId) return;
    lastMatches = withPreviews;
    figma.ui.postMessage({ type: "component-matches", matches: lastMatches });
  }
  async function stickyOverlayUpdate(roots, gen) {
    const overlay = findLiveOverlay();
    const cacheOk = !!(cachedSpecs && cachedSpecsRootKey === rootsKey(roots));
    if (!overlay || !cacheOk) {
      await paintOverlay(roots, gen);
      return;
    }
    const needDistance = options.distance;
    const needComponents = options.components;
    if (!needDistance && !needComponents) {
      return;
    }
    await ensureFont();
    if (gen !== passId) return;
    const componentRects = needComponents ? await rectsForIds(lastMatches.map((m) => m.nodeId)) : [];
    if (gen !== passId) return;
    try {
      patchStickyOverlayExtras(overlay, options, {
        distanceDims: needDistance ? selectionDistanceDims() : [],
        componentRects
      });
    } catch {
      await paintOverlay(roots, gen);
    }
  }
  function invalidateSessionCaches() {
    clearTokenIndexCache();
    clearStyleCaches();
    beginComponentPass();
  }
  async function focusNode(nodeId) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
      setStatus("Node not found");
      return;
    }
    const scene = node;
    figma.currentPage.selection = [scene];
    figma.viewport.scrollAndZoomIntoView([scene]);
  }
  async function revealNode(nodeId) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
      setStatus("Node not found");
      return;
    }
    figma.viewport.scrollAndZoomIntoView([node]);
  }
  async function refreshLint(roots, gen) {
    if (gen !== passId) return false;
    if (roots.length === 0) {
      if (gen !== passId) return false;
      for (const key of Object.keys(lastIssues)) {
        lastIssues[key] = [];
      }
      flatIssues = [];
      layoutFlatIssues = [];
      lastCoverage = 100;
      sendLint([], []);
      return true;
    }
    const tokens = await loadTokenIndex();
    if (gen !== passId) return false;
    const paintStyles = await loadPaintStyles();
    const textStyles = await loadTextStyles();
    const effectStyles = await loadEffectStyles();
    if (gen !== passId) return false;
    const spacingIssues = [];
    const borderIssues = [];
    const colorIssues = [];
    const typeIssues = [];
    const opacityIssues = [];
    const effectsIssues = [];
    const strokeIssues = [];
    const layoutIssues = [];
    const detachedIssues = [];
    let checkedCount = 0;
    for (const root of roots) {
      if (gen !== passId) return false;
      const scan = scanLintTree(root);
      const spacing = await lintSpacing(root, tokens, scan.autoLayout);
      const border = await lintBorder(root, tokens, scan.radius);
      const color = await lintColor(root, tokens, scan.geometry, paintStyles);
      const type = await lintTypography(root, tokens, scan.text, textStyles);
      const opacity = await lintOpacity(root, tokens, scan.blend);
      const effects = await lintEffects(root, tokens, scan.effect, effectStyles);
      const stroke = await lintStroke(root, tokens, scan.stroke, paintStyles);
      const layout = await lintLayout(root, scan.layoutContainers);
      const detached = options.components ? await lintDetached(root) : { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
      spacingIssues.push(...spacing.issues);
      borderIssues.push(...border.issues);
      colorIssues.push(...color.issues);
      typeIssues.push(...type.issues);
      opacityIssues.push(...opacity.issues);
      effectsIssues.push(...effects.issues);
      strokeIssues.push(...stroke.issues);
      layoutIssues.push(...layout.issues);
      detachedIssues.push(...detached.issues);
      checkedCount += (spacing.checkedCount || 0) + (border.checkedCount || 0) + (color.checkedCount || 0) + (type.checkedCount || 0) + (opacity.checkedCount || 0) + (effects.checkedCount || 0) + (stroke.checkedCount || 0);
    }
    if (gen !== passId) return false;
    const nextFlat = flattenIssues([
      spacingIssues,
      borderIssues,
      colorIssues,
      typeIssues,
      opacityIssues,
      effectsIssues,
      strokeIssues
    ]);
    const nextLayout = [...layoutIssues, ...detachedIssues].map(toFlatIssue);
    ignoreMemo.clear();
    const visible = await withoutIgnored(nextFlat);
    const visibleLayout = await withoutIgnored(nextLayout);
    if (gen !== passId) return false;
    lastCoverage = coveragePercent(checkedCount, visible.length);
    lastIssues.spacing = spacingIssues;
    lastIssues.border = borderIssues;
    lastIssues.color = colorIssues;
    lastIssues.type = typeIssues;
    lastIssues.opacity = opacityIssues;
    lastIssues.effects = effectsIssues;
    lastIssues.stroke = strokeIssues;
    lastIssues.layout = layoutIssues;
    lastIssues.detached = detachedIssues;
    flatIssues = nextFlat;
    layoutFlatIssues = nextLayout;
    sendLint(visible, visibleLayout);
    return true;
  }
  async function drawSelection() {
    const gen = ++passId;
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      await refreshComponentMatches(selection, gen);
      if (gen !== passId) return;
      await clearLintTarget("Select a frame", gen);
      return;
    }
    if (lintRootIds.length > 0) {
      const stickyRoots = await resolveLintRoots();
      if (gen !== passId) return;
      if (stickyRoots.length > 0 && selection.every((node) => isUnderAnyRoot(node, stickyRoots))) {
        if (!forceFullLint) {
          await refreshComponentMatches(selection, gen, { skipCatalogIfNoFrames: true });
          if (gen !== passId) return;
          await stickyOverlayUpdate(stickyRoots, gen);
          return;
        }
        forceFullLint = false;
        await refreshComponentMatches(selection, gen);
        if (gen !== passId) return;
        await applyLintTarget(stickyRoots, gen);
        return;
      }
    }
    forceFullLint = false;
    await refreshComponentMatches(selection, gen);
    if (gen !== passId) return;
    const roots = resolveRootsFromSelection(selection);
    if (roots.length > 0) {
      await applyLintTarget(roots, gen);
      return;
    }
    await clearLintTarget("Select a frame, component, or instance", gen);
  }
  async function loadOptions() {
    const saved = await figma.clientStorage.getAsync(OPTIONS_STORAGE_KEY);
    if (!saved || typeof saved !== "object") {
      return {
        ...DEFAULT_OPTIONS,
        colors: { ...DEFAULT_OPTIONS.colors }
      };
    }
    const s = saved;
    return {
      radius: typeof s.radius === "boolean" ? s.radius : DEFAULT_OPTIONS.radius,
      padding: typeof s.padding === "boolean" ? s.padding : DEFAULT_OPTIONS.padding,
      gap: typeof s.gap === "boolean" ? s.gap : DEFAULT_OPTIONS.gap,
      layout: typeof s.layout === "boolean" ? s.layout : DEFAULT_OPTIONS.layout,
      components: typeof s.components === "boolean" ? s.components : DEFAULT_OPTIONS.components,
      distance: typeof s.distance === "boolean" ? s.distance : DEFAULT_OPTIONS.distance,
      colors: sanitizeColors(s.colors),
      labelFontSize: clampLabelFontSize(s.labelFontSize),
      pillSize: clampPillSize(s.pillSize),
      overlayOpacity: clampOverlayOpacity(s.overlayOpacity),
      pillOpacity: clampPillOpacity(s.pillOpacity)
    };
  }
  async function saveOptions(next) {
    options = next;
    await figma.clientStorage.setAsync(OPTIONS_STORAGE_KEY, next);
  }
  function fileBucket() {
    return figma.fileKey || "draft";
  }
  function sanitizeIgnored(saved) {
    if (!Array.isArray(saved)) return [];
    const out = [];
    for (const item of saved) {
      if (item && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string") {
        out.push({ id: item.id, name: item.name });
      }
    }
    return out;
  }
  async function writeIgnored(next) {
    const saved = await figma.clientStorage.getAsync(IGNORED_LAYERS_STORAGE_KEY);
    const map = saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } : {};
    map[fileBucket()] = next;
    await figma.clientStorage.setAsync(IGNORED_LAYERS_STORAGE_KEY, map);
  }
  async function loadIgnoredLayers() {
    const saved = await figma.clientStorage.getAsync(IGNORED_LAYERS_STORAGE_KEY);
    const bucket = fileBucket();
    const list = saved && typeof saved === "object" && !Array.isArray(saved) ? sanitizeIgnored(saved[bucket]) : [];
    const kept = [];
    for (const item of list) {
      const node = await figma.getNodeByIdAsync(item.id);
      if (node) kept.push(item);
    }
    if (kept.length !== list.length) await writeIgnored(kept);
    return kept;
  }
  async function saveIgnoredLayers(next) {
    ignoredLayers = next;
    ignoreMemo.clear();
    await writeIgnored(next);
  }
  async function ignoreLayer(nodeId, name) {
    if (ignoredLayers.some((l) => l.id === nodeId)) {
      await postLintResults();
      return;
    }
    let layerName = name || "Untitled";
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node && "name" in node && typeof node.name === "string" && node.name) {
      layerName = node.name;
    }
    await saveIgnoredLayers([...ignoredLayers, { id: nodeId, name: layerName }]);
    await postLintResults();
    await paintOverlay(await resolveLintRoots());
  }
  async function unignoreLayer(nodeId) {
    await saveIgnoredLayers(ignoredLayers.filter((l) => l.id !== nodeId));
    await postLintResults();
    await paintOverlay(await resolveLintRoots());
  }
  function findRawIssue(flatId) {
    var _a, _b;
    for (const group of Object.values(lastIssues)) {
      for (const issue of group) {
        const id = `${issue.nodeId}:${issue.kind}:${(_b = (_a = issue.paintIndex) != null ? _a : issue.effectIndex) != null ? _b : ""}:${issue.field}`;
        if (id === flatId) return issue;
      }
    }
    return null;
  }
  function withSelectedVariable(raw, flat, selections) {
    const byIssue = selections.find((s) => s.issueId === flat.id);
    if (byIssue == null ? void 0 : byIssue.variableId) return { ...raw, variableId: byIssue.variableId };
    if (flat.tokenCandidates.length === 1) {
      return { ...raw, variableId: flat.tokenCandidates[0].id };
    }
    return raw;
  }
  async function applyOne(flat, selections, allowNearest) {
    const found = findRawIssue(flat.id);
    if (!found || !isIssueApplyable(found, allowNearest)) return 0;
    const raw = withSelectedVariable(found, flat, selections);
    switch (raw.kind) {
      case "spacing":
        return applySpacingTokens([raw]);
      case "border-radius":
        return applyBorderTokens([raw]);
      case "color-fill":
        return applyColorTokens([raw], selections);
      case "typography":
        return applyTypographyTokens([raw], selections);
      case "opacity":
        return applyOpacityTokens([raw]);
      case "effect":
        return applyEffectTokens([raw], selections);
      case "stroke-weight":
      case "stroke-color":
        return applyStrokeTokens([raw], selections);
      default:
        return 0;
    }
  }
  async function applyMany(ids, selections, allowNearest) {
    const visible = await withoutIgnored(flatIssues);
    const targets = selectApplyTargets(visible, ids, allowNearest);
    let fixed = 0;
    for (const flat of targets) {
      fixed += await applyOne(flat, selections, allowNearest);
    }
    if (fixed > 0) invalidateSessionCaches();
    return fixed;
  }
  figma.showUI(__html__, { width: 360, height: 640, themeColors: true });
  function scheduleDrawSelection() {
    const empty = figma.currentPage.selection.length === 0;
    if (selectionDebounceTimer != null) {
      clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = null;
    }
    if (empty) {
      void drawSelection().catch((err) => {
        setStatus(err instanceof Error ? err.message : "Design Specs failed");
      });
      return;
    }
    selectionDebounceTimer = setTimeout(() => {
      selectionDebounceTimer = null;
      void drawSelection().catch((err) => {
        setStatus(err instanceof Error ? err.message : "Design Specs failed");
      });
    }, SELECTION_DEBOUNCE_MS);
  }
  figma.on("selectionchange", () => {
    scheduleDrawSelection();
  });
  figma.on("close", () => {
    if (selectionDebounceTimer != null) {
      clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = null;
    }
    removeExistingOverlay();
  });
  figma.ui.onmessage = (msg) => {
    void (async () => {
      if (msg.type === "focus-node" && msg.nodeId) {
        await focusNode(msg.nodeId);
        return;
      }
      if (msg.type === "reveal-node" && msg.nodeId) {
        await revealNode(msg.nodeId);
        return;
      }
      if (msg.type === "focus-spacing-value") {
        focusSpacingValue = typeof msg.focusValue === "number" && Number.isFinite(msg.focusValue) ? msg.focusValue : null;
        await paintOverlay(await resolveLintRoots());
        return;
      }
      if (msg.type === "ignore-node" && msg.nodeId) {
        await ignoreLayer(msg.nodeId, msg.nodeName);
        return;
      }
      if (msg.type === "unignore-node" && msg.nodeId) {
        await unignoreLayer(msg.nodeId);
        return;
      }
      if (msg.type === "ready") {
        options = await loadOptions();
        ignoredLayers = await loadIgnoredLayers();
        figma.ui.postMessage({
          type: "init",
          radius: options.radius,
          padding: options.padding,
          gap: options.gap,
          layout: options.layout,
          components: options.components,
          distance: options.distance,
          colors: options.colors,
          labelFontSize: options.labelFontSize,
          pillSize: options.pillSize,
          overlayOpacity: options.overlayOpacity,
          pillOpacity: options.pillOpacity,
          ignoredLayers
        });
        await drawSelection();
        return;
      }
      if (msg.type === "options") {
        await saveOptions({
          radius: !!msg.radius,
          padding: !!msg.padding,
          gap: !!msg.gap,
          layout: !!msg.layout,
          components: !!msg.components,
          distance: !!msg.distance,
          colors: sanitizeColors(msg.colors),
          labelFontSize: clampLabelFontSize(msg.labelFontSize),
          pillSize: clampPillSize(msg.pillSize),
          overlayOpacity: clampOverlayOpacity(msg.overlayOpacity),
          pillOpacity: clampPillOpacity(msg.pillOpacity)
        });
        invalidateSessionCaches();
        clearSpecsCache();
        forceFullLint = true;
        await drawSelection();
        return;
      }
      if (msg.type === "use-component" && msg.nodeId && msg.componentId) {
        const done = await replaceWithComponents([
          { nodeId: msg.nodeId, componentId: msg.componentId }
        ]);
        figma.notify(`Replaced ${done} frame${done === 1 ? "" : "s"}`);
        invalidateSessionCaches();
        clearSpecsCache();
        forceFullLint = true;
        await drawSelection();
        return;
      }
      if (msg.type === "use-components" && msg.items && msg.items.length) {
        const done = await replaceWithComponents(msg.items);
        figma.notify(`Replaced ${done} frame${done === 1 ? "" : "s"}`);
        invalidateSessionCaches();
        clearSpecsCache();
        forceFullLint = true;
        await drawSelection();
        return;
      }
      if (msg.type === "fix-one" && msg.issueId) {
        const fixed = await applyMany([msg.issueId], msg.selections || [], true);
        figma.notify(`Applied ${fixed} fix${fixed === 1 ? "" : "es"}`);
        forceFullLint = true;
        await drawSelection();
        return;
      }
      if (msg.type === "fix-all") {
        const fixed = await applyMany(msg.issueIds || null, msg.selections || [], false);
        figma.notify(`Applied ${fixed} fix${fixed === 1 ? "" : "es"}`);
        forceFullLint = true;
        await drawSelection();
      }
    })().catch((err) => {
      setStatus(err instanceof Error ? err.message : "Design Specs failed");
    });
  };
})();
