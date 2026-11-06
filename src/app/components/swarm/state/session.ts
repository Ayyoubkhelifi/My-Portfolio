/**
 * session.ts — SSR-safe persistence helpers.
 *
 * All reads/writes are guarded against SSR (typeof window checks).
 * sessionStorage is used for tab-scoped state; localStorage for
 * user preferences that persist across tabs/sessions.
 *
 * Import this only inside a 'use client' boundary or useEffect.
 */

import { STORAGE_KEYS } from "./policy";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeSessionGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // quota exceeded or private mode — silently ignore
  }
}

function safeLocalGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota exceeded or private mode — silently ignore
  }
}

// ─── Played state ─────────────────────────────────────────────────────────────

/**
 * Returns true if the intro has already played in this browser tab.
 * Uses sessionStorage so each new tab gets a fresh play.
 */
export function hasPlayed(): boolean {
  return safeSessionGet(STORAGE_KEYS.PLAYED) === "1";
}

/**
 * Marks the intro as played for this tab session.
 * Call once right before the intro starts (not after, to handle crashes).
 */
export function markPlayed(): void {
  safeSessionSet(STORAGE_KEYS.PLAYED, "1");
}

/**
 * Resets the played flag (used by ?replay=1 flow).
 */
export function resetPlayed(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEYS.PLAYED);
  } catch {
    // ignore
  }
}

// ─── Sound preference ─────────────────────────────────────────────────────────

/**
 * Returns true if the user has explicitly enabled sound.
 * Default is OFF (no autoplay concerns beyond the toggle gate).
 */
export function isSoundEnabled(): boolean {
  return safeLocalGet(STORAGE_KEYS.SOUND) === "on";
}

/**
 * Persists the user's sound preference.
 */
export function setSoundEnabled(enabled: boolean): void {
  safeLocalSet(STORAGE_KEYS.SOUND, enabled ? "on" : "off");
}

// ─── Hard-disabled flag ───────────────────────────────────────────────────────

/**
 * Returns true if the user (or developer) has permanently disabled the intro
 * via localStorage.swarm.disabled = "1".
 */
export function isDisabled(): boolean {
  return safeLocalGet(STORAGE_KEYS.DISABLED) === "1";
}

/**
 * Programmatically disable the intro (developer convenience).
 */
export function setDisabled(disabled: boolean): void {
  if (disabled) {
    safeLocalSet(STORAGE_KEYS.DISABLED, "1");
  } else {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(STORAGE_KEYS.DISABLED);
    } catch {
      // ignore
    }
  }
}
