/**
 * policy.ts — Eligibility rules, profile detection, and URL flags.
 *
 * Determines whether the Swarm Rebuild intro should play, in what profile,
 * and what storage keys / URL overrides apply.
 *
 * All reads are side-effect-free and SSR-safe (typeof window guards used
 * at call sites; this module must be imported only inside a 'use client'
 * boundary or useEffect).
 */

// ─── Storage keys ────────────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  /** sessionStorage — intro already played in this tab */
  PLAYED: "swarm.played",
  /** localStorage — user toggled sound on/off */
  SOUND: "swarm.sound",
  /** localStorage — user hard-disabled the intro */
  DISABLED: "swarm.disabled",
} as const;

// ─── Profiles ─────────────────────────────────────────────────────────────────

export type SwarmProfile =
  | "desktop"   // 4 agents, full element budget, 9–14 s
  | "mid"       // 3 agents, reduced budget, 9–12 s
  | "mobile"    // 2–3 agents, element budget 120, 6–8 s
  | "skip";     // intro disabled

export interface PolicyResult {
  profile: SwarmProfile;
  /** Human-readable reason if profile === 'skip' */
  skipReason?: string;
  /** Seed for deterministic choreography (logged once) */
  seed: number;
  /** True if URL ?replay=1 was present */
  isReplay: boolean;
  /** True if URL ?sound=1 was present */
  soundPreload: boolean;
}

// ─── URL flag helpers ─────────────────────────────────────────────────────────

function getURLParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

export function isHardDisabledByURL(): boolean {
  return getURLParam("noSwarm") === "1";
}

export function isReplayRequested(): boolean {
  return getURLParam("replay") === "1";
}

export function isSoundPreloaded(): boolean {
  return getURLParam("sound") === "1";
}

// ─── Hardware / browser guards ────────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function prefersReducedData(): boolean {
  if (typeof navigator === "undefined") return false;
  // @ts-expect-error — connection is non-standard but widely supported
  const conn = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;
  return conn?.saveData === true;
}

function isLowEndDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const cores = navigator.hardwareConcurrency ?? 4;
  // @ts-expect-error — deviceMemory is non-standard
  const mem = navigator.deviceMemory ?? 4;
  return cores <= 2 || mem <= 2;
}

function isMobile(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < 768;
}

function isMidSize(): boolean {
  if (typeof window === "undefined") return false;
  const w = window.innerWidth;
  return w >= 768 && w < 1280;
}

// ─── Main eligibility decision ────────────────────────────────────────────────

/**
 * Evaluates all eligibility guards and returns the resolved profile.
 *
 * Call this inside a useEffect or after mount — never on the server.
 */
export function resolvePolicy(sessionPlayed: boolean): PolicyResult {
  const isReplay = isReplayRequested();
  const soundPreload = isSoundPreloaded();

  // Stable seed: use a simple hash of the current date (day-level) so
  // the same choreography plays throughout a single day's testing.
  const seed = Math.floor(Date.now() / 86_400_000);

  const base: Omit<PolicyResult, "profile" | "skipReason"> = {
    seed,
    isReplay,
    soundPreload,
  };

  // --- Hard disables (never overridden by ?replay=1) ---

  if (isHardDisabledByURL()) {
    return { ...base, profile: "skip", skipReason: "?noSwarm=1 URL flag" };
  }

  if (prefersReducedMotion()) {
    return {
      ...base,
      profile: "skip",
      skipReason: "prefers-reduced-motion media query",
    };
  }

  if (prefersReducedData()) {
    return {
      ...base,
      profile: "skip",
      skipReason: "Save-Data / Data Saver active",
    };
  }

  if (!isReplay && isLowEndDevice()) {
    return {
      ...base,
      profile: "skip",
      skipReason: "low-end device (hardwareConcurrency ≤ 2 or deviceMemory ≤ 2)",
    };
  }

  // --- Session guard (overrideable by ?replay=1) ---

  if (sessionPlayed && !isReplay) {
    return {
      ...base,
      profile: "skip",
      skipReason: "already played in this tab (swarm.played)",
    };
  }

  // --- Profile selection ---

  if (isMobile()) {
    return { ...base, profile: "mobile" };
  }
  if (isMidSize()) {
    return { ...base, profile: "mid" };
  }
  return { ...base, profile: "desktop" };
}

// ─── Profile constants ────────────────────────────────────────────────────────

export interface ProfileConfig {
  agentCount: number;
  /** Max individual element animations (overflow → group-reveal) */
  elementBudget: number;
  /** Target total duration in seconds */
  durationTarget: number;
  /** Max duration clamp in seconds */
  durationMax: number;
}

export const PROFILE_CONFIG: Record<Exclude<SwarmProfile, "skip">, ProfileConfig> = {
  desktop: {
    agentCount: 4,
    elementBudget: 350,
    durationTarget: 12,
    durationMax: 14,
  },
  mid: {
    agentCount: 3,
    elementBudget: 200,
    durationTarget: 10,
    durationMax: 12,
  },
  mobile: {
    agentCount: 2,
    elementBudget: 120,
    durationTarget: 7,
    durationMax: 8,
  },
};
