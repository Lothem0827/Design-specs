export const OVERLAY_NAME = "__design-specs-overlay";

export const GREEN_PAD = { r: 0.18, g: 0.64, b: 0.37 }; // #2EA35F — padding
export const YELLOW_GAP = { r: 0.96, g: 0.78, b: 0.18 }; // #F5C72E — gap
export const BLUE_RADIUS = { r: 0.2, g: 0.45, b: 0.95 }; // #3373F2 — radius
export const RED = { r: 0.9, g: 0.22, b: 0.2 }; // #E53833 — hard input (no token)

export const PURPLE = { r: 0.67, g: 0.45, b: 0.9 }; // #AB73E6 — not components
export const GRAY = { r: 0.55, g: 0.55, b: 0.55 }; // dim / size / layout outline

// Legacy aliases
export const BLUE = BLUE_RADIUS;
export const BLUE_PAD = GREEN_PAD;
export const BLUE_GAP = YELLOW_GAP;
export const GREEN = GREEN_PAD;
export const GREEN_GAP = YELLOW_GAP;
export const GREEN_RADIUS = BLUE_RADIUS;
export const ORANGE = RED;
export const YELLOW = YELLOW_GAP;

export const PAD_FILL_OPACITY = 0.22;
export const GAP_FILL_OPACITY = 0.22;
export const OUTLINE_STROKE_WEIGHT = 1.5;
export const DIM_STROKE_WEIGHT = 1.25;
export const DIM_TICK = 6;
export const DIM_OFFSET = 10;
export const DASH_PATTERN = [4, 4];
export const PILL_RADIUS = 3;
export const PILL_PAD_X = 4;
export const PILL_PAD_Y = 2;
export const LABEL_FONT_SIZE = 8;
export let labelFont: FontName = { family: "Inter", style: "Medium" };

export function setLabelFont(font: FontName): void {
  labelFont = font;
}
export const MAX_NEST_DEPTH = 12;
export const MAX_WALK_NODES = 2500;
export const COMPACT_MAX = 80;
