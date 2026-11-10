/**
 * SwarmIntro.tsx — Swarm Rebuild intro orchestrator.
 *
 * Runs the full choreography imperatively (this component renders null):
 *
 *   1. Policy check (state/policy.ts) — skip rules, profile, seed
 *   2. Hide the page (visibility:hidden — zero CLS, no flash)
 *   3. Capture: hidden sweep + world-coords item snapshot
 *   4. Mount the stage + cursor swarm + controls
 *   5. Engine drives everything until the build completes
 *   6. Finale → cross-fade finalReveal → cleanup
 *
 * Fail-safe contract (§4.7): any throw before capture → intro never
 * engages; any throw after the body is hidden → revealNow() immediately
 * (idempotent, ≤100 ms). StrictMode-safe: effect re-runs re-check the
 * session flag.
 */

"use client";

import { useEffect } from "react";
import { resolvePolicy, PROFILE_CONFIG } from "./state/policy";
import { hasPlayed, markPlayed, resetPlayed, isSoundEnabled } from "./state/session";
import { captureItems } from "./capture/snapshot";
import {
  hideBody,
  revealNow,
  finalReveal,
  onRevealComplete,
  registerOverlayHost,
  watchResizeAbort,
} from "./build/reveals";
import { View } from "./build/overlay";
import { Engine } from "./build/scheduler";
import { SoundEngine } from "./fx/sound";
import { mountControls, setControlsPhase, unmountControls } from "./fx/controls";

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** Lightweight stage telemetry for live diagnostics (all builds, tiny). */
function stage(name: string): void {
  try {
    (window as unknown as Record<string, unknown>).__swarmStage = name;
  } catch {
    /* ignore */
  }
}

export function SwarmIntro() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let disposed = false;
    let engine: Engine | null = null;
    const sound = new SoundEngine();
    const disposers: Array<() => void> = [];

    function runDisposers() {
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
      disposers.length = 0;
    }

    function cleanup() {
      if (disposed) return;
      disposed = true;
      engine?.abort();
      engine = null;
      runDisposers();
      unmountControls();
      sound.disable();
    }

    // ── Global listeners ────────────────────────────────────────────────
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        revealNow();
        cleanup();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    disposers.push(() => document.removeEventListener("keydown", onKeyDown));

    function onVisibility() {
      if (document.visibilityState === "hidden") engine?.pause();
      else engine?.resume();
    }
    document.addEventListener("visibilitychange", onVisibility);
    disposers.push(() => document.removeEventListener("visibilitychange", onVisibility));

    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) {
        revealNow();
        cleanup();
      }
    }
    window.addEventListener("pageshow", onPageShow);
    disposers.push(() => window.removeEventListener("pageshow", onPageShow));

    onRevealComplete(cleanup);

    // ── Main async run ──────────────────────────────────────────────────
    async function run() {
      try {
        const policy = resolvePolicy(hasPlayed());
        if (policy.profile === "skip") {
          if (process.env.NODE_ENV === "development") {
            console.log(`[SwarmIntro] Skipped: ${policy.skipReason}`);
          }
          return;
        }
        if (policy.isReplay) resetPlayed();
        markPlayed();
        stage("policy-play");

        const config = PROFILE_CONFIG[policy.profile];

        // 1. Hide the page BEFORE capturing so the sweep/capture is invisible.
        hideBody();
        stage("hidden");

        // 2. Capture (includes the hidden scroll sweep).
        stage("capturing");
        const capture = await captureItems();
        if (disposed) return;
        stage("captured");
        if (process.env.NODE_ENV === "development") {
          console.log(
            `[SwarmIntro] capture: ${capture.items.length} items, ${capture.groups.length} groups, doc ${capture.docW}x${capture.docH}`
          );
        }

        // 3. Stage + swarm + controls.
        const view = new View();
        view.mount(capture.bgColor, capture.docW, capture.docH);
        registerOverlayHost(view.host);

        engine = new Engine(view, sound, capture, config, policy.seed, {
          onComplete: () => {
            void handleComplete();
          },
          onFail: (err) => {
            console.error("[SwarmIntro] engine error:", err);
            revealNow();
            cleanup();
          },
        });

        engine.buildPlan();
        engine.start();
        stage("engine-started");

        // The engine's pre-start flock follows the user's pointer.
        const onPointerMove = (e: PointerEvent) => engine?.setMouse(e.clientX, e.clientY);
        const onPointerLeave = () => engine?.clearMouse();
        window.addEventListener("pointermove", onPointerMove, { passive: true });
        document.documentElement.addEventListener("pointerleave", onPointerLeave);
        disposers.push(() => {
          window.removeEventListener("pointermove", onPointerMove);
          document.documentElement.removeEventListener("pointerleave", onPointerLeave);
        });

        // 4. Controls.
        mountControls({
          onSkip: () => {
            revealNow();
            cleanup();
          },
          onReplay: () => {
            cleanup();
            const url = new URL(window.location.href);
            url.searchParams.set("replay", "1");
            window.location.assign(url.toString());
          },
          onSoundToggle: (enabled) => {
            if (enabled) sound.enable();
            else sound.disable();
          },
          phase: "intro",
        });

        // Sound requires a user gesture; arm it for the first interaction.
        if (isSoundEnabled() || policy.soundPreload) {
          const arm = () => {
            sound.enable();
            document.removeEventListener("pointerdown", arm);
          };
          document.addEventListener("pointerdown", arm, { once: true });
          disposers.push(() => document.removeEventListener("pointerdown", arm));
        }

        // 5. Viewport drift → abort (geometry snapshot becomes invalid).
        disposers.push(
          watchResizeAbort(() => {
            revealNow();
            cleanup();
          })
        );

        // ── Completion: finale → cross-fade reveal ─────────────────────────
        async function handleComplete() {
          try {
            sound.playCompletion();
            setControlsPhase("post", {
              onSkip: () => {
                revealNow();
                cleanup();
              },
              onReplay: () => {
                cleanup();
                const url = new URL(window.location.href);
                url.searchParams.set("replay", "1");
                window.location.assign(url.toString());
              },
              onSoundToggle: () => {},
              phase: "post",
            });

            // Let the finale play out (agents converge → launch).
            let guard = 0;
            while (engine && !engine.isFinaleDone() && guard < 400) {
              await nextFrame();
              guard++;
            }

            stage("revealing");
            finalReveal();
            stage("revealed");
          } catch (err) {
            console.error("[SwarmIntro] completion error:", err);
            revealNow();
            cleanup();
          }
        }
      } catch (err) {
        console.error("[SwarmIntro] unexpected error:", err);
        revealNow();
        cleanup();
      }
    }

    void run();

    return () => {
      revealNow();
      cleanup();
    };
  }, []);

  return null;
}

export default SwarmIntro;
