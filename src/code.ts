import {
  attachCandidatePreviews,
  beginComponentPass,
  lintDetached,
  matchSelection,
  replaceWithComponents,
  type ComponentMatch,
  type ReplaceItem,
} from "./componentMatch";
import {
  applyBorderTokens,
  applyColorTokens,
  applyEffectTokens,
  applyOpacityTokens,
  applySpacingTokens,
  applyStrokeTokens,
  applyTypographyTokens,
  clearTokenIndexCache,
  isIssueApplyable,
  lintBorder,
  lintColor,
  lintEffects,
  lintLayout,
  lintOpacity,
  lintSpacing,
  lintStroke,
  lintTypography,
  loadTokenIndex,
  type LintIssue,
  type StyleApplySelection,
} from "./lint";
import { scanLintTree } from "./lint/scan";
import {
  clearStyleCaches,
  loadEffectStyles,
  loadPaintStyles,
  loadTextStyles,
} from "./lint/styleMatch";
import {
  coveragePercent,
  flattenIssues,
  selectApplyTargets,
  toFlatIssue,
  type FlatIssue,
} from "./lint/flat";
import {
  distanceDimLines,
  distinctSpacingValues,
  measure,
  mergeSpecs,
  type Rect,
  type Specs,
} from "./measure";
import {
  drawOverlay,
  findLiveOverlay,
  patchStickyOverlayExtras,
  removeExistingOverlay,
} from "./overlay";
import {
  DEFAULT_OPTIONS,
  IGNORED_LAYERS_STORAGE_KEY,
  OPTIONS_STORAGE_KEY,
  clampLabelFontSize,
  clampOverlayOpacity,
  clampPillOpacity,
  clampPillSize,
  sanitizeColors,
  type IgnoredLayer,
  type ShowOptions,
} from "./options";
import { labelFont, setLabelFont } from "./theme";

let options: ShowOptions = { ...DEFAULT_OPTIONS, colors: { ...DEFAULT_OPTIONS.colors } };
let ignoredLayers: IgnoredLayer[] = [];
let fontReady: Promise<void> | null = null;
let passId = 0;
const ignoreMemo = new Map<string, boolean>();
let flatIssues: FlatIssue[] = [];
let layoutFlatIssues: FlatIssue[] = [];
let lastMatches: ComponentMatch[] = [];
let lintRootIds: string[] = [];
let focusSpacingValue: number | null = null;
let lastSpacingValues: number[] = [];
let lastCoverage = 100;
let selectionDebounceTimer: number | null = null;
let cachedSpecs: Specs | null = null;
let cachedSpecsRootKey = "";
/** After fix/replace/options — sticky path must re-lint, not overlay-only. */
let forceFullLint = false;

const SELECTION_DEBOUNCE_MS = 120;

function rootsKey(roots: readonly SceneNode[]): string {
  return roots.map((r) => r.id).join("\0");
}

function clearSpecsCache(): void {
  cachedSpecs = null;
  cachedSpecsRootKey = "";
}

const lastIssues: Record<string, LintIssue[]> = {
  spacing: [],
  border: [],
  color: [],
  type: [],
  opacity: [],
  effects: [],
  stroke: [],
  layout: [],
  detached: [],
};

function isSupported(node: SceneNode): boolean {
  return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE";
}

function isUnderRoot(node: BaseNode, root: BaseNode): boolean {
  let cur: BaseNode | null = node;
  while (cur) {
    if (cur.id === root.id) return true;
    if (cur.type === "PAGE" || cur.type === "DOCUMENT") return false;
    cur = cur.parent;
  }
  return false;
}

function isUnderAnyRoot(node: BaseNode, roots: readonly SceneNode[]): boolean {
  return roots.some((root) => isUnderRoot(node, root));
}

/** Keep outermost nodes only when one selected node nests under another. */
function nestCollapse(nodes: SceneNode[]): SceneNode[] {
  return nodes.filter((node) => !nodes.some((other) => other !== node && isUnderRoot(node, other)));
}

function resolveRootsFromSelection(selection: readonly SceneNode[]): SceneNode[] {
  return nestCollapse(selection.filter(isSupported));
}

async function resolveLintRoots(): Promise<SceneNode[]> {
  const roots: SceneNode[] = [];
  for (const id of lintRootIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") continue;
    const scene = node as SceneNode;
    if (isSupported(scene)) roots.push(scene);
  }
  return roots;
}

async function rectsForIds(ids: string[]): Promise<Rect[]> {
  const seen = new Set<string>();
  const out: Rect[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") continue;
    const b = (node as SceneNode).absoluteBoundingBox;
    if (!b) continue;
    out.push({ x: b.x, y: b.y, width: b.width, height: b.height });
  }
  return out;
}

function selectionDistanceDims(): Specs["distanceDims"] {
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

async function paintOverlay(
  roots: SceneNode[],
  gen?: number,
  specsIn?: Specs | null
): Promise<void> {
  const stale = () => gen !== undefined && gen !== passId;
  await ensureFont();
  if (stale()) return;

  let specs: Specs | null;
  if (specsIn !== undefined) {
    specs = specsIn;
  } else if (cachedSpecs && cachedSpecsRootKey === rootsKey(roots)) {
    specs = cachedSpecs;
  } else {
    const measured: Specs[] = [];
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
    focusValue: focusSpacingValue,
  });
  const layoutSource = options.layout ? await withoutIgnored(layoutFlatIssues) : [];
  if (stale()) return;
  const layoutRects = options.layout ? await rectsForIds(layoutSource.map((i) => i.nodeId)) : [];
  const componentRects = options.components
    ? await rectsForIds(lastMatches.map((m) => m.nodeId))
    : [];
  if (stale()) return;
  await drawOverlay(
    specs,
    options,
    { layoutRects, componentRects },
    () => !stale(),
    { focusValue: focusSpacingValue }
  );
}

async function clearLintTarget(status: string, gen: number): Promise<void> {
  if (gen !== passId) return;
  lintRootIds = [];
  clearSpecsCache();
  const live = await refreshLint([], gen);
  if (!live) return;
  await paintOverlay([], gen, null);
  if (gen !== passId) return;
  setStatus(status);
}

async function applyLintTarget(roots: SceneNode[], gen: number): Promise<void> {
  if (gen !== passId) return;
  if (roots.length === 0) {
    await clearLintTarget("Select a frame", gen);
    return;
  }
  await postScanning();
  if (gen !== passId) return;
  const measured: Specs[] = [];
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

async function loadLabelFont(): Promise<void> {
  const candidates: FontName[] = [
    labelFont,
    { family: "Inter", style: "Regular" },
    { family: "Roboto", style: "Medium" },
    { family: "Roboto", style: "Regular" },
  ];
  for (const font of candidates) {
    try {
      await figma.loadFontAsync(font);
      setLabelFont(font);
      return;
    } catch {
      // try next
    }
  }
  throw new Error("No label font available");
}

function ensureFont(): Promise<void> {
  if (!fontReady) {
    fontReady = loadLabelFont().catch((err) => {
      fontReady = null;
      throw err;
    });
  }
  return fontReady;
}

function setStatus(message: string): void {
  figma.ui.postMessage({ type: "status", message });
}

/** Post scanning + yield a macrotask so the UI iframe can paint before heavy lint. */
async function postScanning(): Promise<void> {
  figma.ui.postMessage({ type: "lint-scanning" });
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

function ignoredIdSet(): Set<string> {
  return new Set(ignoredLayers.map((l) => l.id));
}

async function nodeIgnored(nodeId: string): Promise<boolean> {
  const known = ignoreMemo.get(nodeId);
  if (known !== undefined) return known;
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
  const chain: string[] = [];
  let cur: BaseNode | null = start;
  let hidden = false;
  while (cur) {
    const seen = ignoreMemo.get(cur.id);
    if (seen !== undefined) {
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

async function withoutIgnored(issues: FlatIssue[]): Promise<FlatIssue[]> {
  const out: FlatIssue[] = [];
  for (const issue of issues) {
    if (!(await nodeIgnored(issue.nodeId))) out.push(issue);
  }
  return out;
}

function sendLint(visible: FlatIssue[], visibleLayout: FlatIssue[]): void {
  const fixableCount = visible.filter((i) => i.fixable).length;
  figma.ui.postMessage({
    type: "lint-results",
    issues: visible,
    ignoredLayers,
    fixableCount,
    totalCount: visible.length,
    coveragePercent: lastCoverage,
  });
  figma.ui.postMessage({
    type: "layout-results",
    issues: visibleLayout,
    totalCount: visibleLayout.length,
  });
}

async function postLintResults(): Promise<void> {
  ignoreMemo.clear();
  sendLint(await withoutIgnored(flatIssues), await withoutIgnored(layoutFlatIssues));
}

function selectionHasFrameTargets(selection: readonly SceneNode[]): boolean {
  return selection.some((n) => n.type === "FRAME");
}

async function refreshComponentMatches(
  selection: readonly SceneNode[],
  gen: number,
  opts?: { skipCatalogIfNoFrames?: boolean }
): Promise<void> {
  if (!options.components) {
    lastMatches = [];
    if (gen === passId) {
      figma.ui.postMessage({ type: "component-matches", matches: lastMatches });
    }
    return;
  }
  // sticky child clicks: TEXT/INSTANCE/etc. — keep prior matches, no catalog scan
  if (opts?.skipCatalogIfNoFrames && !selectionHasFrameTargets(selection)) {
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

/** Sticky child select: reuse pad/gap overlay; only patch distance + component outlines. */
async function stickyOverlayUpdate(roots: SceneNode[], gen: number): Promise<void> {
  const overlay = findLiveOverlay();
  const cacheOk = !!(cachedSpecs && cachedSpecsRootKey === rootsKey(roots));
  if (!overlay || !cacheOk) {
    await paintOverlay(roots, gen);
    return;
  }

  const needDistance = options.distance;
  const needComponents = options.components;
  if (!needDistance && !needComponents) {
    // pad/gap/layout/radius unchanged under sticky roots
    return;
  }

  await ensureFont();
  if (gen !== passId) return;

  const componentRects = needComponents
    ? await rectsForIds(lastMatches.map((m) => m.nodeId))
    : [];
  if (gen !== passId) return;

  try {
    patchStickyOverlayExtras(overlay, options, {
      distanceDims: needDistance ? selectionDistanceDims() : [],
      componentRects,
    });
  } catch {
    await paintOverlay(roots, gen);
  }
}

function invalidateSessionCaches(): void {
  clearTokenIndexCache();
  clearStyleCaches();
  beginComponentPass();
}

async function focusNode(nodeId: string): Promise<void> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
    setStatus("Node not found");
    return;
  }
  const scene = node as SceneNode;
  figma.currentPage.selection = [scene];
  figma.viewport.scrollAndZoomIntoView([scene]);
}

/** Zoom to node without changing selection (keeps current scan target). */
async function revealNode(nodeId: string): Promise<void> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
    setStatus("Node not found");
    return;
  }
  figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
}

async function refreshLint(roots: SceneNode[], gen: number): Promise<boolean> {
  if (gen !== passId) return false;
  if (roots.length === 0) {
    if (gen !== passId) return false;
    for (const key of Object.keys(lastIssues) as Array<keyof typeof lastIssues>) {
      lastIssues[key] = [];
    }
    flatIssues = [];
    layoutFlatIssues = [];
    lastCoverage = 100;
    sendLint([], []);
    return true;
  }

  // session TokenIndex keeps mode-keyed pools across passes; invalidateSessionCaches clears
  const tokens = await loadTokenIndex();
  if (gen !== passId) return false;
  const paintStyles = await loadPaintStyles();
  const textStyles = await loadTextStyles();
  const effectStyles = await loadEffectStyles();
  if (gen !== passId) return false;

  const spacingIssues: LintIssue[] = [];
  const borderIssues: LintIssue[] = [];
  const colorIssues: LintIssue[] = [];
  const typeIssues: LintIssue[] = [];
  const opacityIssues: LintIssue[] = [];
  const effectsIssues: LintIssue[] = [];
  const strokeIssues: LintIssue[] = [];
  const layoutIssues: LintIssue[] = [];
  const detachedIssues: LintIssue[] = [];
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
    const detached = options.components
      ? await lintDetached(root)
      : { issues: [], fixableCount: 0, tokenCount: 0, checkedCount: 0 };
    spacingIssues.push(...spacing.issues);
    borderIssues.push(...border.issues);
    colorIssues.push(...color.issues);
    typeIssues.push(...type.issues);
    opacityIssues.push(...opacity.issues);
    effectsIssues.push(...effects.issues);
    strokeIssues.push(...stroke.issues);
    layoutIssues.push(...layout.issues);
    detachedIssues.push(...detached.issues);
    checkedCount +=
      (spacing.checkedCount || 0) +
      (border.checkedCount || 0) +
      (color.checkedCount || 0) +
      (type.checkedCount || 0) +
      (opacity.checkedCount || 0) +
      (effects.checkedCount || 0) +
      (stroke.checkedCount || 0);
  }
  if (gen !== passId) return false;

  const nextFlat = flattenIssues([
    spacingIssues,
    borderIssues,
    colorIssues,
    typeIssues,
    opacityIssues,
    effectsIssues,
    strokeIssues,
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

async function drawSelection(): Promise<void> {
  const gen = ++passId;
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    await refreshComponentMatches(selection, gen);
    if (gen !== passId) return;
    await clearLintTarget("Select a frame", gen);
    return;
  }

  // sticky gate before component catalog — avoid findAll on every child click
  if (lintRootIds.length > 0) {
    const stickyRoots = await resolveLintRoots();
    if (gen !== passId) return;
    if (
      stickyRoots.length > 0 &&
      selection.every((node) => isUnderAnyRoot(node, stickyRoots))
    ) {
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

async function loadOptions(): Promise<ShowOptions> {
  const saved = await figma.clientStorage.getAsync(OPTIONS_STORAGE_KEY);
  if (!saved || typeof saved !== "object") {
    return {
      ...DEFAULT_OPTIONS,
      colors: { ...DEFAULT_OPTIONS.colors },
    };
  }
  const s = saved as Partial<ShowOptions>;
  return {
    radius: typeof s.radius === "boolean" ? s.radius : DEFAULT_OPTIONS.radius,
    padding: typeof s.padding === "boolean" ? s.padding : DEFAULT_OPTIONS.padding,
    gap: typeof s.gap === "boolean" ? s.gap : DEFAULT_OPTIONS.gap,
    layout: typeof s.layout === "boolean" ? s.layout : DEFAULT_OPTIONS.layout,
    components:
      typeof s.components === "boolean" ? s.components : DEFAULT_OPTIONS.components,
    distance: typeof s.distance === "boolean" ? s.distance : DEFAULT_OPTIONS.distance,
    colors: sanitizeColors(s.colors),
    labelFontSize: clampLabelFontSize(s.labelFontSize),
    pillSize: clampPillSize(s.pillSize),
    overlayOpacity: clampOverlayOpacity(s.overlayOpacity),
    pillOpacity: clampPillOpacity(s.pillOpacity),
  };
}

async function saveOptions(next: ShowOptions): Promise<void> {
  options = next;
  await figma.clientStorage.setAsync(OPTIONS_STORAGE_KEY, next);
}

function fileBucket(): string {
  // shortcut: unsaved files share one list, split them once fileKey exists
  return figma.fileKey || "draft";
}

function sanitizeIgnored(saved: unknown): IgnoredLayer[] {
  if (!Array.isArray(saved)) return [];
  const out: IgnoredLayer[] = [];
  for (const item of saved) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as IgnoredLayer).id === "string" &&
      typeof (item as IgnoredLayer).name === "string"
    ) {
      out.push({ id: (item as IgnoredLayer).id, name: (item as IgnoredLayer).name });
    }
  }
  return out;
}

async function writeIgnored(next: IgnoredLayer[]): Promise<void> {
  const saved = await figma.clientStorage.getAsync(IGNORED_LAYERS_STORAGE_KEY);
  const map: Record<string, IgnoredLayer[]> =
    saved && typeof saved === "object" && !Array.isArray(saved)
      ? { ...(saved as Record<string, IgnoredLayer[]>) }
      : {};
  map[fileBucket()] = next;
  await figma.clientStorage.setAsync(IGNORED_LAYERS_STORAGE_KEY, map);
}

async function loadIgnoredLayers(): Promise<IgnoredLayer[]> {
  const saved = await figma.clientStorage.getAsync(IGNORED_LAYERS_STORAGE_KEY);
  const bucket = fileBucket();
  const list =
    saved && typeof saved === "object" && !Array.isArray(saved)
      ? sanitizeIgnored((saved as Record<string, unknown>)[bucket])
      : [];
  const kept: IgnoredLayer[] = [];
  for (const item of list) {
    const node = await figma.getNodeByIdAsync(item.id);
    if (node) kept.push(item);
  }
  if (kept.length !== list.length) await writeIgnored(kept);
  return kept;
}

async function saveIgnoredLayers(next: IgnoredLayer[]): Promise<void> {
  ignoredLayers = next;
  ignoreMemo.clear();
  await writeIgnored(next);
}

async function ignoreLayer(nodeId: string, name?: string): Promise<void> {
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

async function unignoreLayer(nodeId: string): Promise<void> {
  await saveIgnoredLayers(ignoredLayers.filter((l) => l.id !== nodeId));
  await postLintResults();
  await paintOverlay(await resolveLintRoots());
}

function findRawIssue(flatId: string): LintIssue | null {
  for (const group of Object.values(lastIssues)) {
    for (const issue of group) {
      const id = `${issue.nodeId}:${issue.kind}:${issue.paintIndex ?? issue.effectIndex ?? ""}:${issue.field}`;
      if (id === flatId) return issue;
    }
  }
  return null;
}

function withSelectedVariable(
  raw: LintIssue,
  flat: FlatIssue,
  selections: StyleApplySelection[]
): LintIssue {
  const byIssue = selections.find((s) => s.issueId === flat.id);
  if (byIssue?.variableId) return { ...raw, variableId: byIssue.variableId };
  if (flat.tokenCandidates.length === 1) {
    return { ...raw, variableId: flat.tokenCandidates[0].id };
  }
  return raw;
}

async function applyOne(
  flat: FlatIssue,
  selections: StyleApplySelection[],
  allowNearest: boolean
): Promise<number> {
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

async function applyMany(
  ids: string[] | null,
  selections: StyleApplySelection[],
  allowNearest: boolean
): Promise<number> {
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

function scheduleDrawSelection(): void {
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
  }, SELECTION_DEBOUNCE_MS) as unknown as number;
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

figma.ui.onmessage = (msg: {
  type: string;
  radius?: boolean;
  padding?: boolean;
  gap?: boolean;
  layout?: boolean;
  components?: boolean;
  distance?: boolean;
  colors?: unknown;
  labelFontSize?: number;
  pillSize?: number;
  overlayOpacity?: number;
  pillOpacity?: number;
  focusValue?: number | null;
  nodeId?: string;
  nodeName?: string;
  componentId?: string;
  issueId?: string;
  issueIds?: string[];
  selections?: StyleApplySelection[];
  items?: ReplaceItem[];
}) => {
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
      focusSpacingValue =
        typeof msg.focusValue === "number" && Number.isFinite(msg.focusValue)
          ? msg.focusValue
          : null;
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
        ignoredLayers,
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
        pillOpacity: clampPillOpacity(msg.pillOpacity),
      });
      invalidateSessionCaches();
      clearSpecsCache();
      forceFullLint = true;
      await drawSelection();
      return;
    }

    if (msg.type === "use-component" && msg.nodeId && msg.componentId) {
      const done = await replaceWithComponents([
        { nodeId: msg.nodeId, componentId: msg.componentId },
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
