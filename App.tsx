/* ═══════════════════════════════════════════════════════════════════════════
   TOKEN PLANNER
   A step-by-step wizard that collects design-token decisions and exports them
   as (a) a hardcoded AI prompt template for Figma CLI and (b) Token Studio JSON.

   FILE MAP
     0.  Domain model         — every interface the wizard document is built from
     1.  Utilities            — ids, strings, colors, immutable array helpers
     2.  Validation           — pure validators + field-level error helpers
     3.  Defaults / Factories — every pre-filled scale lives here
     4.  Wizard config        — STEPS, component catalogue
     5.  Auto-mapping         — HSL analysis → semantic colour suggestions
     6.  Generators           — prompt (2 templates) + Token Studio JSON
     7.  Stylesheet           — design tokens, responsive rules, a11y states
     8.  UI primitives        — Button, IconButton, Field, CellInput, Select, Card …
     9.  Composite editors    — NameValueEditor, SemGroupEditor, StepRail …
     10. Steps                — Step1 … Step10
     11. App shell            — ErrorBoundary + TokenPlanner
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  Component,
  type ReactNode,
  type CSSProperties,
  type ErrorInfo,
} from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   0. DOMAIN MODEL
   The wizard document is the single source of truth. Everything else — the
   prompt, the JSON, the previews, the autosave envelope — is derived from it.
   ═══════════════════════════════════════════════════════════════════════════ */

type ID = string;

type ThemePreference = "light" | "dark" | "auto";
type ResolvedTheme = "light" | "dark";
type ColorMode = "base" | "palette";
type ScaleType = "shades" | "transparency";
type MappingPreference = "auto" | "manual";
type ExportFormat = "both" | "prompt" | "json";
type ProjectStatus = "Draft" | "In Review" | "Approved";
type StepState = "todo" | "done" | "skip";
type ColorScheme = "light" | "dark";

/** A plain `name: value` token row — the shape behind most editors. */
interface TokenItem {
  id: ID;
  name: string;
  value: string;
}

/** Figma stores shadows as five discrete fields, so we do too. */
interface ShadowItem {
  id: ID;
  name: string;
  x: string;
  y: string;
  blur: string;
  spread: string;
  color: string;
}

interface ShadeItem {
  id: ID;
  shade: string;
  hex: string;
}

interface BaseColor {
  id: ID;
  name: string;
  hex: string;
  type: ScaleType;
  shadeCount: number;
}

interface PaletteGroup {
  id: ID;
  name: string;
  shades: ShadeItem[];
}

/**
 * One semantic role. The optional fields are the union of every mapping shape:
 * colour roles use light/dark refs, scale roles a single ref, typography roles
 * the five font properties. Keeping one type lets `SemGroupEditor` stay generic.
 */
interface SemRole {
  id: ID;
  name: string;
  ref?: string;
  lightRef?: string;
  darkRef?: string;
  family?: string;
  size?: string;
  weight?: string;
  lineHeight?: string;
  tracking?: string;
  durationRef?: string;
  easingRef?: string;
}

interface SemGroup {
  id: ID;
  name: string;
  roles: SemRole[];
}

interface ComponentDefinition {
  id: ID;
  name: string;
  tokens: TokenItem[];
}

interface ProjectMeta {
  serial: string;
  date: string;
  name: string;
  systemName: string;
  version: string;
  reviewer: string;
  status: ProjectStatus;
  brands: string[];
  mappingPref: MappingPreference;
  exportFormat: ExportFormat;
}

interface TypographySection {
  familyMode: "universal" | "per-brand";
  universalFamilies: TokenItem[];
  brandFamilies: Record<string, TokenItem[]>;
  sizeScale: TokenItem[];
  weightScale: TokenItem[];
  lineHeightScale: TokenItem[];
  trackingScale: TokenItem[];
}

interface ScaleSection {
  baseUnit: number;
  scale: TokenItem[];
  borderRadius: TokenItem[];
  borderWidths: TokenItem[];
}

interface EffectsSemantic {
  shadowRoles: SemRole[];
  blurRoles: SemRole[];
  opacityRoles: SemRole[];
}

interface EffectsSection {
  shadows: ShadowItem[];
  blurs: TokenItem[];
  opacity: TokenItem[];
  semantic: EffectsSemantic;
}

interface MotionSemantic {
  durationRoles: SemRole[];
  easingRoles: SemRole[];
  transitions: SemRole[];
}

interface MotionSection {
  durations: TokenItem[];
  easings: TokenItem[];
  semantic: MotionSemantic;
}

/** The complete wizard document. */
interface PlannerDoc {
  project: ProjectMeta;
  colorMode: ColorMode;
  colorBase: Record<string, BaseColor[]>;
  colorPalette: Record<string, PaletteGroup[]>;
  typography: TypographySection;
  scale: ScaleSection;
  effects: EffectsSection;
  motion: MotionSection;
  semColorGroups: SemGroup[];
  semTypoGroups: SemGroup[];
  semScaleGroups: SemGroup[];
  zIndex: TokenItem[];
  components: ComponentDefinition[];
}

type StepStatusMap = Record<number, StepState>;

/** Portable envelope shared by autosave, Export project and Import project. */
interface ProjectEnvelope {
  kind: string;
  version: number;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  theme: ThemePreference;
  wizard: { step: number; status: StepStatusMap };
  data: PlannerDoc;
}

interface RestorePayload {
  doc: PlannerDoc;
  theme: ThemePreference | null;
  step: number;
  stepStatus: StepStatusMap | null;
  createdAt: string | null;
  updatedAt?: string;
  projectName?: string;
}

type ReadResult =
  | { ok: true; payload: RestorePayload; error?: undefined }
  | { ok: false; error: string; payload?: undefined };

interface WizardStep {
  id: number;
  label: string;
  short: string;
  phase: string;
}

/** `{ label, value }` pairs for every `<Select>` in the app. */
interface Option {
  label: string;
  value: string;
}

type Validator = (value: unknown) => string | null;
type ColorIndex = Record<string, string>;

/* ═══════════════════════════════════════════════════════════════════════════
   1. UTILITIES
   ═══════════════════════════════════════════════════════════════════════════ */

const uid = (): ID => Math.random().toString(36).slice(2, 9);

const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(" ");

const genSerial = (): string =>
  `TKP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9999) + 1).padStart(4, "0")}`;

const today = (): string =>
  new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });

/** Token-safe path segment: lowercase, dashes, keeps `/` for nesting. */
const slugify = (s: unknown): string =>
  (typeof s === "string" ? s : "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9\-/]/g, "");

/* ── colour ─────────────────────────────────────────────────────────────── */

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGBA_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i;

const isHex = (h: unknown): boolean => HEX_RE.test(String(h ?? "").trim());
const isColor = (h: unknown): boolean => {
  const v = String(h ?? "").trim();
  return isHex(v) || RGBA_RE.test(v) || v === "transparent";
};

/** Safe value for `<input type="color">` — that control only accepts #rrggbb. */
const pickerValue = (h: unknown, fallback = "#7c3aed"): string => {
  const v = String(h ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + v.slice(1).split("").map((c) => c + c).join("");
  if (/^#[0-9a-f]{8}$/i.test(v)) return v.slice(0, 7);
  return fallback;
};

interface HSL {
  h: number;
  s: number;
  l: number;
}

function hexToHSL(hex: unknown): HSL {
  let h6 = String(hex ?? "").replace("#", "");
  if (h6.length === 3 || h6.length === 4) h6 = h6.slice(0, 3).split("").map((c) => c + c).join("");
  if (h6.length < 6) return { h: 0, s: 0, l: 50 };
  const r = parseInt(h6.slice(0, 2), 16) / 255;
  const g = parseInt(h6.slice(2, 4), 16) / 255;
  const b = parseInt(h6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/* ── immutable list helpers (used by every editor) ──────────────────────── */

const listUpdate = <T extends { id: ID }>(list: T[], id: ID, key: string, value: unknown): T[] =>
  (list || []).map((it) => (it.id === id ? { ...it, [key]: value } : it));

const listRemove = <T extends { id: ID }>(list: T[], id: ID): T[] =>
  (list || []).filter((it) => it.id !== id);

const listAdd = <T extends { id: ID }>(list: T[], item: Omit<T, "id"> | Record<string, unknown>): T[] =>
  [...(list || []), { id: uid(), ...item } as T];

const listMove = <T,>(list: T[], index: number, delta: number): T[] => {
  const arr = [...(list || [])];
  const next = index + delta;
  if (next < 0 || next >= arr.length) return arr;
  [arr[index], arr[next]] = [arr[next], arr[index]];
  return arr;
};

/* ═══════════════════════════════════════════════════════════════════════════
   2. VALIDATION
   Each validator returns `null` when valid, or a short human message.
   Empty values are always allowed (a token can be left unfilled and is simply
   omitted from the export) — validators only complain about *wrong* input.
   ═══════════════════════════════════════════════════════════════════════════ */

const blank = (v: unknown): boolean =>
  v === undefined || v === null || String(v).trim() === "";

const V: Record<string, Validator> = {
  color: (v) => (blank(v) || isColor(v) ? null : "Use #hex, rgba() or transparent"),

  /** px / rem / em / % / unitless — anything numeric with an optional unit. */
  dimension: (v) =>
    blank(v) || /^-?\d*\.?\d+(px|rem|em|%)?$/i.test(String(v).trim())
      ? null
      : "Expected a number, optionally with px/rem/em/%",

  number: (v) =>
    blank(v) || /^-?\d*\.?\d+$/.test(String(v).trim()) ? null : "Numbers only",

  integer: (v) => (blank(v) || /^-?\d+$/.test(String(v).trim()) ? null : "Whole numbers only"),

  percent: (v) => {
    if (blank(v)) return null;
    if (!/^-?\d+$/.test(String(v).trim())) return "Whole number (Figma %)";
    const n = Number(v);
    return n < -100 || n > 100 ? "Between -100 and 100" : null;
  },

  fontWeight: (v) => {
    if (blank(v)) return null;
    if (!/^\d+$/.test(String(v).trim())) return "Numeric weight (100–900)";
    const n = Number(v);
    return n < 1 || n > 1000 ? "Between 100 and 900" : null;
  },

  duration: (v) =>
    blank(v) || /^\d*\.?\d+(ms|s)?$/i.test(String(v).trim()) ? null : "e.g. 200ms",

  easing: (v) =>
    blank(v) ||
    /^(linear|ease|ease-in|ease-out|ease-in-out|steps\(.+\)|cubic-bezier\(\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*\))$/i.test(
      String(v).trim()
    )
      ? null
      : "linear or cubic-bezier(a,b,c,d)",

  tokenName: (v) =>
    blank(v) || /^[a-z0-9][a-z0-9\-/.]*$/i.test(String(v).trim())
      ? null
      : "Letters, numbers, - . / only",

  none: () => null,
};

/** Names that appear more than once inside one list — returns a Set of ids. */
function duplicateIds(list: Array<Record<string, any>> | undefined, key = "name"): Set<ID> {
  const seen = new Map<string, ID>();
  const dupes = new Set<ID>();
  (list || []).forEach((it) => {
    const k = slugify(it[key]);
    if (!k) return;
    if (seen.has(k)) {
      dupes.add(it.id);
      dupes.add(seen.get(k));
    } else seen.set(k, it.id);
  });
  return dupes;
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. DEFAULTS / FACTORIES
   ═══════════════════════════════════════════════════════════════════════════ */

const DEFAULT_COLOR_NAMES = ["Primary", "Secondary", "Accent", "Neutral", "Success", "Warning", "Error", "Info"];

const mkBaseColors = (): BaseColor[] =>
  DEFAULT_COLOR_NAMES.map((name) => ({ id: uid(), name, hex: "", type: "shades", shadeCount: 9 }));

const mkPaletteGroups = (): PaletteGroup[] =>
  DEFAULT_COLOR_NAMES.map((name) => ({
    id: uid(),
    name,
    shades: [100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => ({
      id: uid(), shade: String(n), hex: "",
    })),
  }));

const pair = ([name, value]: [string, string]): TokenItem => ({ id: uid(), name, value });

const mkScale = (base = 4): TokenItem[] =>
  [
    ["0", "0px"], ["px", "1px"], ["0.5", "2px"], ["1", `${base}px`], ["2", `${base * 2}px`],
    ["3", `${base * 3}px`], ["4", `${base * 4}px`], ["5", `${base * 5}px`], ["6", `${base * 6}px`],
    ["8", `${base * 8}px`], ["10", `${base * 10}px`], ["12", `${base * 12}px`],
    ["16", `${base * 16}px`], ["20", `${base * 20}px`], ["24", `${base * 24}px`],
    ["32", `${base * 32}px`], ["full", "9999px"],
  ].map(pair);

const mkBorderRadius = (): TokenItem[] =>
  [["none", "0px"], ["xs", "2px"], ["sm", "4px"], ["md", "8px"], ["lg", "12px"], ["xl", "16px"], ["2xl", "24px"], ["full", "9999px"]].map(pair);

const mkBorderWidths = (): TokenItem[] =>
  [["thin", "1px"], ["base", "1.5px"], ["thick", "2px"], ["heavy", "4px"]].map(pair);

const mkFontSizes = (): TokenItem[] =>
  [["2xs", "10px"], ["xs", "12px"], ["sm", "14px"], ["base", "16px"], ["md", "18px"], ["lg", "20px"],
   ["xl", "24px"], ["2xl", "28px"], ["3xl", "32px"], ["4xl", "36px"], ["5xl", "40px"], ["6xl", "48px"],
   ["7xl", "56px"], ["8xl", "64px"], ["9xl", "72px"], ["10xl", "80px"], ["display", "96px"]].map(pair);

const mkFontWeights = (): TokenItem[] =>
  [["thin", "100"], ["extralight", "200"], ["light", "300"], ["regular", "400"], ["medium", "500"],
   ["semibold", "600"], ["bold", "700"], ["extrabold", "800"], ["black", "900"]].map(pair);

const mkLineHeights = (): TokenItem[] =>
  [["none", "1"], ["2xs", "1.1"], ["xs", "1.2"], ["sm", "1.25"], ["snug", "1.35"], ["base", "1.4"],
   ["md", "1.45"], ["normal", "1.5"], ["lg", "1.55"], ["relaxed", "1.6"], ["xl", "1.65"],
   ["2xl", "1.75"], ["loose", "2"], ["3xl", "2.25"], ["4xl", "2.5"], ["5xl", "3"], ["6xl", "4"]].map(pair);

/** Letter spacing as Figma percentages — whole numbers, no units. */
const mkLetterSpacing = (): TokenItem[] =>
  [["tightest", "-8"], ["tighter", "-5"], ["tight", "-3"], ["snug", "-2"], ["normal", "0"],
   ["wide", "1"], ["wider", "2"], ["widest", "3"], ["tracked", "5"], ["x-tracked", "8"],
   ["loose", "10"], ["looser", "12"], ["loosest", "15"], ["spread", "20"], ["x-spread", "25"],
   ["open", "30"], ["max", "50"]].map(pair);

const SHADOW_STEPS = ["xxs", "xs", "s", "m", "l", "xl", "2xl", "xxl"];
const mkShadows = (): ShadowItem[] => SHADOW_STEPS.map((name) => ({ id: uid(), name, x: "", y: "", blur: "", spread: "", color: "" }));
const mkBlurs = (): TokenItem[] => SHADOW_STEPS.map((name) => ({ id: uid(), name, value: "" }));

/** Opacity as Figma percentages — whole numbers. */
const mkOpacity = (): TokenItem[] => [["subtle", "8"], ["disabled", "38"], ["medium", "50"], ["overlay", "72"]].map(pair);

const mkDurations = (): TokenItem[] =>
  [["duration-100", "100ms"], ["duration-200", "200ms"], ["duration-300", "300ms"], ["duration-400", "400ms"],
   ["duration-500", "500ms"], ["duration-600", "600ms"], ["duration-700", "700ms"], ["duration-1000", "1000ms"]].map(pair);

const mkEasings = (): TokenItem[] =>
  [["ease-standard", "cubic-bezier(0.4, 0, 0.2, 1)"], ["ease-in", "cubic-bezier(0.4, 0, 1, 1)"],
   ["ease-out", "cubic-bezier(0, 0, 0.2, 1)"], ["ease-linear", "linear"]].map(pair);

const roles = (names: string[], extra: Partial<SemRole> = {}): SemRole[] =>
  names.map((name) => ({ id: uid(), name, ...extra }));

const mkSemColorGroups = (): SemGroup[] => [
  { id: uid(), name: "Background", roles: roles(["background/default", "background/subtle", "background/inverse", "background/overlay", "background/brand"], { lightRef: "", darkRef: "" }) },
  { id: uid(), name: "Text", roles: roles(["text/primary", "text/secondary", "text/muted", "text/disabled", "text/inverse", "text/on-brand"], { lightRef: "", darkRef: "" }) },
  { id: uid(), name: "Border", roles: roles(["border/default", "border/subtle", "border/strong", "border/focus"], { lightRef: "", darkRef: "" }) },
  { id: uid(), name: "Interactive", roles: roles(["interactive/primary", "interactive/primary-hover", "interactive/primary-pressed", "interactive/primary-disabled", "interactive/secondary", "interactive/secondary-hover", "interactive/ghost", "interactive/ghost-hover"], { lightRef: "", darkRef: "" }) },
  { id: uid(), name: "Feedback", roles: roles(["feedback/success", "feedback/success-subtle", "feedback/warning", "feedback/warning-subtle", "feedback/error", "feedback/error-subtle", "feedback/info", "feedback/info-subtle"], { lightRef: "", darkRef: "" }) },
];

const TYPO_ROLE_FIELDS = { family: "", size: "", weight: "", lineHeight: "", tracking: "" };

const mkSemTypoGroups = (): SemGroup[] => [
  { id: uid(), name: "Display", roles: roles(["display/xl", "display/lg"], TYPO_ROLE_FIELDS) },
  { id: uid(), name: "Heading", roles: roles(["heading/1", "heading/2", "heading/3", "heading/4", "heading/5", "heading/6"], TYPO_ROLE_FIELDS) },
  { id: uid(), name: "Body", roles: roles(["body/lg", "body/md", "body/sm"], TYPO_ROLE_FIELDS) },
  { id: uid(), name: "Label", roles: roles(["label/lg", "label/md", "label/sm"], TYPO_ROLE_FIELDS) },
  { id: uid(), name: "Utility", roles: roles(["caption", "overline", "code/md"], TYPO_ROLE_FIELDS) },
];

const mkSemScaleGroups = (): SemGroup[] => [
  { id: uid(), name: "Component Spacing", roles: roles(["component/xs", "component/sm", "component/md", "component/lg", "component/xl"], { ref: "" }) },
  { id: uid(), name: "Layout", roles: roles(["layout/xs", "layout/sm", "layout/md", "layout/lg"], { ref: "" }) },
  { id: uid(), name: "Inset", roles: roles(["inset/sm", "inset/md", "inset/lg"], { ref: "" }) },
  { id: uid(), name: "Component Height", roles: roles(["height/xs", "height/sm", "height/md", "height/lg", "height/xl"], { ref: "" }) },
  { id: uid(), name: "Icon Size", roles: roles(["icon/xs", "icon/sm", "icon/md", "icon/lg", "icon/xl"], { ref: "" }) },
  { id: uid(), name: "Border Radius", roles: roles(["radius/none", "radius/sm", "radius/md", "radius/lg", "radius/xl", "radius/full"], { ref: "" }) },
];

const mkEffectsSemantic = (): EffectsSemantic => ({
  shadowRoles: roles(["card", "modal", "focus", "popover"], { ref: "" }),
  blurRoles: roles(["overlay", "background"], { ref: "" }),
  opacityRoles: roles(["scrim", "disabled-overlay"], { ref: "" }),
});

const mkMotionSemantic = (): MotionSemantic => ({
  durationRoles: roles(["fast", "normal", "slow", "enter", "exit"], { ref: "" }),
  easingRoles: roles(["emphasized", "enter", "exit"], { ref: "" }),
  transitions: roles(["button", "modal", "fade"], { durationRef: "", easingRef: "" }),
});

const mkZIndex = (): TokenItem[] =>
  [["hide", "-1"], ["base", "0"], ["raised", "10"], ["dropdown", "100"], ["sticky", "200"],
   ["overlay", "300"], ["modal", "400"], ["popover", "500"], ["toast", "600"], ["spinner", "700"]].map(pair);

const mkComponentTokens = (): TokenItem[] =>
  ["background/default", "background/hover", "text", "border/default", "border/focus", "height", "radius"]
    .map((name) => ({ id: uid(), name, value: "" }));

/* ═══════════════════════════════════════════════════════════════════════════
   4. WIZARD CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

const STEPS: WizardStep[] = [
  { id: 1,  label: "Project",     short: "Project", phase: "Setup" },
  { id: 2,  label: "Color",       short: "Color",   phase: "Foundations" },
  { id: 3,  label: "Typography",  short: "Type",    phase: "Foundations" },
  { id: 4,  label: "Scale",       short: "Scale",   phase: "Foundations" },
  { id: 5,  label: "Effects",     short: "Effects", phase: "Foundations" },
  { id: 6,  label: "Motion",      short: "Motion",  phase: "Foundations" },
  { id: 7,  label: "Z-Index",     short: "Z-index", phase: "Foundations" },
  { id: 8,  label: "Components",  short: "Comps",   phase: "Components" },
  { id: 9,  label: "Summary",     short: "Summary", phase: "Review" },
  { id: 10, label: "Export",      short: "Export",  phase: "Review" },
];

const LAST_EDIT_STEP = 9;   // last step before the export screen
const EXPORT_STEP = 10;

const COMMON_COMPONENTS: string[] = [
  "Button", "Input", "Textarea", "Select", "Checkbox", "Radio", "Toggle", "Card", "Modal",
  "Drawer", "Tooltip", "Popover", "Badge", "Tag", "Avatar", "Navbar", "Sidebar", "Table",
  "Tabs", "Accordion", "Alert", "Toast",
];

/* ═══════════════════════════════════════════════════════════════════════════
   5. AUTO-MAPPING  (hex → HSL lightness analysis → semantic suggestions)
   ═══════════════════════════════════════════════════════════════════════════ */

/** Shade steps a base colour will expand into, given the requested count. */
const shadeSteps = (count: number): number[] =>
  count >= 11 ? [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
  : count >= 10 ? [100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
  : [100, 200, 300, 400, 500, 600, 700, 800, 900];

const TRANSPARENCY_STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90];

/** Target lightness per shade — the curve Figma's generators broadly follow. */
const SHADE_LIGHTNESS = {
  50: 97, 100: 94, 200: 86, 300: 76, 400: 64, 500: 52,
  600: 43, 700: 35, 800: 26, 900: 18, 950: 12,
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const toHex2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");

/** HSL → #rrggbb, so synthesised shades can be analysed like real ones. */
function hslToHex(h: number, s: number, l: number): string {
  const S = s / 100, L = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
  return `#${toHex2(f(0) * 255)}${toHex2(f(8) * 255)}${toHex2(f(4) * 255)}`;
}

/** One synthesised shade of a base colour — desaturating toward both ends. */
function synthShade(baseHsl: HSL, step: number): string {
  const l = SHADE_LIGHTNESS[step] ?? baseHsl.l;
  const s = clamp(baseHsl.s - Math.abs(l - 52) * 0.16, 6, 96);
  return hslToHex(baseHsl.h, Math.round(s), l);
}

/**
 * Paths that *will* exist once Figma generates shades from a base colour.
 * Each carries a synthesised hex so auto-mapping can distinguish 100 from 900.
 * Export is unaffected — the prompt still writes the user's base hex only.
 */
interface TokenPath {
  path: string;
  hex: string;
}

function predictedPaths(baseColors: BaseColor[]): TokenPath[] {
  const out: TokenPath[] = [];
  (baseColors || []).forEach((c) => {
    if (!isColor(c.hex)) return;
    const name = slugify(c.name);
    if (!name) return;
    const base = hexToHSL(c.hex);
    if (c.type === "transparency") {
      TRANSPARENCY_STEPS.forEach((n) =>
        out.push({ path: `${name}/${n}`, hex: hslToHex(base.h, base.s, clamp(100 - n * 0.75, 12, 97)) }));
    } else {
      shadeSteps(Number(c.shadeCount) || 9).forEach((n) =>
        out.push({ path: `${name}/${n}`, hex: synthShade(base, n) }));
    }
  });
  return out;
}

type MapTarget = [family: string, arg: number | string];

const LIGHT_TARGETS: Record<string, MapTarget> = {
  "background/default": ["neutral", 98], "background/subtle": ["neutral", 94],
  "background/inverse": ["neutral", 10], "background/overlay": ["neutral", 10],
  "background/brand": ["primary", 45],
  "text/primary": ["neutral", 8], "text/secondary": ["neutral", 30], "text/muted": ["neutral", 50],
  "text/disabled": ["neutral", 68], "text/inverse": ["neutral", 97], "text/on-brand": ["neutral", 97],
  "border/default": ["neutral", 82], "border/subtle": ["neutral", 91], "border/strong": ["neutral", 60],
  "border/focus": ["primary", 45],
  "interactive/primary": ["primary", 45], "interactive/primary-hover": ["primary", 55],
  "interactive/primary-pressed": ["primary", 35], "interactive/primary-disabled": ["neutral", 80],
  "interactive/secondary": ["neutral", 92], "interactive/secondary-hover": ["neutral", 86],
  "interactive/ghost": ["_literal", "transparent"], "interactive/ghost-hover": ["neutral", 93],
  "feedback/success": ["_literal", "#22c55e"], "feedback/success-subtle": ["_literal", "#dcfce7"],
  "feedback/warning": ["_literal", "#f59e0b"], "feedback/warning-subtle": ["_literal", "#fef3c7"],
  "feedback/error": ["_literal", "#ef4444"], "feedback/error-subtle": ["_literal", "#fee2e2"],
  "feedback/info": ["_literal", "#3b82f6"], "feedback/info-subtle": ["_literal", "#dbeafe"],
};

const DARK_TARGETS: Record<string, MapTarget> = {
  "background/default": ["neutral", 7], "background/subtle": ["neutral", 12],
  "background/inverse": ["neutral", 97], "background/overlay": ["neutral", 5],
  "background/brand": ["primary", 55],
  "text/primary": ["neutral", 97], "text/secondary": ["neutral", 72], "text/muted": ["neutral", 52],
  "text/disabled": ["neutral", 35], "text/inverse": ["neutral", 8], "text/on-brand": ["neutral", 97],
  "border/default": ["neutral", 22], "border/subtle": ["neutral", 16], "border/strong": ["neutral", 38],
  "border/focus": ["primary", 60],
  "interactive/primary": ["primary", 60], "interactive/primary-hover": ["primary", 70],
  "interactive/primary-pressed": ["primary", 50], "interactive/primary-disabled": ["neutral", 22],
  "interactive/secondary": ["neutral", 16], "interactive/secondary-hover": ["neutral", 22],
  "interactive/ghost": ["_literal", "transparent"], "interactive/ghost-hover": ["neutral", 16],
  "feedback/success": ["_literal", "#4ade80"], "feedback/success-subtle": ["_literal", "#052e16"],
  "feedback/warning": ["_literal", "#fbbf24"], "feedback/warning-subtle": ["_literal", "#1c1400"],
  "feedback/error": ["_literal", "#f87171"], "feedback/error-subtle": ["_literal", "#1c0a0a"],
  "feedback/info": ["_literal", "#60a5fa"], "feedback/info-subtle": ["_literal", "#0a1628"],
};

/**
 * Fills `lightRef` / `darkRef` on every semantic colour role it recognises.
 * Unrecognised (user-renamed or custom) roles are left untouched.
 */
function autoMapSemanticColors(tokenPaths: TokenPath[], groups: SemGroup[]): SemGroup[] {
  const byColor: Record<string, Array<{ path: string; hsl: HSL }>> = {};
  (tokenPaths || []).forEach(({ path, hex }) => {
    if (!isHex(hex)) return;
    const family = path.split("/")[0];
    (byColor[family] ||= []).push({ path, hsl: hexToHSL(hex) });
  });
  const families = Object.keys(byColor);
  if (!families.length) return groups;

  const avgSat = (f) => byColor[f].reduce((a, t) => a + t.hsl.s, 0) / byColor[f].length;
  const neutral = families.reduce((best, f) => (avgSat(f) < avgSat(best) ? f : best), families[0]);
  const chromatic = families.filter((f) => f !== neutral);
  const primary = chromatic.length
    ? chromatic.reduce((best, f) => (avgSat(f) > avgSat(best) ? f : best), chromatic[0])
    : neutral;

  const nearest = (family, lightness) => {
    const list = byColor[family];
    if (!list || !list.length) return null;
    return list.reduce((best, t) =>
      Math.abs(t.hsl.l - lightness) < Math.abs(best.hsl.l - lightness) ? t : best
    );
  };

  const resolve = (table, roleName) => {
    const target = table[roleName];
    if (!target) return undefined;                       // unknown role → skip
    const [familyKey, arg] = target;
    if (familyKey === "_literal") return arg;
    const family = familyKey === "neutral" ? neutral : primary;
    const hit = nearest(family, arg);
    return hit ? `{${hit.path}}` : undefined;
  };

  return (groups || []).map((g) => ({
    ...g,
    roles: g.roles.map((r) => {
      const light = resolve(LIGHT_TARGETS, r.name);
      const dark = resolve(DARK_TARGETS, r.name);
      return {
        ...r,
        lightRef: light !== undefined ? light : r.lightRef,
        darkRef: dark !== undefined ? dark : r.darkRef,
      };
    }),
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. GENERATORS
   The prompt is a *hardcoded template*; only the values are interpolated.
   Two variants exist — Color Base and Color Palette — chosen by `colorMode`.
   ═══════════════════════════════════════════════════════════════════════════ */

const RULE = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
const filled = <T extends Record<string, any>>(list: T[] | undefined, ...keys: string[]): T[] =>
  (list || []).filter((i) => i.name && keys.every((k) => !blank(i[k])));

function promptHeader(brands: string[], hasComponents: boolean): string {
  return `You are a Figma Variables architect. Your job is to create design tokens inside Figma Variables exactly as specified below. Do not interpret, improvise, or add anything beyond what is written.

Follow these rules strictly:
1. Create all PRIMITIVE collections first before creating any SEMANTIC tokens
2. Create all SEMANTIC tokens before creating any COMPONENT tokens
3. Every token containing {} is a reference — map it as an alias, not a raw value
4. Never hardcode a value where a {} reference is specified
5. Create each collection and mode exactly as named — do not rename, reorder, or merge
6. Token type inference: #hex or rgba() → color | Npx → dimension | Nms → duration | plain number → number | "text" → string | {} → alias
7. Verify every {} reference resolves to an existing token — flag any broken reference
8. Do not create any token not listed below
9. Confirm total token count per collection when done

${RULE}
== STRUCTURE ==
${RULE}

COLLECTION: Primitives
  MODES: [${brands.join(", ")}]

COLLECTION: Semantics
  MODES: [Light, Dark]

COLLECTION: Semantics/Effects and Motion
  MODES: [Default]
${hasComponents ? `
COLLECTION: Components
  MODES: [Default]
` : ""}
Mapping rule:
  Semantics reference Primitives using the active brand mode
  Components reference Semantics using the active light/dark mode
  Semantics/Effects and Motion reference Primitives — mode-independent

`;
}

/** Everything that is identical across brands (type, scale, effects, motion). */
function sharedPrimitivesBlock(S: PlannerDoc): string {
  const { typography: TY, scale: SC, effects: EF, motion: MO } = S;
  let o = "";
  const push = (type, rows) => { if (rows.length) { o += `  TYPE: ${type}\n`; rows.forEach((r) => (o += `  ${r}\n`)); } };

  if (TY.familyMode === "universal")
    push("string", filled(TY.universalFamilies, "value").map((f) => `font/family/${slugify(f.name)}: "${f.value}"`));

  push("dimension", filled(TY.sizeScale, "value").map((s) => `font/size/${slugify(s.name)}: ${s.value}`));
  push("number", filled(TY.weightScale, "value").map((s) => `font/weight/${slugify(s.name)}: ${s.value}`));
  push("lineHeights", filled(TY.lineHeightScale, "value").map((s) => `font/lineHeight/${slugify(s.name)}: ${s.value}`));
  push("letterSpacing", filled(TY.trackingScale, "value").map((s) => `font/tracking/${slugify(s.name)}: ${s.value}%`));
  push("dimension", filled(SC.scale, "value").map((s) => `scale/${slugify(s.name)}: ${s.value}`));
  push("borderWidth", filled(SC.borderWidths, "value").map((s) => `border/width/${slugify(s.name)}: ${s.value}`));
  push("borderRadius", filled(SC.borderRadius, "value").map((s) => `border/radius/${slugify(s.name)}: ${s.value}`));

  const shadows = (EF.shadows || []).filter((s) => s.name && (s.x || s.y || s.blur || s.spread || s.color));
  push("boxShadow", shadows.map((s) =>
    `shadow/${slugify(s.name)}: ${s.x || 0}px ${s.y || 0}px ${s.blur || 0}px ${s.spread || 0}px ${s.color || "rgba(0,0,0,0.1)"}`));

  push("dimension", filled(EF.blurs, "value").map((s) => `blur/${slugify(s.name)}: ${s.value}px`));
  push("number", filled(EF.opacity, "value").map((s) => `opacity/${slugify(s.name)}: ${s.value}%`));
  push("duration", filled(MO.durations, "value").map((s) => `motion/${slugify(s.name)}: ${s.value}`));
  push("cubicBezier", filled(MO.easings, "value").map((s) => `motion/${slugify(s.name)}: ${s.value}`));
  return o;
}

function brandFamiliesBlock(S: PlannerDoc, brand: string): string {
  if (S.typography.familyMode !== "per-brand") return "";
  const fams = filled(S.typography.brandFamilies?.[brand], "value");
  if (!fams.length) return "";
  return `  TYPE: string\n` + fams.map((f) => `  font/family/${slugify(f.name)}: "${f.value}"\n`).join("");
}

function semanticsBlock(S: PlannerDoc): string {
  const { semColorGroups, semTypoGroups, semScaleGroups, zIndex, effects: EF, motion: MO } = S;
  let o = `${RULE}\n== SEMANTICS ==\n${RULE}\n\n`;

  ["Light", "Dark"].forEach((modeLabel) => {
    const key = modeLabel.toLowerCase() + "Ref";
    o += `COLLECTION: Semantics | MODE: ${modeLabel}\n`;

    const colorLines = [];
    (semColorGroups || []).forEach((g) => {
      const rows = g.roles.filter((r) => r.name && !blank(r[key]));
      if (rows.length) {
        colorLines.push(`  // ${g.name}`);
        rows.forEach((r) => colorLines.push(`  ${slugify(r.name)}: ${r[key]}`));
      }
    });
    if (colorLines.length) o += `  TYPE: color\n${colorLines.join("\n")}\n`;

    const typoRows = (semTypoGroups || []).flatMap((g) =>
      g.roles.filter((r) => r.name && (r.family || r.size || r.weight || r.lineHeight || r.tracking))
    );
    if (typoRows.length) {
      o += `  TYPE: typography\n`;
      typoRows.forEach((r) => {
        const parts = [];
        if (r.family) parts.push(`fontFamily: ${r.family}`);
        if (r.size) parts.push(`fontSize: ${r.size}`);
        if (r.weight) parts.push(`fontWeight: ${r.weight}`);
        if (r.lineHeight) parts.push(`lineHeight: ${r.lineHeight}`);
        if (r.tracking) parts.push(`letterSpacing: ${r.tracking}`);
        o += `  ${slugify(r.name)}: { ${parts.join(", ")} }\n`;
      });
    }

    const scaleLines = [];
    (semScaleGroups || []).forEach((g) => {
      const rows = g.roles.filter((r) => r.name && !blank(r.ref));
      if (rows.length) {
        scaleLines.push(`  // ${g.name}`);
        rows.forEach((r) => scaleLines.push(`  ${slugify(r.name)}: ${r.ref}`));
      }
    });
    if (scaleLines.length) o += `  TYPE: dimension\n${scaleLines.join("\n")}\n`;

    const z = filled(zIndex, "value");
    if (z.length) o += `  TYPE: number\n` + z.map((t) => `  z-index/${slugify(t.name)}: ${t.value}\n`).join("");
    o += `\n`;
  });

  // Mode-independent effects + motion
  const em = [];
  const collect = (list: SemRole[] | undefined, prefix: string): void =>
    (list || []).filter((r) => r.name && !blank(r.ref)).forEach((r) => em.push(`  ${prefix}/${slugify(r.name)}: ${r.ref}`));
  collect(EF.semantic?.shadowRoles, "shadow");
  collect(EF.semantic?.blurRoles, "blur");
  collect(EF.semantic?.opacityRoles, "opacity");
  collect(MO.semantic?.durationRoles, "motion/duration");
  collect(MO.semantic?.easingRoles, "motion/easing");
  (MO.semantic?.transitions || []).forEach((t) => {
    if (!t.name) return;
    if (!blank(t.durationRef)) em.push(`  motion/transition/${slugify(t.name)}/duration: ${t.durationRef}`);
    if (!blank(t.easingRef)) em.push(`  motion/transition/${slugify(t.name)}/easing: ${t.easingRef}`);
  });
  o += `COLLECTION: Semantics/Effects and Motion | MODE: Default\n`;
  o += em.length ? `  TYPE: alias\n${em.join("\n")}\n\n` : `  (no tokens defined)\n\n`;
  return o;
}

function componentsBlock(components: ComponentDefinition[]): string {
  if (!components?.length) return "";
  let o = `${RULE}\n== COMPONENTS ==\n${RULE}\n\nCOLLECTION: Components | MODE: Default\n`;
  components.forEach((c) => {
    const rows = (c.tokens || []).filter((t) => t.name && !blank(t.value));
    o += `\n  [${c.name}]\n`;
    o += rows.length
      ? rows.map((t) => `  ${slugify(c.name)}/${slugify(t.name)}: ${t.value}\n`).join("")
      : `  (no tokens defined)\n`;
  });
  return o + "\n";
}

function verifyBlock(S: PlannerDoc): string {
  const brands = S.project.brands || ["Brand A"];
  const lines = [
    `1. Primitives collection has ${brands.length} mode${brands.length > 1 ? "s" : ""}: [${brands.join(", ")}]`,
    `2. Semantics collection has exactly 2 modes: Light and Dark`,
    `3. Semantics/Effects and Motion has 1 mode: Default`,
  ];
  if (S.components?.length)
    lines.push(`4. Components collection has ${S.components.length} component${S.components.length > 1 ? "s" : ""}`);
  lines.push(`${lines.length + 1}. Every {} reference resolves to an existing token — flag broken references`);
  lines.push(`${lines.length + 1}. No raw values inside Semantics or Components — all must be aliases`);
  lines.push(`${lines.length + 1}. Report the final token count for each collection`);
  return `${RULE}\n== VERIFY ==\n${RULE}\n\nAfter creating all tokens verify:\n${lines.join("\n")}\n`;
}

/* ── template A: Color Base (AI generates the shades) ───────────────────── */
function generateBasePrompt(S: PlannerDoc): string {
  const brands = S.project.brands || ["Brand A"];
  let o = promptHeader(brands, !!S.components?.length);
  o += `IMPORTANT — Color Generation Rule:
For each base color below, generate the full shade scale BEFORE creating any semantic token.
The generated shade names must match the paths referenced in the SEMANTICS section exactly.

${RULE}
== PRIMITIVES ==
${RULE}

`;
  brands.forEach((brand) => {
    o += `COLLECTION: Primitives | MODE: ${brand}\n  TYPE: color\n`;
    const list = (S.colorBase[brand] || []).filter((c) => isColor(c.hex) && c.name);
    if (!list.length) o += `  (no colors defined)\n`;
    list.forEach((c) => {
      const name = slugify(c.name);
      o += `  ${name}/base: ${c.hex}\n`;
      if (c.type === "transparency") {
        o += `  [Generate transparency scale: ${name}/10 through ${name}/90 — 9 steps at 10% intervals of the base color]\n`;
      } else {
        const count = Number(c.shadeCount) || 9;
        const first = count >= 11 ? 50 : 100;
        const last = count >= 10 ? 950 : 900;
        o += `  [Generate shade scale: ${name}/${first} through ${name}/${last} — ${count} shades derived from the base color]\n`;
      }
    });
    o += brandFamiliesBlock(S, brand);
    o += `\n`;
  });
  o += `COLLECTION: Primitives | MODE: All Brands (shared)\n${sharedPrimitivesBlock(S)}\n`;
  o += semanticsBlock(S) + componentsBlock(S.components) + verifyBlock(S);
  return o;
}

/* ── template B: Color Palette (exact hex per shade) ────────────────────── */
function generatePalettePrompt(S: PlannerDoc): string {
  const brands = S.project.brands || ["Brand A"];
  let o = promptHeader(brands, !!S.components?.length);
  o += `${RULE}\n== PRIMITIVES ==\n${RULE}\n\n`;
  brands.forEach((brand) => {
    o += `COLLECTION: Primitives | MODE: ${brand}\n  TYPE: color\n`;
    const groups = (S.colorPalette[brand] || []).filter((p) => p.name);
    let wrote = false;
    groups.forEach((p) => {
      p.shades.filter((s) => isColor(s.hex) && s.shade).forEach((s) => {
        o += `  ${slugify(p.name)}/${slugify(s.shade)}: ${s.hex}\n`;
        wrote = true;
      });
    });
    if (!wrote) o += `  (no colors defined)\n`;
    o += brandFamiliesBlock(S, brand);
    o += `\n`;
  });
  o += `COLLECTION: Primitives | MODE: All Brands (shared)\n${sharedPrimitivesBlock(S)}\n`;
  o += semanticsBlock(S) + componentsBlock(S.components) + verifyBlock(S);
  return o;
}

/* ── Token Studio JSON ──────────────────────────────────────────────────── */
function generateJSON(S: PlannerDoc): string {
  const brands = S.project.brands || ["Brand A"];
  const json: Record<string, any> = {};
  const setPath = (root: Record<string, any>, path: string, val: unknown): void => {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((k, i) => {
      if (i < parts.length - 1) { node[k] ||= {}; node = node[k]; }
      else node[k] = val;
    });
  };

  brands.forEach((brand) => {
    const key = slugify(brand) || "brand";
    json[key] = {};
    if (S.colorMode === "palette") {
      (S.colorPalette[brand] || []).forEach((p) =>
        p.shades.forEach((s) => {
          if (isColor(s.hex) && p.name && s.shade)
            setPath(json[key], `color/${slugify(p.name)}/${slugify(s.shade)}`, { value: s.hex, type: "color" });
        })
      );
    } else {
      (S.colorBase[brand] || []).forEach((c) => {
        if (!isColor(c.hex) || !c.name) return;
        setPath(json[key], `color/${slugify(c.name)}/base`, {
          value: c.hex,
          type: "color",
          description: `Generate ${c.shadeCount || 9} ${c.type === "transparency" ? "transparency steps" : "shades"}`,
        });
      });
    }
    if (S.typography.familyMode === "per-brand")
      filled(S.typography.brandFamilies?.[brand], "value").forEach((f) =>
        setPath(json[key], `font/family/${slugify(f.name)}`, { value: f.value, type: "fontFamilies" }));
  });

  json.global = {};
  const G = json.global;
  if (S.typography.familyMode === "universal")
    filled(S.typography.universalFamilies, "value").forEach((f) =>
      setPath(G, `font/family/${slugify(f.name)}`, { value: f.value, type: "fontFamilies" }));
  filled(S.typography.sizeScale, "value").forEach((s) => setPath(G, `font/size/${slugify(s.name)}`, { value: s.value, type: "dimension" }));
  filled(S.typography.weightScale, "value").forEach((s) => setPath(G, `font/weight/${slugify(s.name)}`, { value: Number(s.value) || s.value, type: "fontWeights" }));
  filled(S.typography.lineHeightScale, "value").forEach((s) => setPath(G, `font/lineHeight/${slugify(s.name)}`, { value: s.value, type: "lineHeights" }));
  filled(S.typography.trackingScale, "value").forEach((s) => setPath(G, `font/tracking/${slugify(s.name)}`, { value: `${s.value}%`, type: "letterSpacing" }));
  filled(S.scale.scale, "value").forEach((s) => setPath(G, `scale/${slugify(s.name)}`, { value: s.value, type: "dimension" }));
  filled(S.scale.borderWidths, "value").forEach((s) => setPath(G, `border/width/${slugify(s.name)}`, { value: s.value, type: "borderWidth" }));
  filled(S.scale.borderRadius, "value").forEach((s) => setPath(G, `border/radius/${slugify(s.name)}`, { value: s.value, type: "borderRadius" }));
  (S.effects.shadows || []).filter((s) => s.name && (s.x || s.y || s.blur || s.spread || s.color)).forEach((s) =>
    setPath(G, `shadow/${slugify(s.name)}`, {
      value: { x: String(s.x || "0"), y: String(s.y || "0"), blur: String(s.blur || "0"), spread: String(s.spread || "0"), color: s.color || "rgba(0,0,0,0.1)", type: "dropShadow" },
      type: "boxShadow",
    }));
  filled(S.effects.blurs, "value").forEach((s) => setPath(G, `blur/${slugify(s.name)}`, { value: `${s.value}px`, type: "dimension" }));
  filled(S.effects.opacity, "value").forEach((s) => setPath(G, `opacity/${slugify(s.name)}`, { value: `${s.value}%`, type: "opacity" }));
  filled(S.motion.durations, "value").forEach((s) => setPath(G, `motion/${slugify(s.name)}`, { value: s.value, type: "duration" }));
  filled(S.motion.easings, "value").forEach((s) => setPath(G, `motion/${slugify(s.name)}`, { value: s.value, type: "cubicBezier" }));

  ["light", "dark"].forEach((mode) => {
    const ref = `${mode}Ref`;
    json[mode] = { semantic: {} };
    const node = json[mode].semantic;
    (S.semColorGroups || []).forEach((g) => g.roles.forEach((r) => {
      if (r.name && !blank(r[ref])) setPath(node, `color/${slugify(r.name)}`, { value: r[ref], type: "color" });
    }));
    (S.semTypoGroups || []).forEach((g) => g.roles.forEach((r) => {
      if (!r.name || !(r.family || r.size || r.weight || r.lineHeight || r.tracking)) return;
      setPath(node, `typography/${slugify(r.name)}`, {
        value: { fontFamily: r.family || "", fontSize: r.size || "", fontWeight: r.weight || "", lineHeight: r.lineHeight || "", letterSpacing: r.tracking || "" },
        type: "typography",
      });
    }));
    (S.semScaleGroups || []).forEach((g) => g.roles.forEach((r) => {
      if (r.name && !blank(r.ref)) setPath(node, `scale/${slugify(r.name)}`, { value: r.ref, type: "dimension" });
    }));
    filled(S.zIndex, "value").forEach((z) => setPath(node, `zIndex/${slugify(z.name)}`, { value: Number(z.value), type: "other" }));
  });

  json["effects-motion"] = {};
  const EM = json["effects-motion"];
  const put = (list, prefix, type) =>
    (list || []).filter((r) => r.name && !blank(r.ref)).forEach((r) => setPath(EM, `${prefix}/${slugify(r.name)}`, { value: r.ref, type }));
  put(S.effects.semantic?.shadowRoles, "shadow", "boxShadow");
  put(S.effects.semantic?.blurRoles, "blur", "dimension");
  put(S.effects.semantic?.opacityRoles, "opacity", "opacity");
  put(S.motion.semantic?.durationRoles, "motion/duration", "duration");
  put(S.motion.semantic?.easingRoles, "motion/easing", "cubicBezier");
  (S.motion.semantic?.transitions || []).forEach((t) => {
    if (!t.name) return;
    if (!blank(t.durationRef)) setPath(EM, `motion/transition/${slugify(t.name)}/duration`, { value: t.durationRef, type: "duration" });
    if (!blank(t.easingRef)) setPath(EM, `motion/transition/${slugify(t.name)}/easing`, { value: t.easingRef, type: "cubicBezier" });
  });

  if (S.components?.length) {
    json.components = {};
    S.components.forEach((c) =>
      (c.tokens || []).forEach((t) => {
        if (c.name && t.name && !blank(t.value))
          setPath(json.components, `${slugify(c.name)}/${slugify(t.name)}`, { value: t.value, type: "color" });
      }));
  }
  return JSON.stringify(json, null, 2);
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. STYLESHEET — the app's own design system
   Structured exactly like the token systems this tool helps people build:

     Tier 1  PRIMITIVES  — a raw neutral ramp + status hues, one set per theme
     Tier 2  SEMANTICS   — surface / text / border roles that reference Tier 1
     Tier 3  COMPONENTS  — buttons, inputs, cards … reference Tier 2 only

   No component rule contains a raw colour. Switching theme swaps Tier 1 only.
   ═══════════════════════════════════════════════════════════════════════════ */

const CSS: string = `
/* ───────────────────────── TIER 1 · PRIMITIVES ───────────────────────── */

:root{
  /* neutral ramp — light */
  --n-0:#ffffff; --n-1:#fbfbfc; --n-2:#f5f5f7; --n-3:#ededf0; --n-4:#e3e4e8;
  --n-5:#d3d5db; --n-6:#8c8f98; --n-7:#727680; --n-8:#5b5f69; --n-9:#43464e;
  --n-10:#2c2e34; --n-11:#1a1c20; --n-12:#0d0e11;

  --accent-500:#2f6feb; --accent-600:#2560d8;
  --accent-a10:rgba(47,111,235,.09); --accent-a25:rgba(47,111,235,.24); --accent-a35:rgba(47,111,235,.34);
  --ok-500:#12864a; --ok-a12:rgba(18,134,74,.11);
  --warn-500:#a25c05; --warn-a12:rgba(162,92,5,.11);
  --danger-500:#c8342c; --danger-a12:rgba(200,52,44,.10);

  --shadow-key:rgba(14,16,22,.10); --shadow-ambient:rgba(14,16,22,.06);
  --scrim:rgba(16,18,24,.42);

  /* radius */
  --r-xs:4px; --r-sm:6px; --r-md:8px; --r-lg:12px; --r-xl:16px; --r-full:9999px;

  /* space — 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 */
  --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-5:20px;
  --s-6:24px; --s-8:32px; --s-10:40px; --s-12:48px;

  /* type */
  --font:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","DM Mono",Menlo,Consolas,monospace;
  --fs-11:11px; --fs-12:12px; --fs-13:13px; --fs-14:14px; --fs-16:16px; --fs-20:20px; --fs-26:26px;
  --lh-tight:1.25; --lh-snug:1.4; --lh-base:1.55;
  --tracking-caps:.06em; --tracking-tight:-.011em;

  /* motion */
  --dur-1:120ms; --dur-2:180ms; --dur-3:240ms;
  --ease:cubic-bezier(.2,0,0,1); --ease-out:cubic-bezier(.16,1,.3,1);

  /* metrics */
  --control-h:32px; --control-h-sm:28px; --sidebar-w:236px; --measure:780px; --gut:20px;
}

[data-tp-theme="dark"]{
  /* neutral ramp — dark (authored inverted so every semantic below still works) */
  --n-0:#0a0b0d; --n-1:#0f1013; --n-2:#15171b; --n-3:#1b1e23; --n-4:#23262c;
  --n-5:#2f333a; --n-6:#636872; --n-7:#7c818c; --n-8:#8e939d; --n-9:#aab0b9;
  --n-10:#ccd1d8; --n-11:#e6e9ee; --n-12:#f6f8fa;

  --accent-500:#5b8dff; --accent-600:#7aa2ff;
  --accent-a10:rgba(91,141,255,.13); --accent-a25:rgba(91,141,255,.26); --accent-a35:rgba(91,141,255,.40);
  --ok-500:#4ec98a; --ok-a12:rgba(78,201,138,.13);
  --warn-500:#e0a33a; --warn-a12:rgba(224,163,58,.13);
  --danger-500:#f0736c; --danger-a12:rgba(240,115,108,.13);

  --shadow-key:rgba(0,0,0,.44); --shadow-ambient:rgba(0,0,0,.30);
  --scrim:rgba(4,5,7,.62);
}

/* ───────────────────────── TIER 2 · SEMANTICS ────────────────────────── */

:root{
  --canvas:var(--n-1);
  --surface:var(--n-0);
  --surface-sunken:var(--n-2);
  --surface-hover:var(--n-2);
  --surface-active:var(--n-3);
  --chrome:var(--n-0);

  --border:var(--n-4);
  --border-soft:var(--n-3);
  --border-strong:var(--n-5);

  --text:var(--n-11);
  --text-2:var(--n-8);
  --text-3:var(--n-7);
  --text-4:var(--n-6);

  --accent:var(--accent-500);
  --accent-hover:var(--accent-600);
  --accent-surface:var(--accent-a10);
  --accent-border:var(--accent-a35);
  --focus-ring:var(--accent-a25);

  --solid:var(--n-11);
  --solid-hover:var(--n-10);
  --solid-text:var(--n-0);

  --ok:var(--ok-500);       --ok-surface:var(--ok-a12);
  --warn:var(--warn-500);   --warn-surface:var(--warn-a12);
  --danger:var(--danger-500); --danger-surface:var(--danger-a12);

  --shadow-xs:0 1px 2px var(--shadow-ambient);
  --shadow-sm:0 1px 2px var(--shadow-ambient),0 2px 6px -2px var(--shadow-key);
  --shadow-md:0 4px 12px -2px var(--shadow-key),0 2px 4px -2px var(--shadow-ambient);
  --shadow-lg:0 16px 40px -8px var(--shadow-key),0 4px 12px -4px var(--shadow-ambient);

  --code-bg:var(--n-2);
}
[data-tp-theme="dark"]{
  --canvas:var(--n-0);
  --surface:var(--n-2);
  --surface-sunken:var(--n-1);
  --surface-hover:var(--n-3);
  --surface-active:var(--n-4);
  --chrome:var(--n-1);
  --solid:var(--n-12);
  --solid-hover:var(--n-11);
  --solid-text:var(--n-0);
  --text:var(--n-12);
  --code-bg:var(--n-1);
}

/* ───────────────────────── TIER 3 · COMPONENTS ───────────────────────── */

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--canvas);color:var(--text);font-family:var(--font);
     font-size:var(--fs-14);line-height:var(--lh-base);overflow-x:hidden;
     -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}

/* theme cross-fade — limited to painted properties, never layout */
body,.shell,.sidebar,.topbar,.main,.card,.subcard,.input,.btn,.icon-btn,.group,
.group-head,.code,.callout,.chip,.tab,.side-item,.modal,.footbar,.empty{
  transition:background-color var(--dur-2) var(--ease),
             border-color var(--dur-2) var(--ease),
             color var(--dur-2) var(--ease)}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;
                       transition-duration:.01ms!important;scroll-behavior:auto!important}
}

:where(button,input,select,textarea,a,[tabindex]):focus-visible{
  outline:none;box-shadow:0 0 0 3px var(--focus-ring);border-radius:var(--r-sm)}

/* spacing utilities — token-driven, no arbitrary values */
.mt-2{margin-top:var(--s-2)}
.mt-3{margin-top:var(--s-3)}
.mt-4{margin-top:var(--s-4)}
.mb-3{margin-bottom:var(--s-3)}
.min0{min-width:0}
.push{margin-left:auto}
.input-title{font-weight:600;letter-spacing:var(--tracking-tight)}

.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
         clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:-9999px;top:0;z-index:999;background:var(--solid);color:var(--solid-text);
      padding:10px 16px;border-radius:0 0 var(--r-md) 0;font-weight:600;font-size:var(--fs-13)}
.skip:focus{left:0}

/* ══ SHELL ═══════════════════════════════════════════════════════════ */
.tp-app{min-height:100vh;min-height:100dvh;background:var(--canvas)}
.shell{display:grid;grid-template-columns:1fr;height:100vh;height:100dvh;overflow:hidden}
@media(min-width:1080px){
  .shell{grid-template-columns:var(--sidebar-w) 1fr}
  :root{--gut:32px}
}

/* ══ SIDEBAR (desktop) ═══════════════════════════════════════════════ */
.sidebar{display:none}
@media(min-width:1080px){
  .sidebar{display:flex;flex-direction:column;min-height:0;
           background:var(--chrome);border-right:1px solid var(--border-soft)}
}
.side-brand{display:flex;align-items:center;gap:10px;padding:var(--s-4) var(--s-4) var(--s-3)}
.brand-mark{width:26px;height:26px;flex:0 0 26px;border-radius:var(--r-sm);display:grid;place-items:center;
            background:var(--solid);color:var(--solid-text);font-size:12px;font-weight:700;letter-spacing:-.02em}
.brand-name{font-size:var(--fs-13);font-weight:650;letter-spacing:var(--tracking-tight);color:var(--text)}
.brand-serial{font-size:var(--fs-11);color:var(--text-4);font-family:var(--mono)}

.side-nav{flex:1;min-height:0;overflow-y:auto;padding:var(--s-2) var(--s-3) var(--s-4);
          scrollbar-width:thin}
.side-group+.side-group{margin-top:var(--s-4)}
.side-group-label{font-size:var(--fs-11);font-weight:600;letter-spacing:var(--tracking-caps);
                  text-transform:uppercase;color:var(--text-4);padding:0 var(--s-2) var(--s-2)}
.side-item{display:flex;align-items:center;gap:var(--s-2);width:100%;padding:6px var(--s-2);
           border:0;border-radius:var(--r-sm);background:transparent;cursor:pointer;
           font-family:inherit;font-size:var(--fs-13);color:var(--text-2);text-align:left;
           min-height:30px;transition:background-color var(--dur-1) var(--ease),color var(--dur-1) var(--ease)}
.side-item:hover{background:var(--surface-hover);color:var(--text)}
.side-item[aria-current="step"]{background:var(--accent-surface);color:var(--text);font-weight:600;
                                box-shadow:inset 2px 0 0 var(--accent)}
.side-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:14px;height:14px;flex:0 0 14px;border-radius:var(--r-full);display:grid;place-items:center;
     font-size:9px;font-weight:700;line-height:1;border:1.5px solid var(--border-strong);color:transparent}
.side-item[data-state="done"] .dot,.step-btn[data-state="done"] .dot{
  background:var(--ok);border-color:var(--ok);color:var(--surface)}
.side-item[data-state="skip"] .dot,.step-btn[data-state="skip"] .dot{
  background:var(--warn);border-color:var(--warn);color:var(--surface)}
.side-item[aria-current="step"] .dot,.step-btn[aria-current="step"] .dot{border-color:var(--accent)}
.side-item[aria-current="step"][data-state="todo"] .dot{background:var(--accent);border-color:var(--accent)}

.side-foot{border-top:1px solid var(--border-soft);padding:var(--s-3);display:flex;
           flex-direction:column;gap:var(--s-3)}
.side-progress{display:flex;flex-direction:column;gap:6px}
.side-progress-label{display:flex;justify-content:space-between;font-size:var(--fs-11);color:var(--text-3)}
.meter-track{height:4px;border-radius:var(--r-full);background:var(--surface-active);overflow:hidden}
.meter-fill{height:100%;border-radius:var(--r-full);background:var(--accent);
            transition:width var(--dur-3) var(--ease)}

/* ══ WORKSPACE ═══════════════════════════════════════════════════════ */
.workspace{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}

.topbar{display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);
        padding:10px var(--gut);background:var(--chrome);
        border-bottom:1px solid var(--border-soft);flex:0 0 auto}
.topbar-left{display:flex;align-items:center;gap:10px;min-width:0}
@media(min-width:1080px){.topbar-left>.brand-mark{display:none}}
.crumb{display:flex;align-items:baseline;gap:8px;min-width:0}
.crumb-phase{font-size:var(--fs-12);color:var(--text-4);white-space:nowrap}
.crumb-sep{color:var(--text-4);font-size:var(--fs-12)}
.crumb-step{font-size:var(--fs-13);font-weight:600;color:var(--text);letter-spacing:var(--tracking-tight);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-right{display:flex;align-items:center;gap:var(--s-2);flex:0 0 auto}

/* segmented control (theme) */
.seg{display:inline-flex;padding:2px;gap:2px;background:var(--surface-sunken);
     border:1px solid var(--border-soft);border-radius:var(--r-md)}
.seg-btn{display:grid;place-items:center;width:28px;height:24px;border:0;border-radius:var(--r-xs);
         background:transparent;color:var(--text-3);cursor:pointer;font-size:12px;font-family:inherit;
         transition:background-color var(--dur-1) var(--ease),color var(--dur-1) var(--ease)}
.seg-btn:hover{color:var(--text)}
.seg-btn[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:var(--shadow-xs)}
@media (pointer:coarse){.seg-btn{width:34px;height:30px}}

/* mobile step rail */
.rail{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;flex:0 0 auto;
      padding:0 var(--gut);background:var(--chrome);border-bottom:1px solid var(--border-soft);
      scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}
.rail::-webkit-scrollbar{display:none}
@media(min-width:1080px){.rail{display:none}}
.step-btn{flex:0 0 auto;scroll-snap-align:center;display:flex;align-items:center;gap:6px;
          padding:10px 10px 9px;background:none;border:0;border-bottom:2px solid transparent;
          cursor:pointer;font-family:inherit;font-size:var(--fs-12);color:var(--text-3);
          white-space:nowrap;-webkit-tap-highlight-color:transparent;min-height:42px;
          transition:color var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease)}
.step-btn[aria-current="step"]{color:var(--text);font-weight:600;border-bottom-color:var(--accent)}

/* content column */
.main{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
      padding:var(--s-6) var(--gut) var(--s-10);scroll-behavior:smooth}
.main>*{max-width:var(--measure);margin-inline:auto}
.step-view{animation:fade var(--dur-3) var(--ease-out)}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

.page-head{margin-bottom:var(--s-6);max-width:var(--measure);margin-inline:auto}
.page-eyebrow{font-size:var(--fs-11);font-weight:600;letter-spacing:var(--tracking-caps);
              text-transform:uppercase;color:var(--text-4);margin-bottom:6px}
.page-title{font-size:var(--fs-26);font-weight:650;letter-spacing:-.02em;line-height:var(--lh-tight);color:var(--text)}
.page-desc{font-size:var(--fs-14);color:var(--text-2);margin-top:8px;max-width:64ch;line-height:var(--lh-base)}

/* ══ SURFACES ════════════════════════════════════════════════════════ */
.card{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--r-lg);
      padding:var(--s-4);margin-bottom:var(--s-3);box-shadow:var(--shadow-xs)}
.card-flush{padding:0;overflow:hidden}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);
           margin-bottom:var(--s-3);flex-wrap:wrap}
.card-title{font-size:var(--fs-12);font-weight:650;letter-spacing:.02em;color:var(--text)}
.card-note{font-size:var(--fs-12);color:var(--text-3);margin:-6px 0 var(--s-3);line-height:var(--lh-snug);max-width:70ch}
.subcard{background:var(--surface-sunken);border:1px solid var(--border-soft);border-radius:var(--r-md);
         padding:var(--s-3);margin-bottom:var(--s-2)}

.stack{display:flex;flex-direction:column;gap:var(--s-2)}
.row{display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap}
.row-nowrap{display:flex;align-items:center;gap:var(--s-2);min-width:0}
.spread{display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);flex-wrap:wrap}
.grow{flex:1;min-width:0}
.divider{height:1px;background:var(--border-soft);margin:var(--s-3) 0}
.grid-2{display:grid;grid-template-columns:1fr;gap:var(--s-3)}
@media(min-width:600px){.grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}}
.grid-auto{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s-2)}

/* ══ FORM ════════════════════════════════════════════════════════════ */
.field{display:flex;flex-direction:column;gap:5px;min-width:0}
.field-label{font-size:var(--fs-12);font-weight:550;color:var(--text-2);letter-spacing:.005em}
.field-hint{font-size:var(--fs-12);color:var(--text-4);line-height:var(--lh-snug)}
.field-error{font-size:var(--fs-12);color:var(--danger);display:flex;align-items:center;gap:4px;line-height:var(--lh-snug)}

.input{width:100%;min-width:0;height:var(--control-h);padding:0 10px;
       background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);
       color:var(--text);font-size:var(--fs-13);font-family:inherit;outline:none;
       transition:border-color var(--dur-1) var(--ease),box-shadow var(--dur-1) var(--ease),background-color var(--dur-1) var(--ease)}
textarea.input{height:auto;padding:8px 10px;line-height:var(--lh-base);resize:vertical}
.input::placeholder{color:var(--text-4)}
.input:hover:not(:disabled):not([readonly]):not(:focus){border-color:var(--border-strong)}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--focus-ring)}
.input[readonly]{background:var(--surface-sunken);color:var(--text-3);cursor:default}
.input[aria-invalid="true"]{border-color:var(--danger)}
.input[aria-invalid="true"]:focus{box-shadow:0 0 0 3px var(--danger-surface)}
.input-mono{font-family:var(--mono);font-size:var(--fs-12);letter-spacing:-.01em}
.input-sm{height:var(--control-h-sm);font-size:var(--fs-12);padding:0 8px}
@media (pointer:coarse){
  :root{--control-h:40px;--control-h-sm:38px}
  .input{font-size:var(--fs-14)}
}
select.input{cursor:pointer;appearance:none;padding-right:26px;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 14px) 54%,calc(100% - 9px) 54%;
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;color:var(--text)}

.color-pair{display:flex;align-items:center;gap:6px;min-width:0}
.swatch-input{width:var(--control-h);height:var(--control-h);flex:0 0 var(--control-h);padding:3px;cursor:pointer;
              background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm)}
.swatch-input::-webkit-color-swatch-wrapper{padding:0}
.swatch-input::-webkit-color-swatch{border:none;border-radius:3px}
.swatch{width:24px;height:24px;flex:0 0 24px;border-radius:var(--r-xs);border:1px solid var(--border);
        background-image:linear-gradient(45deg,var(--surface-sunken) 25%,transparent 25%,transparent 75%,var(--surface-sunken) 75%),
                         linear-gradient(45deg,var(--surface-sunken) 25%,transparent 25%,transparent 75%,var(--surface-sunken) 75%);
        background-size:8px 8px;background-position:0 0,4px 4px}
.swatch-fill{width:100%;height:100%;border-radius:3px}
.preview-bar{height:var(--control-h);border-radius:var(--r-sm);border:1px solid var(--border)}

/* ══ BUTTONS ═════════════════════════════════════════════════════════ */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:var(--control-h);
     padding:0 12px;border-radius:var(--r-sm);border:1px solid transparent;
     font-family:inherit;font-size:var(--fs-13);font-weight:550;letter-spacing:.002em;
     cursor:pointer;white-space:nowrap;-webkit-tap-highlight-color:transparent;
     transition:background-color var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease),
                color var(--dur-1) var(--ease),opacity var(--dur-1) var(--ease),transform 90ms var(--ease)}
.btn:active:not(:disabled){transform:scale(.985)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn-primary{background:var(--solid);color:var(--solid-text);border-color:transparent;box-shadow:var(--shadow-xs)}
.btn-primary:hover:not(:disabled){background:var(--solid-hover)}
.btn-ghost{background:var(--surface);color:var(--text-2);border-color:var(--border)}
.btn-ghost:hover:not(:disabled){background:var(--surface-hover);color:var(--text);border-color:var(--border-strong)}
.btn-danger{background:transparent;color:var(--danger);border-color:var(--border)}
.btn-danger:hover:not(:disabled){background:var(--danger-surface);border-color:var(--danger)}
.btn-sm{height:var(--control-h-sm);padding:0 10px;font-size:var(--fs-12)}
.btn-block{width:100%}

.icon-btn{display:grid;place-items:center;width:var(--control-h-sm);height:var(--control-h-sm);
          flex:0 0 var(--control-h-sm);background:transparent;border:1px solid transparent;
          border-radius:var(--r-sm);color:var(--text-3);cursor:pointer;font-size:12px;line-height:1;
          -webkit-tap-highlight-color:transparent;
          transition:background-color var(--dur-1) var(--ease),color var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease)}
.icon-btn:hover:not(:disabled){background:var(--surface-hover);color:var(--text);border-color:var(--border)}
.icon-btn:disabled{opacity:.3;cursor:not-allowed}
.icon-btn-danger:hover:not(:disabled){background:var(--danger-surface);color:var(--danger);border-color:transparent}

/* ══ TABS & CHIPS ════════════════════════════════════════════════════ */
.tabs{display:flex;gap:2px;margin-bottom:var(--s-5);padding-bottom:0;
      border-bottom:1px solid var(--border-soft);flex-wrap:wrap}
.tab{height:34px;padding:0 12px;border:0;background:transparent;color:var(--text-3);
     font-family:inherit;font-size:var(--fs-13);font-weight:550;cursor:pointer;
     border-bottom:2px solid transparent;margin-bottom:-1px;
     transition:color var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease)}
.tab:hover{color:var(--text)}
.tab[aria-selected="true"]{color:var(--text);border-bottom-color:var(--accent)}
@media (pointer:coarse){.tab{height:42px}}

.tabs-sub{display:flex;align-items:center;gap:6px;margin-bottom:var(--s-4);flex-wrap:wrap}
.tab-sm{height:var(--control-h-sm);padding:0 12px;border:1px solid var(--border);border-radius:var(--r-sm);
        background:var(--surface);color:var(--text-3);font-family:inherit;font-size:var(--fs-12);
        font-weight:550;cursor:pointer;margin-bottom:0;
        transition:background-color var(--dur-1) var(--ease),color var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease)}
.tab-sm:hover{color:var(--text);border-color:var(--border-strong)}
.tab-sm[aria-selected="true"]{background:var(--accent-surface);border-color:var(--accent-border);color:var(--text);border-bottom-color:var(--accent-border)}
.tab-or{font-size:var(--fs-11);font-weight:600;color:var(--text-4);letter-spacing:var(--tracking-caps);
        text-transform:uppercase;user-select:none;padding:0 2px}

.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:var(--s-3)}
.chip{height:var(--control-h-sm);padding:0 11px;border-radius:var(--r-full);border:1px solid var(--border);
      background:var(--surface);color:var(--text-2);font-family:inherit;font-size:var(--fs-12);
      font-weight:550;cursor:pointer;
      transition:background-color var(--dur-1) var(--ease),color var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease)}
.chip:hover{border-color:var(--border-strong);color:var(--text)}
.chip[aria-pressed="true"]{background:var(--accent-surface);border-color:var(--accent-border);color:var(--text)}

/* ══ NAME / VALUE EDITOR ═════════════════════════════════════════════ */
.nv-head{display:none}
@media(min-width:680px){
  .nv-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) auto;gap:var(--s-2);
           padding:0 2px 6px;border-bottom:1px solid var(--border-soft);margin-bottom:4px}
  .nv-head span{font-size:var(--fs-11);font-weight:600;letter-spacing:var(--tracking-caps);
                text-transform:uppercase;color:var(--text-4)}
}
.nv-row{display:grid;gap:6px;padding:5px 0;border-bottom:1px solid var(--border-soft);
        grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"name acts" "value value"}
.nv-row:last-of-type{border-bottom:0}
@media(min-width:680px){
  .nv-row{grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) auto;
          grid-template-areas:"name value acts";align-items:center}
}
.nv-name{grid-area:name;min-width:0}
.nv-value{grid-area:value;min-width:0}
.nv-acts{grid-area:acts;display:flex;gap:2px;align-items:center;justify-self:end}

.wide-row{display:grid;gap:var(--s-3);padding:var(--s-3);border:1px solid var(--border-soft);
          border-radius:var(--r-md);background:var(--surface-sunken);margin-bottom:var(--s-2)}
.wide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s-2)}
@media(min-width:600px){.wide-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}

/* ══ SEMANTIC GROUP EDITOR ═══════════════════════════════════════════ */
.group{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--r-lg);
       margin-bottom:var(--s-3);overflow:hidden;box-shadow:var(--shadow-xs)}
.group-head{display:flex;align-items:center;gap:4px;padding:6px 8px;background:var(--surface-sunken);
            border-bottom:1px solid var(--border-soft)}
.group-name{flex:1;min-width:0;height:var(--control-h-sm);background:transparent;
            border:1px solid transparent;border-radius:var(--r-sm);padding:0 8px;
            color:var(--text);font-family:inherit;font-size:var(--fs-12);font-weight:650;
            letter-spacing:.01em;outline:none;
            transition:background-color var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease)}
.group-name:hover{background:var(--surface);border-color:var(--border)}
.group-name:focus{background:var(--surface);border-color:var(--accent);box-shadow:0 0 0 3px var(--focus-ring)}
.group-body{padding:var(--s-2) var(--s-3) var(--s-3)}
.role{display:grid;gap:6px;padding:6px 0;border-bottom:1px solid var(--border-soft);
      grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"rname racts" "rmap rmap"}
.role:last-of-type{border-bottom:0}
@media(min-width:680px){
  .role{grid-template-columns:minmax(0,200px) minmax(0,1fr) auto;
        grid-template-areas:"rname rmap racts";align-items:center}
}
.role-name{grid-area:rname;min-width:0}
.role-map{grid-area:rmap;min-width:0;display:flex;align-items:center;gap:6px}
.role-acts{grid-area:racts;display:flex;gap:2px;justify-self:end}
.arrow{color:var(--text-4);font-size:var(--fs-12);flex:0 0 auto}
.mapped{font-family:var(--mono);font-size:var(--fs-12);color:var(--accent);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.mapped-empty{color:var(--text-4);font-style:italic;font-family:var(--font)}
.typo-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;flex:1;min-width:0}
@media(min-width:900px){.typo-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}

/* ══ FEEDBACK ════════════════════════════════════════════════════════ */
.callout{display:flex;gap:9px;align-items:flex-start;border-radius:var(--r-md);
         padding:10px 12px;font-size:var(--fs-13);line-height:var(--lh-snug);
         margin-bottom:var(--s-3);border:1px solid transparent}
.callout>span:first-child{flex:0 0 auto;font-size:12px;line-height:1.4;opacity:.9}
.callout-info{background:var(--accent-surface);border-color:var(--accent-border);color:var(--text-2)}
.callout-warn{background:var(--warn-surface);border-color:var(--warn);color:var(--text-2)}
.callout-ok{background:var(--ok-surface);border-color:var(--ok);color:var(--text-2)}
.callout b{color:var(--text);font-weight:600}
.callout code,.page-desc code,.card-note code{font-family:var(--mono);font-size:.94em;
  background:var(--surface-sunken);border:1px solid var(--border-soft);
  border-radius:var(--r-xs);padding:1px 5px;color:var(--text)}

.empty{text-align:center;padding:24px 16px;border:1px dashed var(--border);border-radius:var(--r-md);
       background:var(--surface-sunken);color:var(--text-3);font-size:var(--fs-13)}
.empty-title{font-weight:600;color:var(--text-2);margin-bottom:3px;font-size:var(--fs-13)}

.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:var(--r-full);
       font-size:var(--fs-11);font-weight:600;white-space:nowrap;border:1px solid transparent}
.badge-ok{background:var(--ok-surface);color:var(--ok);border-color:var(--ok-surface)}
.badge-warn{background:var(--warn-surface);color:var(--warn);border-color:var(--warn-surface)}
.badge-idle{background:var(--surface-sunken);color:var(--text-3);border-color:var(--border-soft)}

/* ══ SUMMARY ═════════════════════════════════════════════════════════ */
.sum-row{display:flex;justify-content:space-between;align-items:center;gap:var(--s-4);
         padding:8px 2px;border-bottom:1px solid var(--border-soft);font-size:var(--fs-13)}
.sum-row:last-child{border-bottom:0}
.sum-key{color:var(--text-3);font-size:var(--fs-13);min-width:0}
.sum-val{font-weight:550;color:var(--text);text-align:right;word-break:break-word;
         font-variant-numeric:tabular-nums}
.sum-link{background:none;border:0;padding:0;font:inherit;color:var(--text-2);cursor:pointer;text-align:left}
.sum-link:hover{color:var(--accent)}

/* ══ CODE OUTPUT ═════════════════════════════════════════════════════ */
.out{margin-bottom:var(--s-5)}
.out-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s-2);
          margin-bottom:8px;flex-wrap:wrap}
.out-label{font-size:var(--fs-12);font-weight:650;color:var(--text)}
.out-meta{font-weight:400;color:var(--text-4)}
.code{background:var(--code-bg);border:1px solid var(--border-soft);border-radius:var(--r-md);
      padding:14px 16px;overflow:auto;max-height:min(58vh,520px);
      font-family:var(--mono);font-size:var(--fs-12);line-height:1.7;color:var(--text-2);
      white-space:pre;-webkit-overflow-scrolling:touch;tab-size:2}
.code::-webkit-scrollbar{width:10px;height:10px}
.code::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:var(--r-full);
                               border:3px solid var(--code-bg)}

/* ══ FOOTER ACTIONS ══════════════════════════════════════════════════ */
.footbar{flex:0 0 auto;background:var(--chrome);border-top:1px solid var(--border-soft);
         padding:10px var(--gut);padding-bottom:calc(10px + env(safe-area-inset-bottom))}
.footbar-inner{max-width:var(--measure);margin-inline:auto;display:flex;
               align-items:center;justify-content:space-between;gap:var(--s-2)}

/* ══ MODAL ═══════════════════════════════════════════════════════════ */
.overlay{position:fixed;inset:0;z-index:200;background:var(--scrim);display:grid;place-items:center;
         padding:var(--s-4);animation:fade var(--dur-2) var(--ease-out)}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-xl);
       padding:var(--s-5);width:100%;max-width:460px;max-height:82vh;overflow-y:auto;
       box-shadow:var(--shadow-lg)}
.modal-title{font-size:var(--fs-16);font-weight:650;color:var(--text);letter-spacing:var(--tracking-tight)}
.modal-desc{font-size:var(--fs-13);color:var(--text-2);margin:6px 0 var(--s-4);line-height:var(--lh-base)}
.modal-item{background:var(--surface-sunken);border:1px solid var(--border-soft);border-radius:var(--r-md);
            padding:var(--s-3);margin-bottom:var(--s-2)}
.modal-item-title{font-size:var(--fs-13);font-weight:600;color:var(--text);margin-bottom:9px}

/* ══ TOAST ═══════════════════════════════════════════════════════════ */
.toast{position:fixed;left:50%;bottom:calc(var(--s-6) + env(safe-area-inset-bottom));z-index:300;
       transform:translateX(-50%);background:var(--solid);color:var(--solid-text);
       padding:9px 16px;border-radius:var(--r-md);font-size:var(--fs-13);font-weight:550;
       box-shadow:var(--shadow-lg);animation:toastIn var(--dur-3) var(--ease-out);
       max-width:calc(100vw - 32px)}
@keyframes toastIn{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}

/* ══ LANDING ═════════════════════════════════════════════════════════ */
.landing{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;
         align-items:center;justify-content:center;text-align:center;
         padding:var(--s-12) var(--gut);gap:var(--s-3);background:var(--canvas)}
.landing-mark{width:56px;height:56px;border-radius:var(--r-lg);display:grid;place-items:center;
              background:var(--solid);color:var(--solid-text);font-size:20px;font-weight:700;
              letter-spacing:-.03em;box-shadow:var(--shadow-md);margin-bottom:var(--s-2)}
.landing-title{font-size:var(--fs-26);font-weight:650;letter-spacing:-.025em;color:var(--text)}
.landing-desc{font-size:var(--fs-14);color:var(--text-2);max-width:44ch;line-height:var(--lh-base)}
.landing-list{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:var(--s-1)}
.landing-tag{font-size:var(--fs-12);font-weight:500;color:var(--text-3);background:var(--surface);
             border:1px solid var(--border-soft);border-radius:var(--r-full);padding:4px 11px}
.landing-actions{display:flex;align-items:center;gap:var(--s-3);margin-top:var(--s-4)}

/* ══ TOOLTIP — CSS only, no dependency, no extra render ══════════════ */
[data-tip]{position:relative}
[data-tip]::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 7px);left:50%;
  transform:translateX(-50%) translateY(3px);white-space:nowrap;pointer-events:none;
  background:var(--solid);color:var(--solid-text);font-size:var(--fs-11);font-weight:550;
  font-family:var(--font);letter-spacing:0;line-height:1.4;padding:4px 8px;border-radius:var(--r-xs);
  box-shadow:var(--shadow-md);opacity:0;z-index:150;
  transition:opacity var(--dur-1) var(--ease),transform var(--dur-1) var(--ease)}
[data-tip]:hover::after,[data-tip]:focus-visible::after{opacity:1;transform:translateX(-50%) translateY(0)}
[data-tip-below]::after{bottom:auto;top:calc(100% + 7px);transform:translateX(-50%) translateY(-3px)}
[data-tip-below]:hover::after,[data-tip-below]:focus-visible::after{transform:translateX(-50%) translateY(0)}
@media (pointer:coarse){[data-tip]::after{display:none}}

/* ══ COPY BUTTON ═════════════════════════════════════════════════════ */
.copy-btn{display:grid;place-items:center;width:26px;height:26px;flex:0 0 26px;
  background:transparent;border:1px solid transparent;border-radius:var(--r-xs);
  color:var(--text-4);cursor:pointer;font-size:11px;line-height:1;font-family:var(--font);
  transition:background-color var(--dur-1) var(--ease),color var(--dur-1) var(--ease),
             border-color var(--dur-1) var(--ease)}
.copy-btn:hover:not(:disabled){background:var(--surface-hover);color:var(--text);border-color:var(--border)}
.copy-btn:disabled{opacity:.35;cursor:not-allowed}
.copy-btn[data-copied="true"]{color:var(--ok);border-color:transparent;background:var(--ok-surface)}
@media (pointer:coarse){.copy-btn{width:34px;height:34px;flex:0 0 34px}}

/* ══ PREVIEW SURFACE ═════════════════════════════════════════════════ */
.preview{border:1px solid var(--border-soft);border-radius:var(--r-lg);overflow:hidden;
  background:var(--surface);margin-bottom:var(--s-3);box-shadow:var(--shadow-xs)}
.preview-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);
  padding:8px 12px;border-bottom:1px solid var(--border-soft);background:var(--surface-sunken)}
.preview-title{display:flex;align-items:center;gap:7px;font-size:var(--fs-12);font-weight:650;color:var(--text)}
.preview-live{width:6px;height:6px;border-radius:var(--r-full);background:var(--ok);flex:0 0 6px}
.preview-hint{font-size:var(--fs-11);color:var(--text-3)}
/* the canvas paints itself with the USER's tokens, never the app's */
.preview-canvas{padding:var(--s-4);display:flex;flex-direction:column;gap:var(--s-4);
  transition:background-color var(--dur-2) var(--ease)}
.preview-row{display:flex;flex-wrap:wrap;gap:var(--s-2);align-items:center}
.preview-note{padding:var(--s-4);font-size:var(--fs-13);color:var(--text-3);text-align:center}
.preview-group-label{font-size:var(--fs-11);font-weight:600;letter-spacing:var(--tracking-caps);
  text-transform:uppercase;opacity:.6;margin-bottom:7px}

/* specimen (typography preview) */
.specimen{display:flex;flex-direction:column;gap:var(--s-4)}
.specimen-item{display:flex;flex-direction:column;gap:3px;min-width:0}
.specimen-meta{font-size:var(--fs-11);font-family:var(--mono);color:var(--text-4);
  display:flex;flex-wrap:wrap;gap:8px}
.specimen-text{margin:0;min-width:0;overflow-wrap:anywhere}

/* swatch grid (colour primitives at a glance) */
.ramp{display:flex;border-radius:var(--r-sm);overflow:hidden;border:1px solid var(--border-soft);height:26px}
.ramp-step{flex:1;min-width:0}
.ramp-empty{flex:1;background:repeating-linear-gradient(45deg,var(--surface-sunken),
  var(--surface-sunken) 4px,var(--surface) 4px,var(--surface) 8px)}

/* ══ EXPORT SUCCESS ══════════════════════════════════════════════════ */
.result{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:var(--s-2);
  margin-bottom:var(--s-4)}
.result-cell{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--r-md);
  padding:10px 12px}
.result-num{font-size:var(--fs-20);font-weight:650;color:var(--text);letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;line-height:1.15}
.result-label{font-size:var(--fs-11);color:var(--text-3);margin-top:2px}
.spinner{width:13px;height:13px;border-radius:var(--r-full);border:2px solid var(--border-strong);
  border-top-color:var(--text);animation:spin .6s linear infinite;flex:0 0 13px}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation-duration:1.6s}}
.skeleton{border-radius:var(--r-md);background:var(--surface-sunken);
  animation:pulse 1.4s var(--ease) infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}

/* ══ SAVE STATUS ═════════════════════════════════════════════════════ */
.save-status{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-12);
  color:var(--text-3);white-space:nowrap;font-variant-numeric:tabular-nums;position:relative}
.save-dot{width:6px;height:6px;border-radius:var(--r-full);background:var(--ok);flex:0 0 6px;
  transition:background-color var(--dur-2) var(--ease)}
.save-status[data-tone="saving"] .save-dot{background:var(--text-4);animation:pulse 1.1s var(--ease) infinite}
.save-status[data-tone="warn"]{color:var(--warn)}
.save-status[data-tone="warn"] .save-dot{background:var(--warn)}
@media(max-width:720px){.save-status{display:none}}

/* project name lives in the top bar so it is always editable */
.project-name{height:var(--control-h-sm);min-width:0;max-width:240px;flex:1 1 150px;
  background:transparent;border:1px solid transparent;border-radius:var(--r-sm);padding:0 8px;
  color:var(--text);font-family:inherit;font-size:var(--fs-13);font-weight:600;
  letter-spacing:var(--tracking-tight);outline:none;text-overflow:ellipsis;
  transition:background-color var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease)}
.project-name::placeholder{color:var(--text-4);font-weight:500}
.project-name:hover{background:var(--surface);border-color:var(--border)}
.project-name:focus{background:var(--surface);border-color:var(--accent);box-shadow:0 0 0 3px var(--focus-ring)}

/* ══ DROP TARGET ═════════════════════════════════════════════════════ */
.dropzone{position:fixed;inset:0;z-index:400;display:grid;place-items:center;
  background:var(--scrim);backdrop-filter:blur(2px);padding:var(--s-6);
  animation:fade var(--dur-2) var(--ease-out)}
.dropzone-inner{border:2px dashed var(--accent);border-radius:var(--r-xl);background:var(--surface);
  padding:var(--s-10) var(--s-12);text-align:center;box-shadow:var(--shadow-lg);max-width:420px}
.dropzone-title{font-size:var(--fs-16);font-weight:650;color:var(--text)}
.dropzone-desc{font-size:var(--fs-13);color:var(--text-3);margin-top:6px}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   7b. THEME SYSTEM
   Three preferences — light · dark · auto. `auto` follows prefers-color-scheme
   and reacts live to OS changes. The resolved theme is written to
   <html data-tp-theme>, which is the single switch every Tier-1 token reads.
   ═══════════════════════════════════════════════════════════════════════════ */

const THEME_KEY = "token-planner:theme";
const THEMES: Array<{ value: ThemePreference; label: string; glyph: string }> = [
  { value: "light", label: "Light", glyph: "☀" },
  { value: "dark", label: "Dark", glyph: "☾" },
  { value: "auto", label: "System", glyph: "◐" },
];

/** localStorage with an in-memory fallback for sandboxed / private contexts. */
const memoryStore: Record<string, string> = {};
const store = {
  get(key: string): string | null {
    try { const v = window.localStorage.getItem(key); if (v !== null) return v; } catch { /* blocked */ }
    return memoryStore[key] ?? null;
  },
  set(key: string, value: string): boolean {
    memoryStore[key] = value;
    try { window.localStorage.setItem(key, value); return true; } catch { return false; }
  },
  remove(key: string): void {
    delete memoryStore[key];
    try { window.localStorage.removeItem(key); } catch { /* blocked */ }
  },
  /** True when writes survive a reload — drives the "not persisted" warning. */
  available(): boolean {
    try {
      const probe = "token-planner:probe";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return true;
    } catch { return false; }
  },
};

const prefersDark = (): boolean => {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; }
  catch { return true; }
};

interface ThemeApi {
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
  resolved: ResolvedTheme;
}

function useTheme(): ThemeApi {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const saved = store.get(THEME_KEY);
    return THEMES.some((t) => t.value === saved) ? (saved as ThemePreference) : "auto";
  });
  const [systemDark, setSystemDark] = useState(prefersDark);

  /* live OS changes — only meaningful while preference is "auto" */
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia("(prefers-color-scheme: dark)"); } catch { return; }
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);

  const resolved = preference === "auto" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    try {
      document.documentElement.setAttribute("data-tp-theme", resolved);
      document.documentElement.style.colorScheme = resolved as ColorScheme;
    } catch { /* no DOM */ }
  }, [resolved]);

  const setPreference = useCallback((value: ThemePreference) => {
    setPreferenceState(value);
    store.set(THEME_KEY, value);
  }, []);

  return { preference, setPreference, resolved };
}

interface ThemeSwitchProps {
  preference: ThemePreference;
  onChange: (value: ThemePreference) => void;
}

function ThemeSwitch({ preference, onChange }: ThemeSwitchProps) {
  return (
    <div className="seg" role="group" aria-label="Colour theme">
      {THEMES.map((t) => (
        <button
          key={t.value}
          type="button"
          className="seg-btn"
          aria-pressed={preference === t.value}
          aria-label={`${t.label} theme`}
          data-tip={`${t.label} theme`}
          data-tip-below=""
          onClick={() => onChange(t.value)}
        >
          <span aria-hidden="true">{t.glyph}</span>
        </button>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   8. UI PRIMITIVES
   ═══════════════════════════════════════════════════════════════════════════ */

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "danger";
  size?: "sm";
}

function Button({ variant = "ghost", size, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", className)} {...rest} />;
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  danger?: boolean;
  tip?: string;
}

function IconButton({ label, danger, tip = label, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx("icon-btn", danger && "icon-btn-danger")}
      aria-label={label}
      data-tip={tip || undefined}
      {...rest}
    />
  );
}

let fieldSeq = 0;
const nextId = (): string => `f${++fieldSeq}`;

type FieldRenderProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: "true";
};

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  id?: string;
  children: ReactNode | ((props: FieldRenderProps) => ReactNode);
}

function Field({ label, hint, error, children, id }: FieldProps) {
  const ref = useRef(id || nextId());
  const fid = ref.current;
  const describedBy = cx(hint && `${fid}-hint`, error && `${fid}-err`) || undefined;
  return (
    <div className="field">
      {label && <label className="field-label" htmlFor={fid}>{label}</label>}
      {typeof children === "function"
        ? children({ id: fid, "aria-describedby": describedBy, "aria-invalid": error ? "true" : undefined })
        : children}
      {hint && !error && <span className="field-hint" id={`${fid}-hint`}>{hint}</span>}
      {error && <span className="field-error" id={`${fid}-err`} role="alert">⚠ {error}</span>}
    </div>
  );
}

/** Validated single-line input used inside dense grids and list rows. */
interface CellInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string | undefined;
  onChange: (value: string) => void;
  validate?: Validator;
  ariaLabel?: string;
  mono?: boolean;
}

function CellInput({ value, onChange, validate, ariaLabel, mono = true, ...rest }: CellInputProps) {
  const error = validate ? validate(value) : null;
  return (
    <div className="min0">
      <input
        className={cx("input", "input-sm", mono && "input-mono")}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        aria-invalid={error ? "true" : undefined}
        {...rest}
      />
      {error && <span className="field-error" role="alert">⚠ {error}</span>}
    </div>
  );
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  value: string | undefined;
  onChange: (value: string) => void;
  options: Array<Option | string>;
  placeholder?: string;
  ariaLabel?: string;
  small?: boolean;
}

function Select({ value, onChange, options, placeholder = "— select —", ariaLabel, small, ...rest }: SelectProps) {
  return (
    <select
      className={cx("input", small && "input-sm")}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      {...rest}
    >
      <option value="">{placeholder}</option>
      {options.map((o) =>
        typeof o === "string"
          ? <option key={o} value={o}>{o}</option>
          : <option key={o.value} value={o.value}>{o.label}</option>
      )}
    </select>
  );
}

interface CardProps {
  title?: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  flush?: boolean;
  children?: ReactNode;
}

function Card({ title, note, action, flush, children }: CardProps) {
  return (
    <section className={cx("card", flush && "card-flush")}>
      {(title || action) && (
        <header className={flush ? "card-head" : "card-head"} style={flush ? { padding: "14px 16px 0" } : undefined}>
          {title && <h3 className="card-title">{title}</h3>}
          {action}
        </header>
      )}
      {note && <p className="card-note" style={flush ? { padding: "0 16px" } : undefined}>{note}</p>}
      {children}
    </section>
  );
}

const Callout = ({ tone = "info", children }: { tone?: "info" | "warn" | "ok"; children: ReactNode }) => (
  <div className={`callout callout-${tone}`}>
    <span aria-hidden="true">{tone === "warn" ? "⚠" : tone === "ok" ? "✓" : "ℹ"}</span>
    <div>{children}</div>
  </div>
);

const EmptyState = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="empty">
    <div className="empty-title">{title}</div>
    {children && <div>{children}</div>}
  </div>
);

interface ColorInputProps {
  value: string | undefined;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  fallback?: string;
  onToast?: (message: string) => void;
}

function ColorInput({ value, onChange, ariaLabel, placeholder = "#7c3aed", fallback, onToast }: ColorInputProps) {
  const error = V.color(value);
  return (
    <div className="min0">
      <div className="color-pair">
        <input
          type="color"
          className="swatch-input"
          value={pickerValue(value, fallback)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${ariaLabel} colour picker`}
        />
        <input
          className="input input-mono grow"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error ? "true" : undefined}
          spellCheck="false"
          autoCapitalize="none"
        />
        <CopyButton value={value} label="Copy hex" onToast={onToast} disabled={!isColor(value)} />
      </div>
      {error && <span className="field-error" role="alert">⚠ {error}</span>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   9. COMPOSITE EDITORS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Responsive name/value list editor.
 * Desktop: three aligned columns. Mobile: name + actions on row 1, value below.
 */
interface NameValueEditorProps {
  items: TokenItem[] | undefined;
  onChange: (items: TokenItem[]) => void;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  valueLabel?: string;
  validateValue?: Validator;
  addLabel?: string;
  emptyTitle?: string;
  emptyHint?: string;
}

function NameValueEditor({
  items, onChange, namePlaceholder, valuePlaceholder, valueLabel = "Value",
  validateValue = V.none, addLabel = "Add token", emptyTitle = "No tokens yet",
  emptyHint = "Add a step, or leave this scale out of your system entirely.",
}: NameValueEditorProps) {
  const dupes = useMemo(() => duplicateIds(items), [items]);
  const update = useCallback((id, key, val) => onChange(listUpdate(items, id, key, val)), [items, onChange]);
  const remove = useCallback((id) => onChange(listRemove(items, id)), [items, onChange]);
  const move = useCallback((i, d) => onChange(listMove(items, i, d)), [items, onChange]);
  const add = useCallback(() => onChange(listAdd(items, { name: "", value: "" })), [items, onChange]);

  return (
    <>
      {!items?.length ? (
        <EmptyState title={emptyTitle}>{emptyHint}</EmptyState>
      ) : (
        <div role="group">
          <div className="nv-head" aria-hidden="true"><span>Name</span><span>{valueLabel}</span><span>Actions</span></div>
          {items.map((item, i) => (
            <div className="nv-row" key={item.id}>
              <div className="nv-name">
                <CellInput
                  value={item.name}
                  onChange={(v) => update(item.id, "name", v)}
                  validate={() => (dupes.has(item.id) ? "Duplicate name" : V.tokenName(item.name))}
                  ariaLabel={`Token name ${i + 1}`}
                  placeholder={namePlaceholder}
                />
              </div>
              <div className="nv-value">
                <CellInput
                  value={item.value}
                  onChange={(v) => update(item.id, "value", v)}
                  validate={validateValue}
                  ariaLabel={`${valueLabel} for ${item.name || `token ${i + 1}`}`}
                  placeholder={valuePlaceholder}
                />
              </div>
              <div className="nv-acts">
                <IconButton label={`Move ${item.name || "token"} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</IconButton>
                <IconButton label={`Move ${item.name || "token"} down`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</IconButton>
                <IconButton label={`Delete ${item.name || "token"}`} danger onClick={() => remove(item.id)}>🗑</IconButton>
              </div>
            </div>
          ))}
        </div>
      )}
      <Button size="sm" className="mt-3" onClick={add}>+ {addLabel}</Button>
    </>
  );
}

/**
 * Generic dynamic group editor used by every semantic tab.
 * Groups and roles can be added, renamed, reordered and deleted without limit.
 */
interface SemGroupEditorProps {
  groups: SemGroup[];
  onChange: (groups: SemGroup[]) => void;
  newRole: () => Omit<SemRole, "id">;
  renderMapping: (role: SemRole, patch: (key: string, value: string) => void) => ReactNode;
  roleNamePlaceholder?: string;
}

function SemGroupEditor({ groups, onChange, newRole, renderMapping, roleNamePlaceholder = "token/name" }: SemGroupEditorProps) {
  const setGroups = onChange;

  const addGroup = () => setGroups([...(groups || []), { id: uid(), name: "New group", roles: [] }]);
  const renameGroup = (gid, name) => setGroups(listUpdate(groups, gid, "name", name));
  const removeGroup = (gid) => setGroups(listRemove(groups, gid));
  const moveGroup = (i, d) => setGroups(listMove(groups, i, d));

  const patchRoles = (gid, fn) =>
    setGroups((groups || []).map((g) => (g.id === gid ? { ...g, roles: fn(g.roles || []) } : g)));

  return (
    <>
      {!groups?.length && (
        <EmptyState title="No groups yet">Groups organise semantic roles — Background, Text, Border. Create one to start mapping.</EmptyState>
      )}

      {(groups || []).map((g, gi) => {
        const dupes = duplicateIds(g.roles);
        return (
          <section className="group" key={g.id} aria-label={`Group ${g.name}`}>
            <header className="group-head">
              <input
                className="group-name"
                value={g.name ?? ""}
                onChange={(e) => renameGroup(g.id, e.target.value)}
                aria-label={`Group ${gi + 1} name`}
                placeholder="Group name"
              />
              <IconButton label={`Move group ${g.name} up`} disabled={gi === 0} onClick={() => moveGroup(gi, -1)}>↑</IconButton>
              <IconButton label={`Move group ${g.name} down`} disabled={gi === groups.length - 1} onClick={() => moveGroup(gi, 1)}>↓</IconButton>
              <IconButton label={`Delete group ${g.name}`} danger onClick={() => removeGroup(g.id)}>🗑</IconButton>
            </header>

            <div className="group-body">
              {!g.roles?.length && (
                <p className="field-hint" style={{ padding: "6px 2px" }}>
                  No roles in this group yet.
                </p>
              )}

              {(g.roles || []).map((r, ri) => (
                <div className="role" key={r.id}>
                  <div className="role-name">
                    <CellInput
                      value={r.name}
                      onChange={(v) => patchRoles(g.id, (roles) => listUpdate(roles, r.id, "name", v))}
                      validate={() => (dupes.has(r.id) ? "Duplicate name" : V.tokenName(r.name))}
                      ariaLabel={`Role name ${ri + 1} in ${g.name}`}
                      placeholder={roleNamePlaceholder}
                    />
                  </div>
                  <div className="role-map">
                    {renderMapping(r, (key, value) =>
                      patchRoles(g.id, (roles) => listUpdate(roles, r.id, key, value)))}
                  </div>
                  <div className="role-acts">
                    <IconButton label={`Move ${r.name || "role"} up`} disabled={ri === 0} onClick={() => patchRoles(g.id, (roles) => listMove(roles, ri, -1))}>↑</IconButton>
                    <IconButton label={`Move ${r.name || "role"} down`} disabled={ri === g.roles.length - 1} onClick={() => patchRoles(g.id, (roles) => listMove(roles, ri, 1))}>↓</IconButton>
                    <IconButton label={`Delete ${r.name || "role"}`} danger onClick={() => patchRoles(g.id, (roles) => listRemove(roles, r.id))}>🗑</IconButton>
                  </div>
                </div>
              ))}

              <Button size="sm" className="mt-3" onClick={() => patchRoles(g.id, (roles) => [...roles, { id: uid(), ...newRole() }])}>
                + Add role
              </Button>
            </div>
          </section>
        );
      })}

      <Button size="sm" onClick={addGroup}>+ Add group</Button>
    </>
  );
}

/** Tab list with proper ARIA roles. */
type TabOption<T extends string> = { label: string; value: T } | "or";

interface TabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Array<TabOption<T>>;
  size?: "sm";
  label: string;
}

/** Generic so each caller keeps its own union — no stringly-typed tabs. */
function Tabs<T extends string>({ value, onChange, options, size, label }: TabsProps<T>) {
  return (
    <div className={size === "sm" ? "tabs-sub" : "tabs"} role="tablist" aria-label={label}>
      {options.map((o) =>
        o === "or" ? (
          <span className="tab-or" key="or" aria-hidden="true">or</span>
        ) : (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={value === o.value}
            className={cx("tab", size === "sm" && "tab-sm")}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      )}
    </div>
  );
}

interface OutputBlockProps {
  label: string;
  text: string;
  filename: string;
  ext: "txt" | "json";
  onToast: (message: string) => void;
  meta?: string;
}

function OutputBlock({ label, text, filename, ext, onToast, meta }: OutputBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await writeClipboard(text);
    setCopied(ok);
    onToast(ok ? `${label} copied — ${text.length.toLocaleString()} characters` : "Copy failed — select the text manually");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  const download = () => {
    try {
      const blob = new Blob([text], { type: ext === "json" ? "application/json" : "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${filename}.${ext}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onToast(`Downloaded ${filename}.${ext}`);
    } catch { onToast("Download failed"); }
  };

  const lines = text.split("\n").length;
  return (
    <div className="out">
      <div className="out-head">
        <span className="out-label">
          {label} <span className="out-meta">· {lines.toLocaleString()} lines{meta ? ` · ${meta}` : ""}</span>
        </span>
        <div className="row-nowrap">
          <Button size="sm" onClick={copy} data-tip="Copy to clipboard">
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" variant="primary" onClick={download} data-tip={`Save as ${filename}.${ext}`}>
            Download
          </Button>
        </div>
      </div>
      <pre className="code" tabIndex={0} aria-label={`${label} output`}>{text}</pre>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   8b. PROJECT PERSISTENCE
   One versioned envelope covers three jobs: the autosave slot in localStorage,
   the "Export project" file, and the "Import project" reader. Because they
   share a shape, a file you exported months ago restores exactly like a session.

   Envelope
     { kind, version, projectName, createdAt, updatedAt, theme, wizard, data }

   `data` is the wizard document verbatim. Import never trusts it — every
   section is merged onto a fresh default so a truncated or hand-edited file
   degrades to defaults instead of throwing.
   ═══════════════════════════════════════════════════════════════════════════ */

const PROJECT_KEY = "token-planner:project";
const PROJECT_KIND = "token-planner-project";
const PROJECT_VERSION = 1;
const AUTOSAVE_DELAY = 1200;

const isPlainObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Re-attach ids after a round trip and drop anything that is not an object. */
const ensureIds = <T extends { id?: ID }>(list: unknown, fallback: T[] = [] as T[]): T[] => {
  if (!Array.isArray(list)) return fallback;
  return list.filter(isPlainObject).map((item) => ({ ...item, id: item.id || uid() })) as T[];
};

const ensureGroups = (groups: unknown, fallback: SemGroup[]): SemGroup[] => {
  if (!Array.isArray(groups)) return fallback;
  const clean: SemGroup[] = groups.filter(isPlainObject).map((g) => ({
    ...g,
    id: g.id || uid(),
    name: typeof g.name === "string" ? g.name : "Group",
    roles: ensureIds<SemRole>(g.roles),
  }));
  return clean.length || groups.length === 0 ? clean : fallback;
};

const ensureColorMap = <T,>(map: unknown, factory?: () => T[]): Record<string, T[]> => {
  if (!isPlainObject(map)) return {};
  const out: Record<string, any[]> = {};
  Object.entries(map).forEach(([brand, list]) => {
    out[brand] = Array.isArray(list)
      ? list.filter(isPlainObject).map((entry) => ({
          ...entry,
          id: entry.id || uid(),
          shades: entry.shades ? ensureIds(entry.shades) : undefined,
        }))
      : (factory ? factory() : []);
    if (out[brand].length && out[brand][0].shades === undefined)
      out[brand] = out[brand].map(({ shades, ...rest }) => rest);
  });
  return out;
};

/**
 * Merge an untrusted document onto a fresh default.
 * Never throws — anything unrecognised is simply replaced by its default.
 */
function normaliseDoc(raw: unknown): PlannerDoc {
  const base = initialState();
  if (!isPlainObject(raw)) return base;

  const project = isPlainObject(raw.project) ? raw.project : {};
  const brands = Array.isArray(project.brands) && project.brands.length
    ? project.brands.filter((b) => typeof b === "string").slice(0, 6)
    : base.project.brands;

  const doc = {
    ...base,
    project: {
      ...base.project,
      ...project,
      brands: brands.length ? brands : base.project.brands,
      serial: typeof project.serial === "string" && project.serial ? project.serial : base.project.serial,
    },
    colorMode: (raw.colorMode === "palette" ? "palette" : "base") as ColorMode,
    colorBase: ensureColorMap<BaseColor>(raw.colorBase),
    colorPalette: ensureColorMap<PaletteGroup>(raw.colorPalette),
    typography: isPlainObject(raw.typography)
      ? {
          ...base.typography,
          ...raw.typography,
          familyMode: (raw.typography.familyMode === "per-brand" ? "per-brand" : "universal") as TypographySection["familyMode"],
          universalFamilies: ensureIds<TokenItem>(raw.typography.universalFamilies, base.typography.universalFamilies),
          brandFamilies: isPlainObject(raw.typography.brandFamilies)
            ? Object.fromEntries(
                Object.entries(raw.typography.brandFamilies).map(([k, v]) => [k, ensureIds<TokenItem>(v)])
              ) as Record<string, TokenItem[]>
            : {},
          sizeScale: ensureIds<TokenItem>(raw.typography.sizeScale, base.typography.sizeScale),
          weightScale: ensureIds<TokenItem>(raw.typography.weightScale, base.typography.weightScale),
          lineHeightScale: ensureIds<TokenItem>(raw.typography.lineHeightScale, base.typography.lineHeightScale),
          trackingScale: ensureIds<TokenItem>(raw.typography.trackingScale, base.typography.trackingScale),
        }
      : base.typography,
    scale: isPlainObject(raw.scale)
      ? {
          baseUnit: Number(raw.scale.baseUnit) === 8 ? 8 : 4,
          scale: ensureIds<TokenItem>(raw.scale.scale, base.scale.scale),
          borderRadius: ensureIds<TokenItem>(raw.scale.borderRadius, base.scale.borderRadius),
          borderWidths: ensureIds<TokenItem>(raw.scale.borderWidths, base.scale.borderWidths),
        }
      : base.scale,
    effects: isPlainObject(raw.effects)
      ? {
          shadows: ensureIds<ShadowItem>(raw.effects.shadows, base.effects.shadows),
          blurs: ensureIds<TokenItem>(raw.effects.blurs, base.effects.blurs),
          opacity: ensureIds<TokenItem>(raw.effects.opacity, base.effects.opacity),
          semantic: isPlainObject(raw.effects.semantic)
            ? {
                shadowRoles: ensureIds<SemRole>(raw.effects.semantic.shadowRoles),
                blurRoles: ensureIds<SemRole>(raw.effects.semantic.blurRoles),
                opacityRoles: ensureIds<SemRole>(raw.effects.semantic.opacityRoles),
              }
            : base.effects.semantic,
        }
      : base.effects,
    motion: isPlainObject(raw.motion)
      ? {
          durations: ensureIds<TokenItem>(raw.motion.durations, base.motion.durations),
          easings: ensureIds<TokenItem>(raw.motion.easings, base.motion.easings),
          semantic: isPlainObject(raw.motion.semantic)
            ? {
                durationRoles: ensureIds<SemRole>(raw.motion.semantic.durationRoles),
                easingRoles: ensureIds<SemRole>(raw.motion.semantic.easingRoles),
                transitions: ensureIds<SemRole>(raw.motion.semantic.transitions),
              }
            : base.motion.semantic,
        }
      : base.motion,
    semColorGroups: ensureGroups(raw.semColorGroups, base.semColorGroups),
    semTypoGroups: ensureGroups(raw.semTypoGroups, base.semTypoGroups),
    semScaleGroups: ensureGroups(raw.semScaleGroups, base.semScaleGroups),
    zIndex: ensureIds<TokenItem>(raw.zIndex, base.zIndex),
    components: Array.isArray(raw.components)
      ? raw.components.filter(isPlainObject).map((c) => ({
          id: c.id || uid(),
          name: typeof c.name === "string" ? c.name : "Component",
          tokens: ensureIds<TokenItem>(c.tokens),
        }))
      : [],
  };

  /* every brand must own a colour bucket, even if the file omitted one */
  doc.project.brands.forEach((b) => {
    if (!Array.isArray(doc.colorBase[b])) doc.colorBase[b] = mkBaseColors();
    if (!Array.isArray(doc.colorPalette[b])) doc.colorPalette[b] = mkPaletteGroups();
  });
  return doc;
}

/** Wrap the live wizard state in the portable envelope. */
interface SerialiseOptions {
  theme?: ThemePreference;
  step?: number;
  stepStatus?: StepStatusMap;
  createdAt?: string | null;
}

function serialiseProject(
  doc: PlannerDoc,
  { theme, step, stepStatus, createdAt }: SerialiseOptions = {}
): ProjectEnvelope {
  const now = new Date().toISOString();
  return {
    kind: PROJECT_KIND,
    version: PROJECT_VERSION,
    projectName: doc?.project?.name || "Untitled project",
    createdAt: createdAt || now,
    updatedAt: now,
    theme: theme || "auto",
    wizard: { step: step || 1, status: stepStatus || {} },
    data: doc,
  };
}

/** Parse + validate an untrusted string. Returns `{ ok, payload | error }`. */
function readProjectFile(text: string): ReadResult {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { ok: false, error: "That file isn't valid JSON. It may be corrupted or incomplete." }; }

  if (!isPlainObject(parsed))
    return { ok: false, error: "That file doesn't contain a project object." };

  if (parsed.kind && parsed.kind !== PROJECT_KIND)
    return {
      ok: false,
      error: "That looks like a design-token export, not a project file. Import the file saved by “Export project”.",
    };

  if (!parsed.kind && !isPlainObject(parsed.data))
    return {
      ok: false,
      error: "This file isn't a Token Planner project. Choose a file exported with “Export project”.",
    };

  const version = Number(parsed.version) || 1;
  if (version > PROJECT_VERSION)
    return {
      ok: false,
      error: `This project was saved by a newer version (v${version}). Update the planner, then try again.`,
    };

  return {
    ok: true,
    payload: {
      doc: normaliseDoc(parsed.data),
      theme: THEMES.some((t) => t.value === parsed.theme) ? (parsed.theme as ThemePreference) : null,
      step: Number(parsed.wizard?.step) || 1,
      stepStatus: isPlainObject(parsed.wizard?.status) ? parsed.wizard.status : null,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
      projectName: parsed.projectName,
    },
  };
}

/** Read whatever is in the autosave slot, or null. */
function loadSavedProject(): RestorePayload | null {
  const raw = store.get(PROJECT_KEY);
  if (!raw) return null;
  const result = readProjectFile(raw);
  return result.ok ? result.payload : null;
}

const relativeTime = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/** Subtle "Saving… / Saved 2 min ago" readout. */
interface SaveStatusProps {
  status: "saving" | "saved" | "error";
  savedAt: string | null;
  persistent: boolean;
}

function SaveStatus({ status, savedAt, persistent }: SaveStatusProps) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (status !== "saved") return undefined;
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, [status, savedAt]);

  if (!persistent)
    return (
      <span className="save-status" data-tone="warn" data-tip="This browser blocks storage — export your project to keep it" data-tip-below="">
        <span className="save-dot" aria-hidden="true" />
        Not saved
      </span>
    );

  const label =
    status === "saving" ? "Saving…"
    : status === "error" ? "Save failed"
    : savedAt ? `Saved ${relativeTime(savedAt)}`
    : "Saved";

  return (
    <span className="save-status" data-tone={status === "error" ? "warn" : status} role="status" aria-live="polite">
      <span className="save-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Accessible confirm dialog — Escape closes, focus lands inside. */
interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  tone = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="cf-title"
           aria-describedby="cf-body" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title" id="cf-title">{title}</h2>
        <p className="modal-desc" id="cf-body">{body}</p>
        <div className="spread">
          <Button size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Project file actions. Rendered in two places with different framing, so the
 * two kinds of export never get confused for one another.
 */
interface ProjectFileActionsProps {
  onExport: () => void;
  onImportFile: (file: File) => void;
  onReset?: () => void;
  compact?: boolean;
}

function ProjectFileActions({ onExport, onImportFile, onReset, compact }: ProjectFileActionsProps) {
  const inputRef = useRef(null);
  return (
    <>
      <div className={cx("row", compact && "row-nowrap")}>
        <Button size="sm" onClick={onExport} data-tip="Save a .json you can re-open later">
          Export project
        </Button>
        <Button size="sm" onClick={() => inputRef.current?.click()} data-tip="Open a previously exported project">
          Import project
        </Button>
        {onReset && (
          <Button size="sm" variant="danger" onClick={onReset} data-tip="Clear this project and start over">
            Reset
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Choose a Token Planner project file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onImportFile(file);
        }}
      />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   9b. LIVE PREVIEW
   Preview-only helpers. They read the same state the generators read but never
   feed back into them — resolving a reference here cannot change an export.

   In Colour Palette mode every shade already has a hex, so resolution is a
   lookup. In Colour Base mode the shades do not exist yet, so we synthesise a
   plausible ramp from the base hue purely so the preview has something to show.
   ═══════════════════════════════════════════════════════════════════════════ */

/** `{ "primary/500": "#7c3aed", … }` for whichever colour method is active. */
function buildColorIndex(
  colorMode: ColorMode,
  colorBase: Record<string, BaseColor[]>,
  colorPalette: Record<string, PaletteGroup[]>,
  brand: string
): ColorIndex {
  const index: ColorIndex = {};
  if (colorMode === "palette") {
    (colorPalette[brand] || []).forEach((group) => {
      if (!group.name) return;
      group.shades.forEach((shade) => {
        if (isColor(shade.hex) && shade.shade)
          index[`${slugify(group.name)}/${slugify(shade.shade)}`] = shade.hex.trim();
      });
    });
    return index;
  }
  (colorBase[brand] || []).forEach((c) => {
    if (!isColor(c.hex) || !c.name) return;
    const name = slugify(c.name);
    const base = hexToHSL(c.hex);
    index[`${name}/base`] = c.hex.trim();
    if (c.type === "transparency") {
      TRANSPARENCY_STEPS.forEach((step) => {
        index[`${name}/${step}`] = `hsl(${base.h} ${base.s}% ${base.l}% / ${step}%)`;
      });
    } else {
      shadeSteps(Number(c.shadeCount) || 9).forEach((step) => {
        index[`${name}/${step}`] = synthShade(base, step);
      });
    }
  });
  return index;
}

/** `{primary/500}` → a paintable CSS colour, or null when unresolved. */
function resolveColor(ref: string | undefined, index: ColorIndex): string | null {
  if (blank(ref)) return null;
  const raw = String(ref).trim();
  if (raw === "transparent") return "transparent";
  if (isColor(raw)) return raw;
  const path = raw.replace(/^\{|\}$/g, "").replace(/\./g, "/");
  return index[path] || index[slugify(path)] || null;
}

/** Flatten dynamic semantic groups into `{ "text/primary": "#…" }`. */
function resolveSemanticColors(
  groups: SemGroup[],
  mode: ResolvedTheme,
  index: ColorIndex
): Record<string, string> {
  const out: Record<string, string> = {};
  (groups || []).forEach((g) =>
    g.roles.forEach((r) => {
      if (!r.name) return;
      const hit = resolveColor(r[`${mode}Ref`], index);
      if (hit) out[slugify(r.name)] = hit;
    }));
  return out;
}

/** First role that resolves, so previews survive renamed/deleted roles. */
const pickRole = (map: Record<string, string>, candidates: string[], fallback: string): string => {
  for (const key of candidates) if (map[key]) return map[key];
  return fallback;
};

/** Typography reference → concrete CSS value. */
type TypeIndex = Record<"family" | "size" | "weight" | "lineHeight" | "tracking", Record<string, string>>;

function buildTypeIndex(typography: TypographySection): TypeIndex {
  const idx: TypeIndex = { family: {}, size: {}, weight: {}, lineHeight: {}, tracking: {} };
  const add = (bucket: keyof TypeIndex, list: TokenItem[] | undefined, transform: (v: string) => string = (v) => v) =>
    (list || []).forEach((t) => { if (t.name && !blank(t.value)) idx[bucket][slugify(t.name)] = transform(t.value); });

  const families = typography.familyMode === "universal"
    ? typography.universalFamilies
    : Object.values(typography.brandFamilies || {}).flat();
  add("family", families);
  add("size", typography.sizeScale);
  add("weight", typography.weightScale);
  add("lineHeight", typography.lineHeightScale);
  add("tracking", typography.trackingScale, (v) => `${Number(v) / 100}em`);
  return idx;
}

function resolveType(ref: string | undefined, bucket: keyof TypeIndex, idx: TypeIndex): string | null {
  if (blank(ref)) return null;
  const path = String(ref).replace(/^\{|\}$/g, "").split(/[./]/);
  return idx[bucket][slugify(path[path.length - 1])] || null;
}

/** Build a React style object for one semantic text role. */
function roleTextStyle(role: SemRole | undefined, idx: TypeIndex): CSSProperties | null {
  if (!role) return null;
  const style: CSSProperties = {};
  const family = resolveType(role.family, "family", idx);
  const size = resolveType(role.size, "size", idx);
  const weight = resolveType(role.weight, "weight", idx);
  const line = resolveType(role.lineHeight, "lineHeight", idx);
  const track = resolveType(role.tracking, "tracking", idx);
  if (family) style.fontFamily = family;
  if (size) style.fontSize = size;
  if (weight) style.fontWeight = weight;
  if (line) style.lineHeight = line;
  if (track) style.letterSpacing = track;
  return Object.keys(style).length ? style : null;
}

/* ── clipboard, shared by every copy affordance ─────────────────────────── */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/** Small copy affordance with its own transient ✓ state. */
interface CopyButtonProps {
  value: string | undefined;
  label?: string;
  onToast?: (message: string) => void;
  disabled?: boolean;
}

function CopyButton({ value, label = "Copy", onToast, disabled }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = async () => {
    if (disabled || blank(value)) return;
    const ok = await writeClipboard(String(value));
    setCopied(ok);
    onToast?.(ok ? `Copied ${value}` : "Copy failed — select the text manually");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      type="button"
      className="copy-btn"
      data-copied={copied ? "true" : undefined}
      data-tip={copied ? "Copied" : label}
      aria-label={`${label} ${value || ""}`.trim()}
      disabled={disabled || blank(value)}
      onClick={run}
    >
      <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
    </button>
  );
}

/* ── component preview ──────────────────────────────────────────────────── */

const PREVIEW_ROLES: Record<string, string[]> = {
  bg:        ["background/default", "background/base", "surface/default", "bg/default"],
  bgSubtle:  ["background/subtle", "surface/subtle", "bg/subtle"],
  text:      ["text/primary", "text/default", "fg/primary"],
  textMuted: ["text/secondary", "text/muted", "fg/secondary"],
  onBrand:   ["text/on-brand", "text/inverse", "fg/on-accent"],
  border:    ["border/default", "border/base"],
  borderFocus: ["border/focus", "interactive/primary"],
  primary:   ["interactive/primary", "background/brand", "action/primary"],
  primaryHover: ["interactive/primary-hover", "interactive/primary"],
  secondary: ["interactive/secondary", "background/subtle"],
  info:      ["feedback/info", "interactive/primary"],
  infoSubtle:["feedback/info-subtle", "background/subtle"],
  success:   ["feedback/success", "interactive/primary"],
};

/**
 * Renders seven common components using ONLY the user's resolved semantic
 * colours. Falls back to inheriting app tokens for anything unmapped so the
 * preview degrades gracefully instead of turning invisible.
 */
interface ComponentPreviewProps {
  semanticColors: Record<string, string>;
  radius?: string;
  typeStyle?: CSSProperties;
  mode: ResolvedTheme;
}

function ComponentPreview({ semanticColors, radius, typeStyle, mode }: ComponentPreviewProps) {
  const c = semanticColors;
  const has = Object.keys(c).length > 0;
  const get = (key, fallback) => pickRole(c, PREVIEW_ROLES[key], fallback);

  if (!has) {
    return (
      <div className="preview">
        <div className="preview-head">
          <span className="preview-title">Live preview</span>
        </div>
        <p className="preview-note">
          Map a few semantic colours and the components below will paint themselves with your tokens.
        </p>
      </div>
    );
  }

  const bg = get("bg", "transparent");
  const surface = get("bgSubtle", bg);
  const text = get("text", "inherit");
  const muted = get("textMuted", text);
  const border = get("border", "currentColor");
  const primary = get("primary", text);
  const onBrand = get("onBrand", bg);
  const secondary = get("secondary", surface);
  const info = get("info", primary);
  const infoBg = get("infoSubtle", surface);
  const r = radius || "8px";
  const base = { ...(typeStyle || {}), color: text };

  const btn = {
    borderRadius: r, padding: "0 14px", height: 34, fontSize: 13, fontWeight: 550,
    border: "1px solid transparent", cursor: "default", fontFamily: "inherit",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };

  return (
    <div className="preview">
      <div className="preview-head">
        <span className="preview-title">
          <span className="preview-live" aria-hidden="true" />
          Live preview
        </span>
        <span className="preview-hint">{mode === "dark" ? "Dark mode" : "Light mode"} · your tokens</span>
      </div>

      <div className="preview-canvas" style={{ background: bg, ...base }}>
        <div>
          <div className="preview-group-label" style={{ color: muted }}>Buttons</div>
          <div className="preview-row">
            <span style={{ ...btn, background: primary, color: onBrand }}>Primary</span>
            <span style={{ ...btn, background: secondary, color: text }}>Secondary</span>
            <span style={{ ...btn, background: "transparent", color: primary, borderColor: "transparent" }}>Ghost</span>
            <span style={{ ...btn, background: secondary, color: muted, opacity: 0.55 }}>Disabled</span>
          </div>
        </div>

        <div>
          <div className="preview-group-label" style={{ color: muted }}>Input</div>
          <div
            style={{
              height: 34, borderRadius: r, border: `1px solid ${border}`, background: surface,
              display: "flex", alignItems: "center", padding: "0 11px", fontSize: 13, color: muted,
              maxWidth: 300,
            }}
          >
            Placeholder text
          </div>
        </div>

        <div>
          <div className="preview-group-label" style={{ color: muted }}>Card</div>
          <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: r, padding: 14, maxWidth: 340 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Card title</div>
            <div style={{ fontSize: 13, color: muted, lineHeight: 1.5 }}>
              Supporting copy rendered with your semantic text colours.
            </div>
          </div>
        </div>

        <div>
          <div className="preview-group-label" style={{ color: muted }}>Badge &amp; alert</div>
          <div className="preview-row" style={{ marginBottom: 10 }}>
            <span style={{ background: infoBg, color: info, borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600 }}>
              Badge
            </span>
            <span style={{ background: secondary, color: muted, borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600 }}>
              Neutral
            </span>
          </div>
          <div
            style={{
              background: infoBg, border: `1px solid ${info}`, borderRadius: r,
              padding: "10px 12px", fontSize: 13, maxWidth: 380, color: text,
            }}
          >
            <strong style={{ color: info, fontWeight: 600 }}>Heads up · </strong>
            An alert built from your feedback tokens.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── typography specimen ────────────────────────────────────────────────── */

interface SpecimenSlot {
  key: string;
  label: string;
  candidates: string[];
  text: string;
  fallback: CSSProperties;
}

const SPECIMEN_SLOTS: SpecimenSlot[] = [
  { key: "heading", label: "Heading", candidates: ["heading/1", "display/lg", "heading/2"], text: "The quick brown fox", fallback: { fontSize: 28, fontWeight: 650, lineHeight: 1.2 } },
  { key: "subheading", label: "Subheading", candidates: ["heading/3", "heading/4", "display/xl"], text: "Jumps over the lazy dog", fallback: { fontSize: 19, fontWeight: 600, lineHeight: 1.3 } },
  { key: "body", label: "Body", candidates: ["body/md", "body/lg", "body/sm"], text: "Design tokens keep every decision in one place, so a change made once reaches every surface that references it.", fallback: { fontSize: 15, fontWeight: 400, lineHeight: 1.55 } },
  { key: "caption", label: "Caption", candidates: ["caption", "label/sm", "overline"], text: "Last updated moments ago", fallback: { fontSize: 12, fontWeight: 500, lineHeight: 1.4 } },
];

interface TypePreviewProps {
  semTypoGroups: SemGroup[];
  typography: TypographySection;
  sampleText?: string;
}

function TypePreview({ semTypoGroups, typography, sampleText }: TypePreviewProps) {
  const idx = useMemo(() => buildTypeIndex(typography), [typography]);
  const roleByName = useMemo(() => {
    const map: Record<string, SemRole> = {};
    (semTypoGroups || []).forEach((g) => g.roles.forEach((r) => { if (r.name) map[slugify(r.name)] = r; }));
    return map;
  }, [semTypoGroups]);

  const slots = SPECIMEN_SLOTS.map((slot) => {
    const role = slot.candidates.map((n) => roleByName[n]).find(Boolean);
    const style = roleTextStyle(role, idx);
    const parts: string[] = [];
    if (style?.fontFamily) parts.push(String(style.fontFamily).split(",")[0].trim());
    if (style?.fontSize) parts.push(String(style.fontSize));
    if (style?.fontWeight) parts.push(`w${style.fontWeight}`);
    if (style?.lineHeight) parts.push(`lh ${style.lineHeight}`);
    if (style?.letterSpacing) parts.push(String(style.letterSpacing));
    return { ...slot, role, style, meta: parts };
  });

  const anyMapped = slots.some((s) => s.style);

  return (
    <div className="preview">
      <div className="preview-head">
        <span className="preview-title">
          <span className="preview-live" aria-hidden="true" />
          Type specimen
        </span>
        <span className="preview-hint">{anyMapped ? "Rendering your scales" : "Showing defaults"}</span>
      </div>
      <div className="preview-canvas">
        <div className="specimen">
          {slots.map((slot) => (
            <div className="specimen-item" key={slot.key}>
              <div className="specimen-meta">
                <span>{slot.role?.name || slot.label}</span>
                {slot.meta.map((m) => <span key={m}>{m}</span>)}
                {!slot.style && <span>unmapped — showing a default</span>}
                {slot.style && slot.meta.length < 4 && <span>defaults fill the rest</span>}
              </div>
              <p className="specimen-text" style={{ ...slot.fallback, ...(slot.style || {}) }}>
                {sampleText || slot.text}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Compact ramp strip shown beside each colour in the primitives tab. */
function RampStrip({ colours }: { colours?: string[] }) {
  if (!colours?.length) return <div className="ramp"><div className="ramp-empty" /></div>;
  return (
    <div className="ramp" aria-hidden="true">
      {colours.map((c, i) => <div className="ramp-step" key={i} style={{ background: c }} />)}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   10. STEPS
   ═══════════════════════════════════════════════════════════════════════════ */

const PageHead = ({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) => (
  <header className="page-head">
    {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
    <h2 className="page-title">{title}</h2>
    {children && <p className="page-desc">{children}</p>}
  </header>
);

/* ── Step 1 · Project ───────────────────────────────────────────────────── */
interface StepProjectProps {
  data: ProjectMeta;
  onChange: (next: ProjectMeta) => void;
  onExportProject: () => void;
  onImportFile: (file: File) => void;
  onResetProject: () => void;
}

function StepProject({ data, onChange, onExportProject, onImportFile, onResetProject }: StepProjectProps) {
  const set = (key: keyof ProjectMeta) => (value: unknown) => onChange({ ...data, [key]: value } as ProjectMeta);
  const brands = data.brands || [];
  const dupBrand = brands.some((b, i) => brands.findIndex((x) => slugify(x) === slugify(b)) !== i);

  const setBrand = (i: number, v: string) => { const next = [...brands]; next[i] = v; onChange({ ...data, brands: next }); };
  const addBrand = () => brands.length < 6 &&
    onChange({ ...data, brands: [...brands, `Brand ${String.fromCharCode(65 + brands.length)}`] });
  const delBrand = (i: number) => brands.length > 1 &&
    onChange({ ...data, brands: brands.filter((_, x) => x !== i) });

  return (
    <>
      <PageHead eyebrow="Setup" title="Project details">
        Names and preferences that shape the exported prompt. Nothing here is locked — you can return at any time.
      </PageHead>

      <Card title="Identity">
        <div className="grid-2">
          <Field label="Project name" hint="Also shown in the top bar and used for both export filenames.">
            {(p) => <input className="input" value={data.name ?? ""} onChange={(e) => set("name")(e.target.value)} placeholder="e.g. Bolt App" {...p} />}
          </Field>
          <Field label="Design system name">
            {(p) => <input className="input" value={data.systemName ?? ""} onChange={(e) => set("systemName")(e.target.value)} placeholder="e.g. Bolt DS" {...p} />}
          </Field>
          <Field label="Version">
            {(p) => <input className="input" value={data.version ?? ""} onChange={(e) => set("version")(e.target.value)} placeholder="v1.0.0" {...p} />}
          </Field>
          <Field label="Reviewer">
            {(p) => <input className="input" value={data.reviewer ?? ""} onChange={(e) => set("reviewer")(e.target.value)} placeholder="Reviewer name" {...p} />}
          </Field>
          <Field label="Status">
            {(p) => (
              <select className="input" value={data.status} onChange={(e) => set("status")(e.target.value)} {...p}>
                <option>Draft</option><option>In Review</option><option>Approved</option>
              </select>
            )}
          </Field>
          <Field label="Serial number" hint="Generated automatically for each new project.">
            {(p) => <input className="input input-mono" value={data.serial} readOnly {...p} />}
          </Field>
        </div>
      </Card>

      <Card
        title="Project file"
        note="Your work saves to this browser automatically. Export a project file to move it to another machine, share it with a teammate, or keep a checkpoint."
      >
        <ProjectFileActions onExport={onExportProject} onImportFile={onImportFile} onReset={onResetProject} />
      </Card>

      <Card
        title="Brands & themes"
        note="Each brand becomes one mode inside the Primitives collection. Semantic Light/Dark mappings stay shared across all brands, so switching brand recolours the whole UI."
      >
        {dupBrand && <Callout tone="warn">Two brands share the same name — rename one so the exported modes stay distinct.</Callout>}
        <div className="stack">
          {brands.map((b, i) => (
            <div className="row-nowrap" key={i}>
              <input
                className="input grow"
                value={b}
                onChange={(e) => setBrand(i, e.target.value)}
                aria-label={`Brand ${i + 1} name`}
                placeholder={`Brand ${i + 1}`}
              />
              <IconButton label={`Remove brand ${b}`} danger disabled={brands.length <= 1} onClick={() => delBrand(i)}>🗑</IconButton>
            </div>
          ))}
        </div>
        <Button size="sm" className="mt-3" onClick={addBrand} disabled={brands.length >= 6}>
          + Add brand {brands.length >= 6 && "(max 6)"}
        </Button>
      </Card>

      <Card title="Planner preferences">
        <div className="grid-2">
          <Field label="Semantic mapping" hint="Auto suggests mappings from colour lightness; manual gives you dropdowns.">
            {(p) => (
              <select className="input" value={data.mappingPref} onChange={(e) => set("mappingPref")(e.target.value)} {...p}>
                <option value="auto">Auto — suggest from palette</option>
                <option value="manual">Manual — choose each token</option>
              </select>
            )}
          </Field>
          <Field label="Export format" hint="You can change this before exporting.">
            {(p) => (
              <select className="input" value={data.exportFormat} onChange={(e) => set("exportFormat")(e.target.value)} {...p}>
                <option value="both">Both — prompt + JSON</option>
                <option value="prompt">AI prompt only</option>
                <option value="json">Token Studio JSON only</option>
              </select>
            )}
          </Field>
        </div>
      </Card>
    </>
  );
}

/* ── Step 2 · Colour ────────────────────────────────────────────────────── */
type Setter<T> = (next: T | ((prev: T) => T)) => void;

interface StepColorProps {
  colorMode: ColorMode;
  setColorMode: Setter<ColorMode>;
  colorBase: Record<string, BaseColor[]>;
  setColorBase: Setter<Record<string, BaseColor[]>>;
  colorPalette: Record<string, PaletteGroup[]>;
  setColorPalette: Setter<Record<string, PaletteGroup[]>>;
  semColorGroups: SemGroup[];
  setSemColorGroups: Setter<SemGroup[]>;
  brands: string[];
  mappingPref: MappingPreference;
  onToast: (message: string) => void;
}

function StepColor({
  colorMode, setColorMode, colorBase, setColorBase, colorPalette, setColorPalette,
  semColorGroups, setSemColorGroups, brands, mappingPref, onToast,
}: StepColorProps) {
  const [tab, setTab] = useState("primitives");
  const [mode, setMode] = useState<ResolvedTheme>("light");
  const [brand, setBrand] = useState(brands[0] || "Brand A");

  useEffect(() => { if (!brands.includes(brand)) setBrand(brands[0] || "Brand A"); }, [brands, brand]);

  /* base colours */
  const baseList = colorBase[brand] || [];
  const baseDupes = useMemo(() => duplicateIds(baseList), [baseList]);
  const patchBase = (fn: (list: BaseColor[]) => BaseColor[]) =>
    setColorBase((prev) => ({ ...prev, [brand]: fn(prev[brand] || []) }));

  /* palettes */
  const paletteList = colorPalette[brand] || [];
  const paletteDupes = useMemo(() => duplicateIds(paletteList), [paletteList]);
  const patchPalette = (fn: (list: PaletteGroup[]) => PaletteGroup[]) =>
    setColorPalette((prev) => ({ ...prev, [brand]: fn(prev[brand] || []) }));

  /* preview-only resolution of the current palette */
  const colorIndex = useMemo(
    () => buildColorIndex(colorMode, colorBase, colorPalette, brand),
    [colorMode, colorBase, colorPalette, brand]
  );
  const previewColors = useMemo(
    () => resolveSemanticColors(semColorGroups, mode, colorIndex),
    [semColorGroups, mode, colorIndex]
  );

  /* available token paths for mapping */
  const tokenPaths = useMemo<TokenPath[]>(() => {
    if (colorMode === "palette") {
      const out: TokenPath[] = [];
      (colorPalette[brand] || []).forEach((p) =>
        p.shades.forEach((s) => {
          if (isColor(s.hex) && p.name && s.shade) out.push({ path: `${slugify(p.name)}/${slugify(s.shade)}`, hex: s.hex });
        }));
      return out;
    }
    return predictedPaths(colorBase[brand] || []);
  }, [colorMode, colorBase, colorPalette, brand]);

  const mapOptions = useMemo(
    () => [...tokenPaths.map(({ path }) => ({ value: `{${path}}`, label: `{${path}}` })), { value: "transparent", label: "transparent" }],
    [tokenPaths]
  );

  const runAutoMap = () => {
    if (!tokenPaths.length) return;
    setSemColorGroups(autoMapSemanticColors(tokenPaths, semColorGroups));
    onToast("Light and dark mappings suggested from your palette");
  };

  const mappedCount = useMemo(
    () => (semColorGroups || []).reduce((n, g) => n + g.roles.filter((r) => !blank(r[`${mode}Ref`])).length, 0),
    [semColorGroups, mode]
  );
  const totalRoles = useMemo(
    () => (semColorGroups || []).reduce((n, g) => n + g.roles.length, 0),
    [semColorGroups]
  );

  const renderMapping = (role: SemRole, patch: (key: string, value: string) => void) => (
    <>
      <span className="arrow" aria-hidden="true">→</span>
      {mappingPref === "manual" ? (
        <Select
          small
          ariaLabel={`Map ${role.name} in ${mode} mode`}
          value={role[`${mode}Ref`]}
          onChange={(v) => patch(`${mode}Ref`, v)}
          options={mapOptions}
          placeholder="— choose token —"
        />
      ) : (
        <span className={cx("mapped", blank(role[`${mode}Ref`]) && "mapped-empty")}>
          {blank(role[`${mode}Ref`]) ? "not mapped" : role[`${mode}Ref`]}
        </span>
      )}
    </>
  );

  return (
    <>
      <PageHead eyebrow="Foundations · Step 2 of 10" title="Colour">
        Define your colour primitives, then map them to semantic roles for light and dark mode.
      </PageHead>

      <Tabs
        label="Colour section"
        value={tab}
        onChange={setTab}
        options={[{ value: "primitives", label: "Primitives" }, { value: "semantic", label: "Semantic" }]}
      />

      {tab === "primitives" && (
        <>
          <Tabs<ColorMode>
            size="sm"
            label="Colour primitive method"
            value={colorMode}
            onChange={setColorMode}
            options={[{ value: "base", label: "Colour Base" }, "or", { value: "palette", label: "Colour Palette" }]}
          />
          <Callout>
            {colorMode === "base"
              ? <><b>Colour Base</b> — you supply one hex per colour and the exported prompt asks Figma to generate the shade scale. Only the active tab is exported.</>
              : <><b>Colour Palette</b> — you supply an exact hex for every shade. Only the active tab is exported.</>}
          </Callout>

          {brands.length > 1 && (
            <div className="chips" role="group" aria-label="Select brand">
              {brands.map((b) => (
                <button key={b} type="button" className="chip" aria-pressed={brand === b} onClick={() => setBrand(b)}>{b}</button>
              ))}
            </div>
          )}

          {colorMode === "base" && (
            <>
              {!baseList.length && <EmptyState title="No colours yet">Add a base colour and the shade ramp will preview instantly beneath it.</EmptyState>}
              {baseList.map((c, i) => (
                <Card key={c.id}>
                  <div className="card-head">
                    <input
                      className="input grow input-title"
                      value={c.name ?? ""}
                      onChange={(e) => patchBase((l) => listUpdate(l, c.id, "name", e.target.value))}
                      aria-label={`Colour ${i + 1} name`}
                      placeholder="Colour name"
                      aria-invalid={baseDupes.has(c.id) ? "true" : undefined}
                    />
                    <div className="row-nowrap">
                      <IconButton label="Move up" disabled={i === 0} onClick={() => patchBase((l) => listMove(l, i, -1))}>↑</IconButton>
                      <IconButton label="Move down" disabled={i === baseList.length - 1} onClick={() => patchBase((l) => listMove(l, i, 1))}>↓</IconButton>
                      <IconButton label={`Delete ${c.name}`} danger onClick={() => patchBase((l) => listRemove(l, c.id))}>🗑</IconButton>
                    </div>
                  </div>
                  {baseDupes.has(c.id) && <Callout tone="warn">Another colour uses this name — token paths would collide.</Callout>}

                  <div className="grid-2">
                    <Field label="Base colour" hint="Hex, 8-digit hex or rgba() for transparency.">
                      <ColorInput
                        value={c.hex}
                        onChange={(v) => patchBase((l) => listUpdate(l, c.id, "hex", v))}
                        ariaLabel={`${c.name} hex value`}
                        onToast={onToast}
                      />
                    </Field>
                    <Field label="Scale type" hint={c.type === "transparency" ? "Generates 10%–90% opacity steps." : "Generates numbered shade steps."}>
                      {(p) => (
                        <select className="input" value={c.type} onChange={(e) => patchBase((l) => listUpdate(l, c.id, "type", e.target.value))} {...p}>
                          <option value="shades">Shades</option>
                          <option value="transparency">Transparency scale</option>
                        </select>
                      )}
                    </Field>
                    {c.type !== "transparency" && (
                      <Field label="Shade count">
                        {(p) => (
                          <select className="input" value={c.shadeCount} onChange={(e) => patchBase((l) => listUpdate(l, c.id, "shadeCount", Number(e.target.value)))} {...p}>
                            <option value={9}>9 shades — 100 to 900</option>
                            <option value={10}>10 shades — 100 to 950</option>
                            <option value={11}>11 shades — 50 to 950</option>
                          </select>
                        )}
                      </Field>
                    )}
                    {isColor(c.hex) && (
                      <div className="field" style={{ justifyContent: "flex-end" }}>
                        <span className="field-label">
                          {c.type === "transparency" ? "Transparency preview" : "Generated ramp preview"}
                        </span>
                        <RampStrip
                          colours={Object.entries(colorIndex)
                            .filter(([path]) => path.startsWith(`${slugify(c.name)}/`) && !path.endsWith("/base"))
                            .map(([, v]) => v)}
                        />
                      </div>
                    )}
                  </div>
                </Card>
              ))}
              <Button onClick={() => patchBase((l) => listAdd(l, { name: "Custom", hex: "", type: "shades", shadeCount: 9 }))}>
                + Add colour
              </Button>
            </>
          )}

          {colorMode === "palette" && (
            <>
              {!paletteList.length && <EmptyState title="No colour groups yet">A group is one colour family — Primary, Neutral, Success — with a hex per shade.</EmptyState>}
              {paletteList.map((p, pi) => (
                <Card key={p.id}>
                  <div className="card-head">
                    <input
                      className="input grow input-title"
                      value={p.name ?? ""}
                      onChange={(e) => patchPalette((l) => listUpdate(l, p.id, "name", e.target.value))}
                      aria-label={`Colour group ${pi + 1} name`}
                      placeholder="Colour group name"
                      aria-invalid={paletteDupes.has(p.id) ? "true" : undefined}
                    />
                    <div className="row-nowrap">
                      <IconButton label="Move group up" disabled={pi === 0} onClick={() => patchPalette((l) => listMove(l, pi, -1))}>↑</IconButton>
                      <IconButton label="Move group down" disabled={pi === paletteList.length - 1} onClick={() => patchPalette((l) => listMove(l, pi, 1))}>↓</IconButton>
                      <IconButton label={`Delete group ${p.name}`} danger onClick={() => patchPalette((l) => listRemove(l, p.id))}>🗑</IconButton>
                    </div>
                  </div>

                  <div className="nv-head" aria-hidden="true"><span>Shade</span><span>Hex</span><span>Actions</span></div>
                  {p.shades.map((s, si) => (
                    <div className="nv-row" key={s.id}>
                      <div className="nv-name">
                        <CellInput
                          value={s.shade}
                          onChange={(v) => patchPalette((l) => l.map((g) => g.id === p.id ? { ...g, shades: listUpdate(g.shades, s.id, "shade", v) } : g))}
                          validate={V.tokenName}
                          ariaLabel={`Shade name ${si + 1} in ${p.name}`}
                          placeholder="500"
                        />
                      </div>
                      <div className="nv-value">
                        <ColorInput
                          value={s.hex}
                          fallback="#ffffff"
                          onToast={onToast}
                          ariaLabel={`Hex for ${p.name} ${s.shade}`}
                          onChange={(v) => patchPalette((l) => l.map((g) => g.id === p.id ? { ...g, shades: listUpdate(g.shades, s.id, "hex", v) } : g))}
                        />
                      </div>
                      <div className="nv-acts">
                        <IconButton label="Move shade up" disabled={si === 0} onClick={() => patchPalette((l) => l.map((g) => g.id === p.id ? { ...g, shades: listMove(g.shades, si, -1) } : g))}>↑</IconButton>
                        <IconButton label="Move shade down" disabled={si === p.shades.length - 1} onClick={() => patchPalette((l) => l.map((g) => g.id === p.id ? { ...g, shades: listMove(g.shades, si, 1) } : g))}>↓</IconButton>
                        <IconButton label="Delete shade" danger onClick={() => patchPalette((l) => l.map((g) => g.id === p.id ? { ...g, shades: listRemove(g.shades, s.id) } : g))}>🗑</IconButton>
                      </div>
                    </div>
                  ))}
                  <Button size="sm" className="mt-3" onClick={() => patchPalette((l) => l.map((g) => g.id === p.id ? { ...g, shades: listAdd(g.shades, { shade: "950", hex: "" }) } : g))}>
                    + Add shade
                  </Button>
                </Card>
              ))}
              <Button onClick={() => patchPalette((l) => listAdd(l, { name: "Custom", shades: [100, 300, 500, 700, 900].map((n) => ({ id: uid(), shade: String(n), hex: "" })) }))}>
                + Add colour group
              </Button>
            </>
          )}
        </>
      )}

      {tab === "semantic" && (
        <>
          {!tokenPaths.length && (
            <Callout tone="warn">
              No colour primitives found yet. Fill in the Primitives tab first — the mapping dropdowns read from it.
            </Callout>
          )}
          <div className="spread mb-3">
            <Tabs<ResolvedTheme>
              size="sm"
              label="Colour mode"
              value={mode}
              onChange={setMode}
              options={[{ value: "light", label: "☀ Light" }, { value: "dark", label: "☾ Dark" }]}
            />
            <div className="row-nowrap">
              <span className="badge badge-idle">{mappedCount}/{totalRoles} mapped</span>
              <Button size="sm" variant="primary" onClick={runAutoMap} disabled={!tokenPaths.length}>Auto map</Button>
            </div>
          </div>
          <Callout>
            Groups and roles are fully yours — rename, reorder, delete or add as many as your naming system needs.
            {colorMode === "base" && " Because you chose Colour Base, the dropdown lists the shade paths Figma will generate."}
          </Callout>

          <ComponentPreview semanticColors={previewColors} mode={mode} />

          <SemGroupEditor
            groups={semColorGroups}
            onChange={setSemColorGroups}
            newRole={() => ({ name: "", lightRef: "", darkRef: "" })}
            renderMapping={renderMapping}
          />
        </>
      )}
    </>
  );
}

/* ── Step 3 · Typography ────────────────────────────────────────────────── */
interface StepTypographyProps {
  data: TypographySection;
  onChange: (next: TypographySection) => void;
  semTypoGroups: SemGroup[];
  setSemTypoGroups: Setter<SemGroup[]>;
  brands: string[];
}

function StepTypography({ data, onChange, semTypoGroups, setSemTypoGroups, brands }: StepTypographyProps) {
  const [tab, setTab] = useState("primitives");
  const set = (key: keyof TypographySection, value: unknown) =>
    onChange({ ...data, [key]: value } as TypographySection);

  const familyOptions = useMemo(() => {
    const all = [
      ...(data.universalFamilies || []),
      ...Object.values(data.brandFamilies || {}).flat(),
    ].filter((f) => f.name && f.value);
    return [...new Map(all.map((f) => [slugify(f.name), { value: `{font.family.${slugify(f.name)}}`, label: f.name }])).values()];
  }, [data.universalFamilies, data.brandFamilies]);

  const opt = (list: TokenItem[], prefix: string): Option[] =>
    filled(list, "value").map((s) => ({ value: `{${prefix}.${slugify(s.name)}}`, label: `${s.name} · ${s.value}` }));

  const sizeOptions = useMemo(() => opt(data.sizeScale, "font.size"), [data.sizeScale]);
  const weightOptions = useMemo(() => opt(data.weightScale, "font.weight"), [data.weightScale]);
  const lineOptions = useMemo(() => opt(data.lineHeightScale, "font.lineHeight"), [data.lineHeightScale]);
  const trackOptions = useMemo(() => opt(data.trackingScale, "font.tracking"), [data.trackingScale]);

  const renderMapping = (role: SemRole, patch: (key: string, value: string) => void) => (
    <div className="typo-grid">
      {([
        ["family", "Family", familyOptions],
        ["size", "Size", sizeOptions],
        ["weight", "Weight", weightOptions],
        ["lineHeight", "Line height", lineOptions],
        ["tracking", "Tracking", trackOptions],
      ] as Array<[keyof SemRole, string, Option[]]>).map(([key, label, options]) => (
        <Select
          key={key}
          small
          ariaLabel={`${label} for ${role.name}`}
          value={role[key] as string | undefined}
          onChange={(v) => patch(key, v)}
          options={options}
          placeholder={label}
        />
      ))}
    </div>
  );

  const scales: Array<{
    key: keyof TypographySection;
    title: string;
    note: string;
    ph: [string, string];
    validate: Validator;
  }> = [
    { key: "sizeScale", title: "Font size scale", note: "Any CSS length. px is safest for Figma.", ph: ["sm", "14px"], validate: V.dimension },
    { key: "weightScale", title: "Font weight scale", note: "Numeric weights 100–900.", ph: ["regular", "400"], validate: V.fontWeight },
    { key: "lineHeightScale", title: "Line height scale", note: "Unitless multipliers or px.", ph: ["normal", "1.5"], validate: V.dimension },
    { key: "trackingScale", title: "Letter spacing scale", note: "Whole numbers — Figma stores letter spacing as a percentage.", ph: ["tight", "-3"], validate: V.percent },
  ];

  return (
    <>
      <PageHead eyebrow="Foundations · Step 3 of 10" title="Typography">
        Font families and type scales, then the text styles that reference them.
      </PageHead>

      <Tabs label="Typography section" value={tab} onChange={setTab}
        options={[{ value: "primitives", label: "Primitives" }, { value: "semantic", label: "Semantic" }]} />

      {tab === "primitives" && (
        <>
          <Card title="Font families" note="Name each family role however you like — Display, Arabic, Handwriting, anything.">
            <Tabs size="sm" label="Family mode" value={data.familyMode} onChange={(v) => set("familyMode", v)}
              options={[{ value: "universal", label: "Universal" }, { value: "per-brand", label: "Per brand" }]} />

            {data.familyMode === "universal" ? (
              <NameValueEditor
                items={data.universalFamilies}
                onChange={(v) => set("universalFamilies", v)}
                namePlaceholder="Display"
                valuePlaceholder="Playfair Display, serif"
                valueLabel="Font stack"
                addLabel="Add family"
                emptyTitle="No font families yet"
                emptyHint="Add at least one so text styles have something to reference."
              />
            ) : (
              brands.map((brand) => (
                <div key={brand} className="mt-4">
                  <h4 className="card-title mb-3">{brand}</h4>
                  <NameValueEditor
                    items={(data.brandFamilies || {})[brand] || []}
                    onChange={(v) => set("brandFamilies", { ...(data.brandFamilies || {}), [brand]: v })}
                    namePlaceholder="Display"
                    valuePlaceholder="Satoshi, sans-serif"
                    valueLabel="Font stack"
                    addLabel={`Add family for ${brand}`}
                    emptyTitle={`No families for ${brand}`}
                    emptyHint="This brand will fall back to the shared families if left empty."
                  />
                </div>
              ))
            )}
          </Card>

          <TypePreview semTypoGroups={semTypoGroups} typography={data} />

          {scales.map(({ key, title, note, ph, validate }) => (
            <Card key={key} title={title} note={note}>
              <NameValueEditor
                items={data[key] as TokenItem[]}
                onChange={(v) => set(key, v)}
                namePlaceholder={ph[0]}
                valuePlaceholder={ph[1]}
                validateValue={validate}
                addLabel="Add step"
                emptyTitle="Scale is empty"
                emptyHint="Add a step, or skip this scale entirely."
              />
            </Card>
          ))}
        </>
      )}

      {tab === "semantic" && (
        <>
          <Callout>Each text style points at your primitives. Leave a field blank to omit it from the export.</Callout>

          <TypePreview semTypoGroups={semTypoGroups} typography={data} />

          <SemGroupEditor
            groups={semTypoGroups}
            onChange={setSemTypoGroups}
            newRole={() => ({ name: "", ...TYPO_ROLE_FIELDS })}
            renderMapping={renderMapping}
            roleNamePlaceholder="heading/1"
          />
        </>
      )}
    </>
  );
}

/* ── Step 4 · Scale ─────────────────────────────────────────────────────── */
interface StepScaleProps {
  data: ScaleSection;
  onChange: (next: ScaleSection) => void;
  semScaleGroups: SemGroup[];
  setSemScaleGroups: Setter<SemGroup[]>;
}

function StepScale({ data, onChange, semScaleGroups, setSemScaleGroups }: StepScaleProps) {
  const [tab, setTab] = useState("primitives");
  const set = (key: keyof ScaleSection, value: unknown) =>
    onChange({ ...data, [key]: value } as ScaleSection);

  const options = useMemo<Option[]>(() => [
    ...filled(data.scale, "value").map((s) => ({ value: `{scale.${slugify(s.name)}}`, label: `scale.${s.name} · ${s.value}` })),
    ...filled(data.borderRadius, "value").map((s) => ({ value: `{border.radius.${slugify(s.name)}}`, label: `radius.${s.name} · ${s.value}` })),
  ], [data.scale, data.borderRadius]);

  const renderMapping = (role: SemRole, patch: (key: string, value: string) => void) => (
    <>
      <span className="arrow" aria-hidden="true">→</span>
      <Select small ariaLabel={`Map ${role.name}`} value={role.ref} onChange={(v) => patch("ref", v)} options={options} placeholder="— choose scale step —" />
    </>
  );

  return (
    <>
      <PageHead eyebrow="Foundations · Step 4 of 10" title="Scale">
        One universal scale drives spacing, sizing and radius — fewer tokens, no duplication. It ends with <code>full · 9999px</code> for pills and circles.
      </PageHead>

      <Tabs label="Scale section" value={tab} onChange={setTab}
        options={[{ value: "primitives", label: "Primitives" }, { value: "semantic", label: "Semantic" }]} />

      {tab === "primitives" && (
        <>
          <Card title="Base unit" note="Regenerating replaces the scale below with fresh values derived from this unit.">
            <div className="grid-2" style={{ alignItems: "end" }}>
              <Field label="Base unit">
                {(p) => (
                  <select className="input" value={data.baseUnit} onChange={(e) => set("baseUnit", Number(e.target.value))} {...p}>
                    <option value={4}>4px system</option>
                    <option value={8}>8px system</option>
                  </select>
                )}
              </Field>
              <Button variant="primary" onClick={() => set("scale", mkScale(data.baseUnit || 4))}>Regenerate scale</Button>
            </div>
          </Card>

          <Card title="Scale" note="Referenced by every semantic spacing, height, icon and radius token.">
            <NameValueEditor items={data.scale} onChange={(v) => set("scale", v)}
              namePlaceholder="4" valuePlaceholder="16px" validateValue={V.dimension} addLabel="Add step"
              emptyTitle="Scale is empty" emptyHint="Regenerate above or add steps manually." />
          </Card>

          <Card title="Border radius" note="Small dedicated set — 9999px does not belong in a spacing progression.">
            <NameValueEditor items={data.borderRadius} onChange={(v) => set("borderRadius", v)}
              namePlaceholder="md" valuePlaceholder="8px" validateValue={V.dimension} addLabel="Add radius" />
          </Card>

          <Card title="Border width" note="Sub-pixel values that are too fine for the main scale.">
            <NameValueEditor items={data.borderWidths} onChange={(v) => set("borderWidths", v)}
              namePlaceholder="thin" valuePlaceholder="1px" validateValue={V.dimension} addLabel="Add width" />
          </Card>
        </>
      )}

      {tab === "semantic" && (
        <>
          {!options.length && <Callout tone="warn">Define scale steps in the Primitives tab first.</Callout>}
          <Callout>Rename, reorder, delete or add any group to match your project's naming system.</Callout>
          <SemGroupEditor groups={semScaleGroups} onChange={setSemScaleGroups}
            newRole={() => ({ name: "", ref: "" })} renderMapping={renderMapping} roleNamePlaceholder="component/md" />
        </>
      )}
    </>
  );
}

/* ── Step 5 · Effects ───────────────────────────────────────────────────── */
interface StepEffectsProps {
  data: EffectsSection;
  onChange: (next: EffectsSection) => void;
  onToast: (message: string) => void;
}

function StepEffects({ data, onChange, onToast }: StepEffectsProps) {
  const [tab, setTab] = useState("primitives");
  const set = (key: keyof EffectsSection, value: unknown) =>
    onChange({ ...data, [key]: value } as EffectsSection);
  const semantic = data.semantic || mkEffectsSemantic();
  const setSemantic = (key: keyof EffectsSemantic, value: SemRole[]) =>
    set("semantic", { ...semantic, [key]: value });

  const shadows = data.shadows || [];
  const shadowDupes = useMemo(() => duplicateIds(shadows), [shadows]);

  const refOptions = (list: Array<{ name: string }> | undefined, prefix: string): Option[] =>
    (list || []).filter((s) => s.name).map((s) => ({ value: `{${prefix}.${slugify(s.name)}}`, label: `${prefix}.${s.name}` }));

  const shadowOpts = useMemo(() => refOptions(data.shadows, "shadow"), [data.shadows]);
  const blurOpts = useMemo(() => refOptions(data.blurs, "blur"), [data.blurs]);
  const opacityOpts = useMemo(() => refOptions(data.opacity, "opacity"), [data.opacity]);

  const RoleList = ({ title, note, listKey, options }: { title: string; note?: string; listKey: keyof EffectsSemantic; options: Option[] }) => {
    const list = semantic[listKey] || [];
    const dupes = duplicateIds(list);
    return (
      <Card title={title} note={note}>
        {!list.length && <EmptyState title="No roles yet">A role gives a primitive a job — shadow/card, blur/overlay.</EmptyState>}
        {list.map((r, i) => (
          <div className="role" key={r.id}>
            <div className="role-name">
              <CellInput value={r.name} onChange={(v) => setSemantic(listKey, listUpdate(list, r.id, "name", v))}
                validate={() => (dupes.has(r.id) ? "Duplicate name" : V.tokenName(r.name))}
                ariaLabel={`${title} role ${i + 1} name`} placeholder="card" />
            </div>
            <div className="role-map">
              <span className="arrow" aria-hidden="true">→</span>
              <Select small ariaLabel={`Map ${r.name}`} value={r.ref}
                onChange={(v) => setSemantic(listKey, listUpdate(list, r.id, "ref", v))}
                options={options} placeholder="— choose primitive —" />
            </div>
            <div className="role-acts">
              <IconButton label="Move up" disabled={i === 0} onClick={() => setSemantic(listKey, listMove(list, i, -1))}>↑</IconButton>
              <IconButton label="Move down" disabled={i === list.length - 1} onClick={() => setSemantic(listKey, listMove(list, i, 1))}>↓</IconButton>
              <IconButton label={`Delete ${r.name || "role"}`} danger onClick={() => setSemantic(listKey, listRemove(list, r.id))}>🗑</IconButton>
            </div>
          </div>
        ))}
        <Button size="sm" className="mt-3" onClick={() => setSemantic(listKey, listAdd(list, { name: "", ref: "" }))}>+ Add role</Button>
      </Card>
    );
  };

  return (
    <>
      <PageHead eyebrow="Foundations · Step 5 of 10" title="Effects">
        Shadows, blur and opacity primitives, then the semantic roles that consume them.
      </PageHead>

      <Tabs label="Effects section" value={tab} onChange={setTab}
        options={[{ value: "primitives", label: "Primitives" }, { value: "semantic", label: "Semantic" }]} />

      {tab === "primitives" && (
        <>
          <Card title="Shadows" note="Fields mirror Figma exactly: X, Y, Blur, Spread and Colour. Enter plain numbers — px is added on export.">
            {!shadows.length && <EmptyState title="No shadows yet">Add an elevation step — X, Y, blur, spread and colour, exactly as Figma stores it.</EmptyState>}
            {shadows.map((s, i) => (
              <div className="wide-row" key={s.id}>
                <div className="row-nowrap">
                  <CellInput value={s.name} onChange={(v) => set("shadows", listUpdate(shadows, s.id, "name", v))}
                    validate={() => (shadowDupes.has(s.id) ? "Duplicate name" : V.tokenName(s.name))}
                    ariaLabel={`Shadow ${i + 1} name`} placeholder="m" />
                  <div className="row-nowrap push">
                    <IconButton label="Move up" disabled={i === 0} onClick={() => set("shadows", listMove(shadows, i, -1))}>↑</IconButton>
                    <IconButton label="Move down" disabled={i === shadows.length - 1} onClick={() => set("shadows", listMove(shadows, i, 1))}>↓</IconButton>
                    <IconButton label={`Delete shadow ${s.name}`} danger onClick={() => set("shadows", listRemove(shadows, s.id))}>🗑</IconButton>
                  </div>
                </div>
                <div className="wide-grid">
                  {[["x", "X"], ["y", "Y"], ["blur", "Blur"], ["spread", "Spread"]].map(([key, label]) => (
                    <Field key={key} label={label}>
                      {(p) => (
                        <CellInput value={s[key]} onChange={(v) => set("shadows", listUpdate(shadows, s.id, key, v))}
                          validate={V.number} ariaLabel={`${label} for shadow ${s.name}`} placeholder="0" inputMode="decimal" {...p} />
                      )}
                    </Field>
                  ))}
                </div>
                <Field label="Colour">
                  <ColorInput value={s.color} fallback="#000000" placeholder="#000000"
                    onToast={onToast}
                    ariaLabel={`Colour for shadow ${s.name}`}
                    onChange={(v) => set("shadows", listUpdate(shadows, s.id, "color", v))} />
                </Field>
              </div>
            ))}
            <Button size="sm" onClick={() => set("shadows", listAdd(shadows, { name: "", x: "", y: "", blur: "", spread: "", color: "" }))}>+ Add shadow</Button>
          </Card>

          <Card title="Blur" note="Plain numbers — px is appended on export.">
            <NameValueEditor items={data.blurs} onChange={(v) => set("blurs", v)}
              namePlaceholder="m" valuePlaceholder="8" validateValue={V.number} addLabel="Add blur" />
          </Card>

          <Card title="Opacity" note="Whole numbers matching Figma's percentage field — 50 means 50%.">
            <NameValueEditor items={data.opacity} onChange={(v) => set("opacity", v)}
              namePlaceholder="disabled" valuePlaceholder="38" validateValue={V.percent} addLabel="Add opacity" />
          </Card>
        </>
      )}

      {tab === "semantic" && (
        <>
          <Callout>These land in the <b>Semantics/Effects and Motion</b> collection — a single mode, since shadows and blur do not change between light and dark.</Callout>
          <RoleList title="Shadow roles" note="e.g. shadow/card → shadow.m" listKey="shadowRoles" options={shadowOpts} />
          <RoleList title="Blur roles" listKey="blurRoles" options={blurOpts} />
          <RoleList title="Opacity roles" listKey="opacityRoles" options={opacityOpts} />
        </>
      )}
    </>
  );
}

/* ── Step 6 · Motion ────────────────────────────────────────────────────── */
interface StepMotionProps {
  data: MotionSection;
  onChange: (next: MotionSection) => void;
}

function StepMotion({ data, onChange }: StepMotionProps) {
  const [tab, setTab] = useState("primitives");
  const set = (key: keyof MotionSection, value: unknown) =>
    onChange({ ...data, [key]: value } as MotionSection);
  const semantic = data.semantic || mkMotionSemantic();
  const setSemantic = (key: keyof MotionSemantic, value: SemRole[]) =>
    set("semantic", { ...semantic, [key]: value });

  const durationOpts = useMemo(
    () => filled(data.durations, "value").map((s) => ({ value: `{motion.${slugify(s.name)}}`, label: `${s.name} · ${s.value}` })),
    [data.durations]);
  const easingOpts = useMemo(
    () => filled(data.easings, "value").map((s) => ({ value: `{motion.${slugify(s.name)}}`, label: s.name })),
    [data.easings]);

  const RoleList = ({ title, prefix, listKey, options }: { title: string; prefix: string; listKey: keyof MotionSemantic; options: Option[] }) => {
    const list = semantic[listKey] || [];
    const dupes = duplicateIds(list);
    return (
      <Card title={title}>
        {!list.length && <EmptyState title="No roles yet">A role gives a duration or curve a job — motion/duration/fast.</EmptyState>}
        {list.map((r, i) => (
          <div className="role" key={r.id}>
            <div className="role-name">
              <CellInput value={r.name} onChange={(v) => setSemantic(listKey, listUpdate(list, r.id, "name", v))}
                validate={() => (dupes.has(r.id) ? "Duplicate name" : V.tokenName(r.name))}
                ariaLabel={`${title} ${i + 1} name`} placeholder="fast" />
            </div>
            <div className="role-map">
              <span className="arrow" aria-hidden="true">→</span>
              <Select small ariaLabel={`Map ${prefix}/${r.name}`} value={r.ref}
                onChange={(v) => setSemantic(listKey, listUpdate(list, r.id, "ref", v))}
                options={options} placeholder="— choose primitive —" />
            </div>
            <div className="role-acts">
              <IconButton label="Move up" disabled={i === 0} onClick={() => setSemantic(listKey, listMove(list, i, -1))}>↑</IconButton>
              <IconButton label="Move down" disabled={i === list.length - 1} onClick={() => setSemantic(listKey, listMove(list, i, 1))}>↓</IconButton>
              <IconButton label={`Delete ${r.name || "role"}`} danger onClick={() => setSemantic(listKey, listRemove(list, r.id))}>🗑</IconButton>
            </div>
          </div>
        ))}
        <Button size="sm" className="mt-3" onClick={() => setSemantic(listKey, listAdd(list, { name: "", ref: "" }))}>+ Add role</Button>
      </Card>
    );
  };

  const transitions = semantic.transitions || [];

  return (
    <>
      <PageHead eyebrow="Foundations · Step 6 of 10" title="Motion">
        Durations and easing curves, then the named roles and transitions that use them.
      </PageHead>

      <Tabs label="Motion section" value={tab} onChange={setTab}
        options={[{ value: "primitives", label: "Primitives" }, { value: "semantic", label: "Semantic" }]} />

      {tab === "primitives" && (
        <>
          <Card title="Duration scale" note="Include the unit, e.g. 200ms.">
            <NameValueEditor items={data.durations} onChange={(v) => set("durations", v)}
              namePlaceholder="duration-200" valuePlaceholder="200ms" validateValue={V.duration} addLabel="Add duration" />
          </Card>
          <Card title="Easing curves" note="linear or cubic-bezier(a, b, c, d).">
            <NameValueEditor items={data.easings} onChange={(v) => set("easings", v)}
              namePlaceholder="ease-out" valuePlaceholder="cubic-bezier(0, 0, 0.2, 1)" validateValue={V.easing} addLabel="Add easing" />
          </Card>
        </>
      )}

      {tab === "semantic" && (
        <>
          <Callout>Stored in the <b>Semantics/Effects and Motion</b> collection. Transitions stay as two separate sub-tokens so Figma can alias each one.</Callout>
          <RoleList title="Duration roles" prefix="motion/duration" listKey="durationRoles" options={durationOpts} />
          <RoleList title="Easing roles" prefix="motion/easing" listKey="easingRoles" options={easingOpts} />

          <Card title="Transitions" note="Each transition exports as …/duration and …/easing — two independent aliases.">
            {!transitions.length && <EmptyState title="No transitions yet">A transition pairs one duration with one easing and exports as two aliases.</EmptyState>}
            {transitions.map((t, i) => (
              <div className="subcard" key={t.id}>
                <div className="row-nowrap mb-3">
                  <CellInput value={t.name} onChange={(v) => setSemantic("transitions", listUpdate(transitions, t.id, "name", v))}
                    validate={V.tokenName} ariaLabel={`Transition ${i + 1} name`} placeholder="button" />
                  <IconButton label={`Delete transition ${t.name}`} danger onClick={() => setSemantic("transitions", listRemove(transitions, t.id))}>🗑</IconButton>
                </div>
                <div className="grid-2">
                  <Field label="Duration">
                    {(p) => <Select ariaLabel={`Duration for ${t.name}`} value={t.durationRef}
                      onChange={(v) => setSemantic("transitions", listUpdate(transitions, t.id, "durationRef", v))}
                      options={durationOpts} {...p} />}
                  </Field>
                  <Field label="Easing">
                    {(p) => <Select ariaLabel={`Easing for ${t.name}`} value={t.easingRef}
                      onChange={(v) => setSemantic("transitions", listUpdate(transitions, t.id, "easingRef", v))}
                      options={easingOpts} {...p} />}
                  </Field>
                </div>
              </div>
            ))}
            <Button size="sm" onClick={() => setSemantic("transitions", listAdd(transitions, { name: "", durationRef: "", easingRef: "" }))}>+ Add transition</Button>
          </Card>
        </>
      )}
    </>
  );
}

/* ── Step 7 · Z-Index ───────────────────────────────────────────────────── */
function StepZIndex({ data, onChange }: { data: TokenItem[]; onChange: (next: TokenItem[]) => void }) {
  return (
    <>
      <PageHead eyebrow="Foundations · Step 7 of 10" title="Z-index layers">
        A named stacking order. Figma variables cannot bind to layer order, so these serve documentation and developer handoff.
      </PageHead>
      <Card title="Layers" note="Keep gaps between values so new layers can be inserted later without renumbering.">
        <NameValueEditor items={data} onChange={onChange}
          namePlaceholder="modal" valuePlaceholder="400" validateValue={V.integer} addLabel="Add layer"
          emptyTitle="No layers defined" emptyHint="Name your stacking layers — base, dropdown, modal, toast." />
      </Card>
    </>
  );
}

/* ── Step 8 · Components ────────────────────────────────────────────────── */
interface StepComponentsProps {
  data: ComponentDefinition[];
  onChange: (next: ComponentDefinition[]) => void;
}

function StepComponents({ data, onChange }: StepComponentsProps) {
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");

  const selected = useMemo(() => new Set(data.map((c) => c.name.toLowerCase())), [data]);
  const results = useMemo(
    () => COMMON_COMPONENTS.filter((n) => n.toLowerCase().includes(query.trim().toLowerCase())),
    [query]
  );

  const addComponent = useCallback((name: string) => {
    const clean = (name || "").trim();
    if (!clean) return;
    if (data.some((c) => c.name.toLowerCase() === clean.toLowerCase())) return;
    onChange([...data, { id: uid(), name: clean, tokens: mkComponentTokens() }]);
  }, [data, onChange]);

  const removeComponent = useCallback((id: ID) => onChange(data.filter((c) => c.id !== id)), [data, onChange]);

  const toggle = useCallback((name: string) => {
    const hit = data.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (hit) removeComponent(hit.id);
    else addComponent(name);
  }, [data, addComponent, removeComponent]);

  const patchTokens = useCallback((compId: ID, fn: (tokens: TokenItem[]) => TokenItem[]) =>
    onChange(data.map((c) => (c.id === compId ? { ...c, tokens: fn(c.tokens || []) } : c))), [data, onChange]);

  return (
    <>
      <PageHead eyebrow="Components · Step 8 of 10" title="Component tokens">
        Optional. Pick the components you document, then point each token at a semantic token using <code style={{ fontFamily: "var(--mono)" }}>{"{}"}</code> syntax.
      </PageHead>

      <Card title="Choose components">
        <Field label="Search">
          {(p) => (
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter the list…" type="search" {...p} />
          )}
        </Field>

        <div className="chips mt-3" role="group" aria-label="Common components">
          {results.map((name) => (
            <button key={name} type="button" className="chip"
              aria-pressed={selected.has(name.toLowerCase())} onClick={() => toggle(name)}>
              {selected.has(name.toLowerCase()) ? "✓ " : ""}{name}
            </button>
          ))}
          {!results.length && <span className="field-hint">No match — add it as a custom component below.</span>}
        </div>

        <div className="divider" />

        <Field label="Custom component" hint="Not in the list? Name it yourself.">
          {(p) => (
            <div className="row-nowrap">
              <input className="input grow" value={custom} onChange={(e) => setCustom(e.target.value)}
                placeholder="e.g. Stepper"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addComponent(custom); setCustom(""); } }}
                {...p} />
              <Button variant="primary" size="sm" onClick={() => { addComponent(custom); setCustom(""); }} disabled={!custom.trim()}>
                Add
              </Button>
            </div>
          )}
        </Field>
      </Card>

      {!data.length && (
        <EmptyState title="No components selected">
          Optional. Pick a component above to document its tokens, or skip if your system stops at the semantic layer.
        </EmptyState>
      )}

      {data.map((comp) => {
        const dupes = duplicateIds(comp.tokens);
        return (
          <Card key={comp.id}>
            <div className="card-head">
              <h3 className="card-title" style={{ fontSize: "var(--fs-14)" }}>{comp.name}</h3>
              <Button size="sm" variant="danger" onClick={() => removeComponent(comp.id)}>Remove</Button>
            </div>

            <div className="nv-head" aria-hidden="true"><span>Token</span><span>Value</span><span>Actions</span></div>
            {(comp.tokens || []).map((tok, i) => (
              <div className="nv-row" key={tok.id}>
                <div className="nv-name">
                  <CellInput value={tok.name} onChange={(v) => patchTokens(comp.id, (l) => listUpdate(l, tok.id, "name", v))}
                    validate={() => (dupes.has(tok.id) ? "Duplicate name" : V.tokenName(tok.name))}
                    ariaLabel={`${comp.name} token ${i + 1} name`} placeholder="background/default" />
                </div>
                <div className="nv-value">
                  <CellInput value={tok.value} onChange={(v) => patchTokens(comp.id, (l) => listUpdate(l, tok.id, "value", v))}
                    ariaLabel={`${comp.name} token ${i + 1} value`} placeholder="{interactive/primary}" />
                </div>
                <div className="nv-acts">
                  <IconButton label="Move up" disabled={i === 0} onClick={() => patchTokens(comp.id, (l) => listMove(l, i, -1))}>↑</IconButton>
                  <IconButton label="Move down" disabled={i === comp.tokens.length - 1} onClick={() => patchTokens(comp.id, (l) => listMove(l, i, 1))}>↓</IconButton>
                  <IconButton label="Delete token" danger onClick={() => patchTokens(comp.id, (l) => listRemove(l, tok.id))}>🗑</IconButton>
                </div>
              </div>
            ))}
            <Button size="sm" className="mt-3" onClick={() => patchTokens(comp.id, (l) => listAdd(l, { name: "", value: "" }))}>
              + Add token
            </Button>
          </Card>
        );
      })}
    </>
  );
}

/* ── Step 9 · Summary ───────────────────────────────────────────────────── */
function countStats(S: PlannerDoc) {
  const brand = (S.project.brands || ["Brand A"])[0];
  const colorTokens = S.colorMode === "palette"
    ? (S.colorPalette[brand] || []).reduce((n, p) => n + p.shades.filter((s) => isColor(s.hex)).length, 0)
    : (S.colorBase[brand] || []).filter((c) => isColor(c.hex)).length;

  const semColor = (S.semColorGroups || []).reduce(
    (acc, g) => {
      acc.total += g.roles.length;
      acc.light += g.roles.filter((r) => !blank(r.lightRef)).length;
      acc.dark += g.roles.filter((r) => !blank(r.darkRef)).length;
      return acc;
    }, { total: 0, light: 0, dark: 0 });

  const semTypo = (S.semTypoGroups || []).reduce((n, g) =>
    n + g.roles.filter((r) => r.family || r.size || r.weight || r.lineHeight || r.tracking).length, 0);
  const semScale = (S.semScaleGroups || []).reduce((n, g) => n + g.roles.filter((r) => !blank(r.ref)).length, 0);

  return {
    colorTokens, semColor, semTypo, semScale,
    typeSizes: filled(S.typography.sizeScale, "value").length,
    scaleSteps: filled(S.scale.scale, "value").length,
    radii: filled(S.scale.borderRadius, "value").length,
    shadows: (S.effects.shadows || []).filter((s) => s.name && (s.x || s.y || s.blur || s.spread || s.color)).length,
    blurs: filled(S.effects.blurs, "value").length,
    durations: filled(S.motion.durations, "value").length,
    easings: filled(S.motion.easings, "value").length,
    zLayers: filled(S.zIndex, "value").length,
    components: (S.components || []).length,
    componentTokens: (S.components || []).reduce((n, c) => n + (c.tokens || []).filter((t) => t.name && !blank(t.value)).length, 0),
  };
}

interface StepSummaryProps {
  state: PlannerDoc;
  stepStatus: StepStatusMap;
  onGo: (step: number) => void;
}

function StepSummary({ state, stepStatus, onGo }: StepSummaryProps) {
  const s = countStats(state);
  const P = state.project;

  const rows = [
    ["Project", P.name || "—"],
    ["Design system", P.systemName || "—"],
    ["Version", P.version || "—"],
    ["Reviewer", P.reviewer || "—"],
    ["Status", P.status],
    ["Serial", P.serial],
    ["Brands", (P.brands || []).join(", ")],
    ["Colour method", state.colorMode === "base" ? "Colour Base — Figma generates shades" : "Colour Palette — exact hex"],
  ];

  const counts = [
    ["Colour primitives", s.colorTokens],
    ["Type sizes", s.typeSizes],
    ["Scale steps", s.scaleSteps],
    ["Border radii", s.radii],
    ["Shadows", s.shadows],
    ["Blur steps", s.blurs],
    ["Motion durations", s.durations],
    ["Easing curves", s.easings],
    ["Z-index layers", s.zLayers],
    ["Semantic colour (light)", `${s.semColor.light} / ${s.semColor.total}`],
    ["Semantic colour (dark)", `${s.semColor.dark} / ${s.semColor.total}`],
    ["Semantic text styles", s.semTypo],
    ["Semantic scale roles", s.semScale],
    ["Components", s.components],
    ["Component tokens", s.componentTokens],
  ];

  return (
    <>
      <PageHead eyebrow="Export · Step 9 of 10" title="Summary">
        A last look before generating the prompt. Tap any step below to jump back and adjust it.
      </PageHead>

      <Card title="Project">
        {rows.map(([k, v]) => (
          <div className="sum-row" key={k}><span className="sum-key">{k}</span><span className="sum-val">{v}</span></div>
        ))}
      </Card>

      <Card title="Token counts">
        {counts.map(([k, v]) => (
          <div className="sum-row" key={k}><span className="sum-key">{k}</span><span className="sum-val">{v}</span></div>
        ))}
      </Card>

      <Card title="Step status">
        {STEPS.filter((st) => st.id !== EXPORT_STEP).map((st) => {
          const state_ = stepStatus[st.id];
          return (
            <div className="sum-row" key={st.id}>
              <button
                type="button"
                onClick={() => onGo(st.id)}
                className="sum-key sum-link"
              >
                {st.label}
              </button>
              <span className={cx("badge", state_ === "done" ? "badge-ok" : state_ === "skip" ? "badge-warn" : "badge-idle")}>
                {state_ === "done" ? "Complete" : state_ === "skip" ? "Skipped" : "Not visited"}
              </span>
            </div>
          );
        })}
      </Card>
    </>
  );
}

/* ── Step 10 · Export ───────────────────────────────────────────────────── */
interface StepExportProps {
  state: PlannerDoc;
  onToast: (message: string) => void;
  onExportProject: () => void;
  onImportFile: (file: File) => void;
}

function StepExport({ state, onToast, onExportProject, onImportFile }: StepExportProps) {
  const format = state.project.exportFormat || "both";
  const [generating, setGenerating] = useState(true);

  const prompt = useMemo(() => {
    try {
      return state.colorMode === "base" ? generateBasePrompt(state) : generatePalettePrompt(state);
    } catch (err) {
      return `/* The prompt could not be generated.\n   ${err?.message || err}\n   Your data is safe — go back, adjust the offending step and return. */`;
    }
  }, [state]);

  const json = useMemo(() => {
    try { return generateJSON(state); }
    catch (err) { return JSON.stringify({ error: String(err?.message || err) }, null, 2); }
  }, [state]);

  const stats = useMemo(() => countStats(state), [state]);

  /* one short frame of feedback so a large plan does not appear instantly and
     leave the user unsure whether anything happened */
  useEffect(() => {
    setGenerating(true);
    const t = setTimeout(() => setGenerating(false), 260);
    return () => clearTimeout(t);
  }, [prompt, json]);

  const promptOk = !prompt.startsWith("/* The prompt could not");
  const jsonOk = !json.startsWith('{\n  "error"');

  const primitiveCount =
    stats.colorTokens + stats.typeSizes + stats.scaleSteps + stats.radii +
    stats.shadows + stats.blurs + stats.durations + stats.easings;
  const semanticCount =
    stats.semColor.light + stats.semColor.dark + stats.semTypo + stats.semScale + stats.zLayers;
  const total = primitiveCount + semanticCount + stats.componentTokens;

  const filename = slugify(state.project.name || "token-plan") || "token-plan";

  return (
    <>
      <PageHead eyebrow="Review · Step 10 of 10" title="Export">
        Copy the prompt into Figma CLI, or import the JSON with Token Studio.
      </PageHead>

      {generating ? (
        <div className="callout callout-info" role="status">
          <span className="spinner" aria-hidden="true" />
          <div>Generating your token plan…</div>
        </div>
      ) : (
        <Callout tone={promptOk && jsonOk ? "ok" : "warn"}>
          {promptOk && jsonOk ? (
            <>
              <b>Prompt and JSON generated successfully.</b>{" "}
              Built from the <b>{state.colorMode === "base" ? "Colour Base" : "Colour Palette"}</b> template
              {state.colorMode === "base"
                ? " — Figma generates each shade scale first, then applies every mapping."
                : " — every hex you entered is written into the prompt directly."}
            </>
          ) : (
            <>
              <b>Generation finished with a problem.</b> {promptOk ? "The JSON" : "The prompt"} could not be
              built — the details are shown in the output below.
            </>
          )}
        </Callout>
      )}

      <div className="result">
        {[
          [total, "Tokens planned"],
          [primitiveCount, "Primitives"],
          [semanticCount, "Semantic tokens"],
          [stats.components, stats.components === 1 ? "Component" : "Components"],
        ].map(([value, label]) => (
          <div className="result-cell" key={label}>
            <div className={cx("result-num", generating && "skeleton")} style={generating ? { color: "transparent" } : undefined}>
              {value}
            </div>
            <div className="result-label">{label}</div>
          </div>
        ))}
      </div>

      <Card
        title="Continue later"
        note="A project file re-opens in Token Planner with every step, mapping and preference intact. The design-token outputs below are for Figma and your codebase instead."
      >
        <ProjectFileActions onExport={onExportProject} onImportFile={onImportFile} />
      </Card>

      <h3 className="card-title" style={{ margin: "var(--s-6) 0 var(--s-3)" }}>Design token output</h3>

      {(format === "both" || format === "prompt") && (
        <OutputBlock
          label="AI prompt"
          text={prompt}
          filename={filename}
          ext="txt"
          onToast={onToast}
          meta="paste into Figma CLI"
        />
      )}
      {(format === "both" || format === "json") && (
        <OutputBlock
          label="Token Studio JSON"
          text={json}
          filename={filename}
          ext="json"
          onToast={onToast}
          meta="import via plugin"
        />
      )}
    </>
  );
}

/* ── incomplete-steps modal ─────────────────────────────────────────────── */
interface IncompleteModalProps {
  steps: WizardStep[];
  onSkip: (id: number) => void;
  onGo: (id: number) => void;
  onClose: () => void;
  onProceed: () => void;
}

function IncompleteModal({ steps, onSkip, onGo, onClose, onProceed }: IncompleteModalProps) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inc-title"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title" id="inc-title">Some steps are unfinished</h2>
        <p className="modal-desc">
          You can still export — unfinished steps simply contribute nothing to the output.
        </p>
        {steps.map((s) => (
          <div className="modal-item" key={s.id}>
            <div className="modal-item-title">Step {s.id} · {s.label}</div>
            <div className="row">
              <Button size="sm" onClick={() => onSkip(s.id)}>Mark as skipped</Button>
              <Button size="sm" variant="primary" onClick={() => onGo(s.id)}>Go to step</Button>
            </div>
          </div>
        ))}
        <div className="divider" />
        <div className="spread">
          <Button size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={onProceed}>Export anyway</Button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   11. APP SHELL
   ═══════════════════════════════════════════════════════════════════════════ */

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Token Planner crashed:", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="tp-app">
        <main className="main">
          <PageHead eyebrow="Something went wrong" title="This screen hit an error">
            The rest of your project is still in memory. Return to the previous step, or reload to start fresh.
          </PageHead>
          <Card title="Details">
            <pre className="code" style={{ maxHeight: 180 }}>{String(this.state.error?.message || this.state.error)}</pre>
          </Card>
          <div className="row">
            <Button variant="primary" onClick={() => this.setState({ error: null })}>Try again</Button>
            <Button onClick={() => window.location.reload()}>Reload planner</Button>
          </div>
        </main>
      </div>
    );
  }
}

/** All wizard state in one place so `newProject` stays trivially correct. */
function initialState(): PlannerDoc {
  return {
    project: {
      serial: genSerial(), date: today(), name: "", systemName: "", version: "",
      reviewer: "", status: "Draft", brands: ["Brand A"], mappingPref: "auto", exportFormat: "both",
    },
    colorMode: "base",
    colorBase: { "Brand A": mkBaseColors() },
    colorPalette: { "Brand A": mkPaletteGroups() },
    typography: {
      familyMode: "universal",
      universalFamilies: [{ id: uid(), name: "", value: "" }],
      brandFamilies: {},
      sizeScale: mkFontSizes(), weightScale: mkFontWeights(),
      lineHeightScale: mkLineHeights(), trackingScale: mkLetterSpacing(),
    },
    scale: { baseUnit: 4, scale: mkScale(4), borderRadius: mkBorderRadius(), borderWidths: mkBorderWidths() },
    effects: { shadows: mkShadows(), blurs: mkBlurs(), opacity: mkOpacity(), semantic: mkEffectsSemantic() },
    motion: { durations: mkDurations(), easings: mkEasings(), semantic: mkMotionSemantic() },
    semColorGroups: mkSemColorGroups(),
    semTypoGroups: mkSemTypoGroups(),
    semScaleGroups: mkSemScaleGroups(),
    zIndex: mkZIndex(),
    components: [],
  };
}

function TokenPlanner(): JSX.Element {
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(1);
  const [stepStatus, setStepStatus] = useState<StepStatusMap>(() =>
    Object.fromEntries(STEPS.map((s) => [s.id, "todo"])) as StepStatusMap);
  const [showIncomplete, setShowIncomplete] = useState(false);
  const [toast, setToast] = useState("");
  const [doc, setDoc] = useState<PlannerDoc>(initialState);
  const { preference: themePref, setPreference: setThemePref } = useTheme();

  /* persistence */
  const [saveState, setSaveState] = useState<"saving" | "saved" | "error">("saved");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [dragging, setDragging] = useState(false);
  const storageOk = useRef(store.available());
  const createdAt = useRef(new Date().toISOString());
  const saveTimer = useRef(null);
  const dragDepth = useRef(0);
  const skipNextSave = useRef(true);

  const railRef = useRef(null);
  const activeStepRef = useRef(null);
  const mainRef = useRef(null);
  const styleInjected = useRef(false);
  const toastTimer = useRef(null);

  /* inject stylesheet once */
  useEffect(() => {
    if (styleInjected.current) return;
    const el = document.createElement("style");
    el.setAttribute("data-token-planner", "");
    el.textContent = CSS;
    document.head.appendChild(el);
    styleInjected.current = true;
  }, []);

  /* keep the active step visible in the rail; move focus to the new page */
  useEffect(() => {
    const rail = railRef.current, tab = activeStepRef.current;
    if (rail && tab) rail.scrollTo({ left: tab.offsetLeft - rail.clientWidth / 2 + tab.clientWidth / 2, behavior: "smooth" });
    mainRef.current?.focus?.();
    mainRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, [step]);

  /* restore the previous session once, before the landing screen can show */
  useEffect(() => {
    const saved = loadSavedProject();
    if (!saved) { skipNextSave.current = false; return; }
    setDoc(saved.doc);
    if (saved.step) setStep(saved.step);
    if (saved.stepStatus) setStepStatus((prev) => ({ ...prev, ...saved.stepStatus }));
    if (saved.theme) setThemePref(saved.theme);
    if (saved.createdAt) createdAt.current = saved.createdAt;
    setSavedAt(saved.updatedAt || null);
    setStarted(true);
    skipNextSave.current = false;
    setToast("Last session restored");
    setTimeout(() => setToast(""), 2600);
  }, [setThemePref]);

  /* autosave — debounced, silent, and only once the wizard is in use */
  useEffect(() => {
    if (!started || skipNextSave.current) return undefined;
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const envelope = serialiseProject(doc, {
        theme: themePref, step, stepStatus, createdAt: createdAt.current,
      });
      const ok = store.set(PROJECT_KEY, JSON.stringify(envelope));
      setSaveState(ok || !storageOk.current ? "saved" : "error");
      setSavedAt(envelope.updatedAt);
    }, AUTOSAVE_DELAY);
    return () => clearTimeout(saveTimer.current);
  }, [doc, themePref, step, stepStatus, started]);

  /* toast lifecycle */
  const pushToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /* keep per-brand colour buckets in sync when brands change */
  useEffect(() => {
    setDoc((d) => {
      const brands = d.project.brands || [];
      let base = d.colorBase, palette = d.colorPalette, changed = false;
      brands.forEach((b) => {
        if (!base[b]) { base = { ...base, [b]: mkBaseColors() }; changed = true; }
        if (!palette[b]) { palette = { ...palette, [b]: mkPaletteGroups() }; changed = true; }
      });
      return changed ? { ...d, colorBase: base, colorPalette: palette } : d;
    });
  }, [doc.project.brands]);

  /* section setters — stable identities keep child renders cheap */
  const setSection = useCallback(
    <K extends keyof PlannerDoc>(key: K) =>
      (value: PlannerDoc[K] | ((prev: PlannerDoc[K]) => PlannerDoc[K])) =>
        setDoc((d) => ({
          ...d,
          [key]: typeof value === "function" ? (value as (prev: PlannerDoc[K]) => PlannerDoc[K])(d[key]) : value,
        })),
    []
  );

  const setProject = useMemo(() => setSection("project"), [setSection]);
  const setColorMode = useMemo(() => setSection("colorMode"), [setSection]);
  const setColorBase = useMemo(() => setSection("colorBase"), [setSection]);
  const setColorPalette = useMemo(() => setSection("colorPalette"), [setSection]);
  const setTypography = useMemo(() => setSection("typography"), [setSection]);
  const setScale = useMemo(() => setSection("scale"), [setSection]);
  const setEffects = useMemo(() => setSection("effects"), [setSection]);
  const setMotion = useMemo(() => setSection("motion"), [setSection]);
  const setSemColorGroups = useMemo(() => setSection("semColorGroups"), [setSection]);
  const setSemTypoGroups = useMemo(() => setSection("semTypoGroups"), [setSection]);
  const setSemScaleGroups = useMemo(() => setSection("semScaleGroups"), [setSection]);
  const setZIndex = useMemo(() => setSection("zIndex"), [setSection]);
  const setComponents = useMemo(() => setSection("components"), [setSection]);

  const markDone = useCallback((id: number) => setStepStatus((s) => ({ ...s, [id]: "done" })), []);
  const markSkip = useCallback((id: number) => setStepStatus((s) => ({ ...s, [id]: "skip" })), []);

  const unfinished = useMemo(
    () => STEPS.filter((s) => s.id < LAST_EDIT_STEP && stepStatus[s.id] === "todo"),
    [stepStatus]
  );
  const settled = useMemo(
    () => STEPS.filter((s) => s.id < LAST_EDIT_STEP && stepStatus[s.id] !== "todo").length,
    [stepStatus]
  );
  const totalTrackable = LAST_EDIT_STEP - 1;

  const goExport = useCallback(() => {
    if (unfinished.length) setShowIncomplete(true);
    else { markDone(LAST_EDIT_STEP); setStep(EXPORT_STEP); }
  }, [unfinished, markDone]);

  const exportProject = useCallback(() => {
    try {
      const envelope = serialiseProject(doc, {
        theme: themePref, step, stepStatus, createdAt: createdAt.current,
      });
      const name = slugify(doc.project.name || "token-planner-project") || "token-planner-project";
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${name}.project.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      pushToast(`Project exported — ${name}.project.json`);
    } catch { pushToast("Export failed — try again"); }
  }, [doc, themePref, step, stepStatus, pushToast]);

  const applyProject = useCallback((payload: RestorePayload, label: string) => {
    setDoc(payload.doc);
    if (payload.theme) setThemePref(payload.theme);
    if (payload.stepStatus) setStepStatus({ ...Object.fromEntries(STEPS.map((st) => [st.id, "todo"])), ...payload.stepStatus });
    setStep(payload.step || 1);
    createdAt.current = payload.createdAt || new Date().toISOString();
    setStarted(true);
    pushToast(label);
  }, [pushToast, setThemePref]);

  const importFile = useCallback((file: File) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { pushToast("That file is too large to be a project"); return; }
    const reader = new FileReader();
    reader.onerror = () => pushToast("That file could not be read");
    reader.onload = () => {
      const result = readProjectFile(String(reader.result || ""));
      if (!result.ok) { pushToast(result.error); return; }
      applyProject(result.payload, `Imported ${result.payload.projectName || "project"}`);
    };
    try { reader.readAsText(file); } catch { pushToast("That file could not be read"); }
  }, [applyProject, pushToast]);

  const resetProject = useCallback(() => {
    /* drop the pending write for the old document, then clear the slot.
       Autosave resumes on the next tick and persists the blank project, so a
       reload can never resurrect the work that was just discarded. */
    clearTimeout(saveTimer.current);
    store.remove(PROJECT_KEY);
    setDoc(initialState());
    setStepStatus(Object.fromEntries(STEPS.map((st) => [st.id, "todo"])));
    setStep(1);
    createdAt.current = new Date().toISOString();
    setSavedAt(null);
    setConfirmReset(false);
    pushToast("Project reset successfully");
  }, [pushToast]);

  /* drag & drop anywhere in the workspace */
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  }, []);
  const onDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) importFile(file);
  }, [importFile]);

  const newProject = useCallback(() => {
    setDoc(initialState());
    setStepStatus(Object.fromEntries(STEPS.map((s) => [s.id, "todo"])));
    setStep(1);
    setStarted(true);
    pushToast("New project started");
  }, [pushToast]);

  const startFirst = useCallback(() => {
    setDoc(initialState());
    setStepStatus(Object.fromEntries(STEPS.map((s) => [s.id, "todo"])));
    setStep(1);
    setStarted(true);
  }, []);

  /* ── landing ─────────────────────────────────────────────────────────── */
  if (!started) {
    return (
      <div className="tp-app">
        <main className="landing">
          <div className="landing-mark" aria-hidden="true">TP</div>
          <h1 className="landing-title">Token Planner</h1>
          <p className="landing-desc">
            Plan a complete design-token system step by step, then export it as a ready-to-paste
            Figma CLI prompt or Token Studio JSON.
          </p>
          <div className="landing-list" aria-hidden="true">
            {["Colour", "Typography", "Scale", "Effects", "Motion", "Components"].map((t) => (
              <span className="landing-tag" key={t}>{t}</span>
            ))}
          </div>
          <div className="landing-actions">
            <Button variant="primary" onClick={startFirst}>New project</Button>
            <ThemeSwitch preference={themePref} onChange={setThemePref} />
          </div>
        </main>
      </div>
    );
  }

  const current = STEPS.find((s) => s.id === step);

  const renderStep = () => {
    switch (step) {
      case 1: return (
        <StepProject
          data={doc.project} onChange={setProject}
          onExportProject={exportProject} onImportFile={importFile}
          onResetProject={() => setConfirmReset(true)}
        />);
      case 2: return (
        <StepColor
          colorMode={doc.colorMode} setColorMode={setColorMode}
          colorBase={doc.colorBase} setColorBase={setColorBase}
          colorPalette={doc.colorPalette} setColorPalette={setColorPalette}
          semColorGroups={doc.semColorGroups} setSemColorGroups={setSemColorGroups}
          brands={doc.project.brands} mappingPref={doc.project.mappingPref}
          onToast={pushToast}
        />);
      case 3: return (
        <StepTypography
          data={doc.typography} onChange={setTypography}
          semTypoGroups={doc.semTypoGroups} setSemTypoGroups={setSemTypoGroups}
          brands={doc.project.brands}
        />);
      case 4: return (
        <StepScale data={doc.scale} onChange={setScale}
          semScaleGroups={doc.semScaleGroups} setSemScaleGroups={setSemScaleGroups} />);
      case 5: return <StepEffects data={doc.effects} onChange={setEffects} onToast={pushToast} />;
      case 6: return <StepMotion data={doc.motion} onChange={setMotion} />;
      case 7: return <StepZIndex data={doc.zIndex} onChange={setZIndex} />;
      case 8: return <StepComponents data={doc.components} onChange={setComponents} />;
      case 9: return <StepSummary state={doc} stepStatus={stepStatus} onGo={setStep} />;
      case 10: return <StepExport state={doc} onToast={pushToast} onExportProject={exportProject} onImportFile={importFile} />;
      default: return null;
    }
  };

  const phases = [...new Set(STEPS.map((st) => st.phase))];

  const statusWord = (state_: StepState) =>
    state_ === "done" ? "completed" : state_ === "skip" ? "skipped" : "not visited";

  return (
    <div
      className="tp-app"
      onDragEnter={onDragEnter}
      onDragOver={(e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <a className="skip" href="#tp-main">Skip to content</a>

      <div className="shell">
        {/* ── sidebar · desktop workspace navigation ── */}
        <aside className="sidebar">
          <div className="side-brand">
            <div className="brand-mark" aria-hidden="true">TP</div>
            <div className="min0">
              <div className="brand-name">Token Planner</div>
              <div className="brand-serial">{doc.project.serial}</div>
            </div>
          </div>

          <nav className="side-nav" aria-label="Wizard steps">
            {phases.map((phase) => (
              <div className="side-group" key={phase}>
                <div className="side-group-label">{phase}</div>
                {STEPS.filter((st) => st.phase === phase).map((st) => {
                  const state_ = stepStatus[st.id];
                  const isCurrent = st.id === step;
                  return (
                    <button
                      key={st.id}
                      type="button"
                      className="side-item"
                      data-state={state_}
                      aria-current={isCurrent ? "step" : undefined}
                      onClick={() => setStep(st.id)}
                    >
                      <span className="dot" aria-hidden="true">
                        {state_ === "done" ? "✓" : state_ === "skip" ? "–" : ""}
                      </span>
                      <span className="side-item-label">{st.label}</span>
                      <span className="sr-only">— {statusWord(state_)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="side-foot">
            <div className="side-progress">
              <div className="side-progress-label">
                <span>Progress</span>
                <span>{settled}/{totalTrackable}</span>
              </div>
              <div
                className="meter-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={totalTrackable}
                aria-valuenow={settled}
                aria-label="Steps settled"
              >
                <div className="meter-fill" style={{ width: `${(settled / totalTrackable) * 100}%` }} />
              </div>
            </div>
            <Button size="sm" className="btn-block" onClick={newProject}>New project</Button>
            <ProjectFileActions
              compact
              onExport={exportProject}
              onImportFile={importFile}
              onReset={() => setConfirmReset(true)}
            />
          </div>
        </aside>

        {/* ── workspace ── */}
        <div className="workspace">
          <header className="topbar">
            <div className="topbar-left">
              <div className="brand-mark" aria-hidden="true" style={{ marginRight: 2 }}>TP</div>
              <input
                className="project-name"
                value={doc.project.name ?? ""}
                onChange={(e) => setProject({ ...doc.project, name: e.target.value })}
                placeholder="Untitled project"
                aria-label="Project name"
              />
              <span className="crumb-sep" aria-hidden="true">/</span>
              <span className="crumb-step">{current?.label}</span>
            </div>
            <div className="topbar-right">
              <SaveStatus status={saveState} savedAt={savedAt} persistent={storageOk.current} />
              <ThemeSwitch preference={themePref} onChange={setThemePref} />
              <Button size="sm" onClick={newProject} data-tip="Start an empty project">New</Button>
            </div>
          </header>

          {/* mobile / tablet step rail */}
          <nav className="rail" ref={railRef} aria-label="Wizard steps">
            {STEPS.map((st) => {
              const state_ = stepStatus[st.id];
              const isCurrent = st.id === step;
              return (
                <button
                  key={st.id}
                  type="button"
                  ref={isCurrent ? activeStepRef : null}
                  className="step-btn"
                  data-state={state_}
                  aria-current={isCurrent ? "step" : undefined}
                  onClick={() => setStep(st.id)}
                >
                  <span className="dot" aria-hidden="true">
                    {state_ === "done" ? "✓" : state_ === "skip" ? "–" : ""}
                  </span>
                  <span>{st.short}</span>
                  <span className="sr-only">{st.label} — {statusWord(state_)}</span>
                </button>
              );
            })}
          </nav>

          <main className="main" id="tp-main" ref={mainRef} tabIndex={-1} aria-labelledby="tp-step-title">
            <h1 className="sr-only" id="tp-step-title">{current?.label} — step {step} of {STEPS.length}</h1>
            <div className="step-view" key={step}>{renderStep()}</div>
          </main>

      {step !== EXPORT_STEP && (
        <div className="footbar">
          <div className="footbar-inner">
            <Button size="sm" data-tip="Mark this step as skipped and move on"
              onClick={() => { markSkip(step); setStep(Math.min(step + 1, EXPORT_STEP)); }}>
              Skip
            </Button>
            <div className="row-nowrap">
              <Button size="sm" onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1}>Back</Button>
              {step < LAST_EDIT_STEP ? (
                <Button size="sm" variant="primary" onClick={() => { markDone(step); setStep(step + 1); }}>Next</Button>
              ) : (
                <Button size="sm" variant="primary" data-tip="Generate the prompt and JSON" onClick={goExport}>Export</Button>
              )}
            </div>
          </div>
        </div>
      )}
        </div>
      </div>

      {showIncomplete && (
        <IncompleteModal
          steps={unfinished}
          onSkip={(id) => { markSkip(id); }}
          onGo={(id) => { setShowIncomplete(false); setStep(id); }}
          onClose={() => setShowIncomplete(false)}
          onProceed={() => { setShowIncomplete(false); markDone(LAST_EDIT_STEP); setStep(EXPORT_STEP); }}
        />
      )}

      {confirmReset && (
        <ConfirmDialog
          title="Reset this project?"
          body="Every token, mapping and component in this project will be cleared and the saved session removed. This action cannot be undone — export the project first if you might want it back."
          confirmLabel="Reset project"
          onConfirm={resetProject}
          onCancel={() => setConfirmReset(false)}
        />
      )}

      {dragging && (
        <div className="dropzone" aria-hidden="true">
          <div className="dropzone-inner">
            <div className="dropzone-title">Drop to open project</div>
            <div className="dropzone-desc">Release a .project.json file exported from Token Planner.</div>
          </div>
        </div>
      )}

      <div aria-live="polite" role="status">
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <TokenPlanner />
    </ErrorBoundary>
  );
}
