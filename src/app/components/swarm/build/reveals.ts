/**
 * reveals.ts — Reveal and abort helpers for the Swarm Rebuild overlay.
 *
 * All reveal operations flow through this module. The key contract:
 *   - revealNow() is idempotent, runs in ≤ 100 ms, callable at ANY point.
 *   - finalReveal() is the happy-path 380ms cross-fade.
 *   - Both restore body visibility and remove the overlay from the DOM.
 *
 * Zero setTimeout/setInterval — timing is rAF + master clock offsets.
 */

// ─── Shared overlay reference (injected by overlay.tsx on mount) ──────────────

let _overlayHost: HTMLElement | null = null;
let _revealCalled = false;

/** Called by overlay.tsx to register the host element for cleanup. */
export function registerOverlayHost(host: HTMLElement): void {
  _overlayHost = host;
  _revealCalled = false;
}

/** Diagnostic: was revealNow() called? Used by integrity.ts. */
export function wasRevealCalled(): boolean {
  return _revealCalled;
}

// ─── Body show/hide ───────────────────────────────────────────────────────────

/**
 * Hides the page body (via visibility: hidden, not display: none).
 * Preserves layout and prevents reflow/CLS; positions overlay over it.
 */
export function hideBody(): void {
  document.body.style.visibility = "hidden";
}

/**
 * Unhides the page body. Idempotent.
 */
export function showBody(): void {
  document.body.style.visibility = "";
}

// ─── revealNow — emergency / skip / abort path ───────────────────────────────

/**
 * Immediately reveals the page and removes the overlay.
 * Idempotent — safe to call multiple times and from any error handler.
 * Guaranteed to run in ≤ 100 ms (no animations).
 */
export function revealNow(): void {
  if (_revealCalled) return;
  _revealCalled = true;

  // 1. Show the page
  showBody();

  // 2. Remove the overlay host from the DOM
  if (_overlayHost && _overlayHost.isConnected) {
    _overlayHost.remove();
  }
  _overlayHost = null;

  // 3. Cancel scroll lock (if active)
  cancelScrollLock();

  // 4. Notify any registered cleanup callbacks
  for (const cb of _cleanupCallbacks) {
    try { cb(); } catch { /* ignore */ }
  }
  _cleanupCallbacks.length = 0;
}

// ─── finalReveal — happy-path cross-fade ─────────────────────────────────────

/**
 * Performs the 380ms cross-fade reveal (happy path after full animation).
 * Fades the overlay from opacity 0.96 → 0 while making the body visible,
 * then removes the overlay host after the transition completes.
 *
 * Uses rAF for the animation (no setTimeout).
 */
export function finalReveal(): void {
  if (_revealCalled) return;
  _revealCalled = true;

  // Show the real page under the overlay immediately
  showBody();

  // Cancel scroll lock
  cancelScrollLock();

  // Fade the overlay out
  const host = _overlayHost;
  if (!host) {
    // No overlay to fade — notify cleanup and done
    _fireCleanup();
    return;
  }

  // The overlay's inner element (the shadow host container)
  const inner = host.firstElementChild as HTMLElement | null;
  if (!inner) {
    host.remove();
    _overlayHost = null;
    _fireCleanup();
    return;
  }

  // Start fade animation via rAF
  const DURATION = 380; // ms
  let startTime: number | null = null;

  function animateFade(ts: number) {
    if (startTime === null) startTime = ts;
    const elapsed = ts - startTime;
    const t = Math.min(elapsed / DURATION, 1);

    // Ease-out: opacity goes from 0.96 → 0
    const opacity = 0.96 * (1 - t);
    host!.style.opacity = opacity.toString();

    if (t < 1) {
      requestAnimationFrame(animateFade);
    } else {
      // Animation complete — remove overlay
      if (host!.isConnected) host!.remove();
      _overlayHost = null;
      _fireCleanup();
    }
  }

  requestAnimationFrame(animateFade);
}

// ─── clipReveal — excluded large-node region ──────────────────────────────────

/**
 * Reveals a clip-region placeholder by fading in the real node.
 * The placeholder div (injected into the overlay by nodes.tsx) fades out
 * while the real node becomes visible through the body reveal cascade.
 *
 * In practice this is called per-excluded-node during the finale wave,
 * just before finalReveal().
 */
export function clipReveal(placeholderEl: HTMLElement, delayMs: number = 0): void {
  // Schedule with a rAF offset instead of setTimeout
  const start = performance.now() + delayMs;

  function check(now: number) {
    if (now < start) {
      requestAnimationFrame(check);
      return;
    }
    // Fade out the placeholder
    const FADE = 200;
    let t0: number | null = null;
    function fade(ts: number) {
      if (t0 === null) t0 = ts;
      const t = Math.min((ts - t0) / FADE, 1);
      placeholderEl.style.opacity = (1 - t).toString();
      if (t < 1) requestAnimationFrame(fade);
      else placeholderEl.remove();
    }
    requestAnimationFrame(fade);
  }

  requestAnimationFrame(check);
}

// ─── groupReveal — budget-overflow whole-subtree ──────────────────────────────

/**
 * Reveals a group of elements (budget overflow) as a single fade+unmask unit.
 * All elements in the group animate together.
 */
export function groupReveal(
  elements: HTMLElement[],
  startAtMs: number,
  durationMs: number = 400
): void {
  // Hide all initially
  for (const el of elements) {
    el.style.opacity = "0";
    el.style.clipPath = "inset(100% 0 0 0)";
  }

  const start = performance.now() + startAtMs;

  function check(now: number) {
    if (now < start) {
      requestAnimationFrame(check);
      return;
    }
    let t0: number | null = null;
    function animate(ts: number) {
      if (t0 === null) t0 = ts;
      const t = Math.min((ts - t0) / durationMs, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      for (const el of elements) {
        el.style.opacity = eased.toString();
        const inset = Math.round((1 - eased) * 100);
        el.style.clipPath = `inset(${inset}% 0 0 0)`;
      }
      if (t < 1) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(check);
}

// ─── Scroll lock ──────────────────────────────────────────────────────────────

let _scrollLockActive = false;

function preventScroll(e: Event) {
  e.preventDefault();
}

export function engageScrollLock(): void {
  if (_scrollLockActive) return;
  _scrollLockActive = true;
  window.addEventListener("scroll", preventScroll, { passive: false });
  window.addEventListener("touchmove", preventScroll, { passive: false });
}

export function cancelScrollLock(): void {
  if (!_scrollLockActive) return;
  _scrollLockActive = false;
  window.removeEventListener("scroll", preventScroll);
  window.removeEventListener("touchmove", preventScroll);
}

// ─── Cleanup registry ─────────────────────────────────────────────────────────

const _cleanupCallbacks: Array<() => void> = [];

/** Register a cleanup callback to fire when reveal completes. */
export function onRevealComplete(cb: () => void): void {
  _cleanupCallbacks.push(cb);
}

function _fireCleanup(): void {
  for (const cb of _cleanupCallbacks) {
    try { cb(); } catch { /* ignore */ }
  }
  _cleanupCallbacks.length = 0;
}
