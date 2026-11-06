/**
 * controls.tsx — Unobtrusive skip / replay / sound toggle controls.
 *
 * Renders inside the shadow root (via getShadowRoot()) so zero site CSS
 * classes leak. The control cluster is 3 circle buttons (36px), bottom-right,
 * visible during the intro and for 5s after completion.
 *
 * Per §4.10:
 *   - Icon-only + title/aria-label (accessible)
 *   - `Esc` hardcoded in SwarmIntro.tsx (not here)
 *   - Zero site classes used
 */

"use client";

import React, { useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { getShadowRoot } from "../build/overlay";
import { isSoundEnabled, setSoundEnabled } from "../state/session";

// ─── SVG icons (original vector paths — not copied from reference) ────────────

const SkipIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path d="M4 4L14 9L4 14V4Z" fill="currentColor" />
    <rect x="13" y="4" width="2" height="10" rx="1" fill="currentColor" />
  </svg>
);

const ReplayIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path
      d="M9 3C5.69 3 3 5.69 3 9s2.69 6 6 6 6-2.69 6-6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      fill="none"
    />
    <path d="M13 5L15 3L15 7H11L13 5Z" fill="currentColor" />
  </svg>
);

const SoundOnIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path
      d="M5 7H3V11H5L9 14V4L5 7Z"
      fill="currentColor"
    />
    <path
      d="M11 7C11.6 7.5 12 8.2 12 9C12 9.8 11.6 10.5 11 11"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      fill="none"
    />
    <path
      d="M13 5C14.2 6.2 15 7.5 15 9C15 10.5 14.2 11.8 13 13"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      fill="none"
    />
  </svg>
);

const SoundOffIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path d="M5 7H3V11H5L9 14V4L5 7Z" fill="currentColor" />
    <path
      d="M12 7L15 10M15 7L12 10"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

// ─── Control Button ───────────────────────────────────────────────────────────

interface BtnProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

function CtrlBtn({ onClick, title, children }: BtnProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 36,
        height: 36,
        borderRadius: "50%",
        border: "1px solid rgba(148,163,184,0.3)",
        backgroundColor: "rgba(15,23,42,0.85)",
        backdropFilter: "blur(8px)",
        color: "#94a3b8",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background-color 0.15s, color 0.15s",
        outline: "none",
        padding: 0,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(30,41,59,0.95)";
        (e.currentTarget as HTMLButtonElement).style.color = "#e2e8f0";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(15,23,42,0.85)";
        (e.currentTarget as HTMLButtonElement).style.color = "#94a3b8";
      }}
    >
      {children}
    </button>
  );
}

// ─── Controls component ───────────────────────────────────────────────────────

interface ControlsProps {
  onSkip: () => void;
  onReplay: () => void;
  phase: "intro" | "post"; // intro = showing during run; post = replay+sound for 5s
  onSoundToggle: (enabled: boolean) => void;
}

function Controls({ onSkip, onReplay, phase, onSoundToggle }: ControlsProps) {
  const [soundOn, setSoundOn] = useState(isSoundEnabled());

  const handleSoundClick = () => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundEnabled(next);
    onSoundToggle(next);
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        display: "flex",
        gap: 8,
        zIndex: 2,
        pointerEvents: "all",
      }}
    >
      {phase === "intro" && (
        <CtrlBtn onClick={onSkip} title="Skip intro (Esc)">
          <SkipIcon />
        </CtrlBtn>
      )}
      {phase === "post" && (
        <CtrlBtn onClick={onReplay} title="Replay intro">
          <ReplayIcon />
        </CtrlBtn>
      )}
      <CtrlBtn
        onClick={handleSoundClick}
        title={soundOn ? "Mute sound" : "Enable sound"}
      >
        {soundOn ? <SoundOnIcon /> : <SoundOffIcon />}
      </CtrlBtn>
    </div>
  );
}

// ─── Mount / unmount helpers ──────────────────────────────────────────────────

let _controlsRoot: Root | null = null;
let _controlsContainer: HTMLElement | null = null;

export interface ControlsConfig {
  onSkip: () => void;
  onReplay: () => void;
  onSoundToggle: (enabled: boolean) => void;
  phase: "intro" | "post";
}

/** Mount the controls cluster into the shadow root */
export function mountControls(config: ControlsConfig): void {
  const shadow = getShadowRoot();
  if (!shadow) return;

  if (!_controlsContainer) {
    _controlsContainer = document.createElement("div");
    _controlsContainer.setAttribute("data-swarm-controls", "1");
    shadow.appendChild(_controlsContainer);
  }

  _controlsRoot = createRoot(_controlsContainer);
  _controlsRoot.render(
    <Controls
      onSkip={config.onSkip}
      onReplay={config.onReplay}
      phase={config.phase}
      onSoundToggle={config.onSoundToggle}
    />
  );
}

/** Update the controls phase (intro → post) */
export function setControlsPhase(phase: "intro" | "post", config: ControlsConfig): void {
  if (!_controlsRoot || !_controlsContainer) {
    mountControls({ ...config, phase });
    return;
  }
  _controlsRoot.render(
    <Controls
      onSkip={config.onSkip}
      onReplay={config.onReplay}
      phase={phase}
      onSoundToggle={config.onSoundToggle}
    />
  );
}

/** Unmount and remove controls */
export function unmountControls(): void {
  if (_controlsRoot) {
    try { _controlsRoot.unmount(); } catch { /* ignore */ }
    _controlsRoot = null;
  }
  if (_controlsContainer && _controlsContainer.isConnected) {
    _controlsContainer.remove();
  }
  _controlsContainer = null;
}
