export type OverlayColors = {
  radius: string;
  padding: string;
  gap: string;
};

export type ShowOptions = {
  radius: boolean;
  padding: boolean;
  gap: boolean;
  layout: boolean;
  components: boolean;
  distance: boolean;
  colors: OverlayColors;
  labelFontSize: number;
  /** Multiplier for pill pad + corner (1 = theme defaults). */
  pillSize: number;
  /** Opacity for padding/gap fill overlays (0–1). */
  overlayOpacity: number;
  /** Opacity for label pills (0–1). */
  pillOpacity: number;
};

export const DEFAULT_COLORS: OverlayColors = {
  radius: "#3373F2",
  padding: "#2EA35F",
  gap: "#F5C72E",
};

export const DEFAULT_OPTIONS: ShowOptions = {
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
  pillOpacity: 1,
};

export const OPTIONS_STORAGE_KEY = "design-specs-show-options";
export const IGNORED_LAYERS_STORAGE_KEY = "design-specs-ignored-layers";

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

export function sanitizeHex(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const m = HEX_RE.exec(value.trim());
  if (!m) return fallback;
  return ("#" + m[1]).toUpperCase();
}

export function sanitizeColors(raw: unknown): OverlayColors {
  const c = raw && typeof raw === "object" ? (raw as Partial<OverlayColors>) : {};
  return {
    radius: sanitizeHex(c.radius, DEFAULT_COLORS.radius),
    padding: sanitizeHex(c.padding, DEFAULT_COLORS.padding),
    gap: sanitizeHex(c.gap, DEFAULT_COLORS.gap),
  };
}

export function clampLabelFontSize(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_OPTIONS.labelFontSize;
  return Math.min(16, Math.max(6, Math.round(n)));
}

export function clampPillSize(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_OPTIONS.pillSize;
  return Math.min(2, Math.max(0.5, Math.round(n * 100) / 100));
}

export function clampOverlayOpacity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_OPTIONS.overlayOpacity;
  return Math.min(1, Math.max(0.05, Math.round(n * 100) / 100));
}

export function clampPillOpacity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_OPTIONS.pillOpacity;
  return Math.min(1, Math.max(0.05, Math.round(n * 100) / 100));
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = HEX_RE.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}
