/**
 * SwarmIntro.tsx — Swarm Rebuild intro orchestrator.
 *
 * The single entry-point React component. Renders null on the server.
 * On the client, manages the full intro lifecycle:
 *
 *   1. Eligibility check (policy.ts)
 *   2. Wait for readiness (FCP + fonts + hero settle)
 *   3. Snapshot the DOM (capture/snapshot.ts)
 *   4. Mount overlay (build/overlay.tsx)
 *   5. Build plan (build/scheduler.ts)
 *   6. Run agents + cursor canvas (agents/)
 *   7. Play routines (build/routines.ts)
 *   8. Finale → finalReveal
 *   9. Integrity check (diagnostics/integrity.ts)
 *  10. Cleanup
 *
 * Fail-safe contract (§4.7):
 *   - Any throw before body is hidden → intro never engages (log + no-op)
 *   - Any throw after body hidden → revealNow() immediately (≤ 100 ms)
 *   - revealNow() is idempotent (safe to call from any handler, any number of times)
 */

"use client";

import { useEffect } from "react";
import { resolvePolicy, PROFILE_CONFIG } from "./state/policy";
import { hasPlayed, markPlayed, resetPlayed, isSoundEnabled } from "./state/session";
import { waitForReadiness, snapshotDOM } from "./capture/snapshot";
import { mountOverlay, unmountOverlay, watchResize } from "./build/overlay";
import { Scheduler } from "./build/scheduler";
import { initRoutines } from "./build/routines";
import { revealNow, finalReveal, onRevealComplete } from "./build/reveals";
import { CursorManager } from "./agents/cursors";
import { PointerLayer, CursorType } from "./agents/pointerLayer";
import { SoundEngine } from "./fx/sound";
import { mountControls, setControlsPhase, unmountControls } from "./fx/controls";
import { runIntegrityChecks } from "./diagnostics/integrity";

// ─── Main component ───────────────────────────────────────────────────────────

export function SwarmIntro() {
  useEffect(() => {
    // Server-side safety (belt-and-suspenders; 'use client' already guards this)
    if (typeof window === "undefined") return;

    let cleanedUp = false;
    let schedulerRef: Scheduler | null = null;
    let pointerLayerRef: PointerLayer | null = null;
    const soundEngine = new SoundEngine();
    const cleanupCallbacks: Array<() => void> = [];

    // ── Cleanup handler (idempotent) ──────────────────────────────────────
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      schedulerRef?.abort();
      pointerLayerRef?.dispose();
      unmountControls();
      unmountOverlay();
      soundEngine.disable();
      for (const cb of cleanupCallbacks) {
        try { cb(); } catch { /* ignore */ }
      }
    }

    // ── Global keyboard handler ───────────────────────────────────────────
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        revealNow();
        cleanup();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    cleanupCallbacks.push(() => document.removeEventListener("keydown", onKeyDown));

    // ── Tab visibility handler ────────────────────────────────────────────
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        schedulerRef?.pause();
      } else {
        schedulerRef?.resume();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    cleanupCallbacks.push(() =>
      document.removeEventListener("visibilitychange", onVisibilityChange)
    );

    // ── Back-forward cache: skip on restored sessions ─────────────────────
    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) {
        revealNow();
        cleanup();
      }
    }
    window.addEventListener("pageshow", onPageShow);
    cleanupCallbacks.push(() => window.removeEventListener("pageshow", onPageShow));

    // ── Main async run ────────────────────────────────────────────────────
    async function run() {
      try {
        // 1. Policy check
        const played = hasPlayed();
        const policy = resolvePolicy(played);

        if (policy.profile === "skip") {
          if (process.env.NODE_ENV === "development") {
            console.log(`[SwarmIntro] Skipped: ${policy.skipReason}`);
          }
          return;
        }

        // Reset played flag if replay requested
        if (policy.isReplay) {
          resetPlayed();
        }

        const profileConfig = PROFILE_CONFIG[policy.profile];

        if (process.env.NODE_ENV === "development") {
          console.log(`[SwarmIntro] Starting — profile: ${policy.profile}, seed: ${policy.seed}`);
        }

        // 2. Wait for readiness (FCP + fonts + hero settle)
        await waitForReadiness();

        // After readiness, any error must call revealNow()
        // Mark played now so crashes don't re-trigger on reload
        markPlayed();

        // 3. Snapshot the DOM
        let snapshot;
        try {
          snapshot = await snapshotDOM();
        } catch (err) {
          console.error("[SwarmIntro] Snapshot failed:", err);
          revealNow();
          cleanup();
          return;
        }

        // 4. Mount overlay + init routines
        initRoutines();

        let cursorCanvas: HTMLCanvasElement;
        let nodeRefMap: Map<number, HTMLElement>;
        try {
          const result = mountOverlay(snapshot.records);
          cursorCanvas = result.cursorCanvas;
          nodeRefMap = result.nodeRefMap;
        } catch (err) {
          console.error("[SwarmIntro] Overlay mount failed:", err);
          revealNow();
          cleanup();
          return;
        }

        // Setup resize abort
        const cancelResizeWatch = watchResize(() => {
          revealNow();
          cleanup();
        });
        cleanupCallbacks.push(cancelResizeWatch);

        // 5. Init cursor agents + pointer layer
        const pointerLayer = new PointerLayer(cursorCanvas, profileConfig.agentCount);
        pointerLayerRef = pointerLayer;

        const cursorManager = new CursorManager(
          profileConfig.agentCount,
          pointerLayer,
          policy.seed
        );
        cursorManager.init();
        pointerLayer.start();

        // 6. Mount controls
        const controlsConfig = {
          onSkip: () => { revealNow(); cleanup(); },
          onReplay: () => {
            revealNow();
            cleanup();
            // Navigate to replay
            const url = new URL(window.location.href);
            url.searchParams.set("replay", "1");
            window.location.href = url.toString();
          },
          onSoundToggle: (enabled: boolean) => {
            if (enabled) {
              soundEngine.enable();
            } else {
              soundEngine.disable();
            }
          },
          phase: "intro" as const,
        };
        mountControls(controlsConfig);

        // If sound was pre-enabled, don't auto-enable (needs gesture)
        // But listen for first pointer event if ?sound=1
        if (policy.soundPreload || isSoundEnabled()) {
          const enableOnPointer = () => {
            soundEngine.enable();
            document.removeEventListener("pointerdown", enableOnPointer);
          };
          document.addEventListener("pointerdown", enableOnPointer, { once: true });
        }

        // 7. Build plan + start scheduler
        const scheduler = new Scheduler({
          profile: profileConfig,
          seed: policy.seed,
          nodeRefMap,
          onAgentMove: (agentIdx, x, y, cursorType) => {
            cursorManager.moveAgent(agentIdx, x, y, cursorType as CursorType);
          },
          onAgentClick: (agentIdx, x, y) => {
            cursorManager.clickAgent(agentIdx, x, y);
            soundEngine.playGrab();
          },
          onComplete: async () => {
            // Finale: agents converge and fly away
            cursorManager.startFinale();
            soundEngine.playCompletion();

            // Switch controls to post-intro mode (replay button)
            setControlsPhase("post", controlsConfig);

            // Wait for finale animation (cursors flying away)
            await new Promise<void>((resolve) => {
              const checkFinale = () => {
                if (cursorManager.isFinaleComplete()) {
                  resolve();
                } else {
                  requestAnimationFrame(checkFinale);
                }
              };
              requestAnimationFrame(checkFinale);
            });

            // Final reveal
            finalReveal();

            // Run integrity checks (dev only)
            runIntegrityChecks(snapshot);

            // Hide controls after 5s
            setTimeout(() => {
              unmountControls();
              cleanup();
            }, 5_000);
          },
          onError: (err) => {
            console.error("[SwarmIntro] Scheduler error:", err);
            revealNow();
            cleanup();
          },
        });

        schedulerRef = scheduler;

        // Wait for React nodes to mount (next frame)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        scheduler.buildPlan(snapshot.records);
        scheduler.start();

      } catch (err) {
        // Any unexpected error after mount → reveal immediately
        console.error("[SwarmIntro] Unexpected error:", err);
        revealNow();
        cleanup();
      }
    }

    // Register cleanup with the reveal system
    onRevealComplete(cleanup);

    // Start the run
    run();

    // React cleanup (component unmount)
    return () => {
      revealNow();
      cleanup();
    };
  }, []); // Run once on mount

  // Renders nothing — the overlay is mounted imperatively on documentElement
  return null;
}

export default SwarmIntro;
