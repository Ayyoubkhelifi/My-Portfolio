# Task: Integrate Swarm Rebuild-style Website Construction Animation Into Existing Portfolio

## PRIMARY OBJECTIVE

I already have a fully developed personal portfolio website. I want to integrate a highly faithful recreation of the visual construction animation used by the **Swarm Rebuild Chrome extension** (Dhvanil Patel).

The animation must play automatically when visitors open my portfolio, making it look as though multiple intelligent cursors are collaboratively reconstructing the entire website in real time.

IMPORTANT: This is a visual simulation. No actual AI agents or API calls are required.

**THE MOST IMPORTANT REQUIREMENT: DO NOT CHANGE, REDESIGN, RESTRUCTURE, REWRITE, OR DAMAGE MY EXISTING PORTFOLIO IN ANY WAY.**

The existing website must look exactly the same before and after the animation. Only the introductory construction experience should be added.

## PHASE 1 — RESEARCH AND UNDERSTAND THE REFERENCE

Before coding:

1. Thoroughly inspect the existing project and understand its framework, routing, components, styles, animations, and architecture.
2. Study the Swarm Rebuild Chrome extension and its original Swarm animation project.
3. Inspect their publicly available source code, where accessible.
4. Understand the actual animation mechanism, including:
   - DOM inspection and visual snapshots.
   - Element positioning and dimensions.
   - Multiple cursor movement and coordination.
   - Component construction animations.
   - Text typing and image placement.
   - Rectangle drawing and resizing.
   - Selection outlines and resize handles.
   - Cursor movement patterns and physics.
   - Sound effects and animation timing.
5. Identify which techniques can be recreated in my existing framework.
6. Check source-code licenses before reusing any implementation. Reimplement behavior independently where necessary.

Do not start implementing until you understand the existing portfolio and have an implementation plan.

Reference:
https://github.com/DhvanilPatel/swarm-cursors

## PHASE 2 — PRESERVE THE EXISTING WEBSITE

This is a strict constraint.

- Do not modify the existing design system.
- Do not change colors, fonts, typography, spacing, layouts, backgrounds, borders, or gradients.
- Do not replace existing components.
- Do not modify existing content.
- Do not change navigation or routing.
- Do not remove existing functionality.
- Do not replace existing animations.
- Do not introduce a new visual theme.
- Do not change responsive behavior.
- Do not introduce unnecessary dependencies.

Inspect the original website and capture its current visual state before making changes.

The animation must work as an independent layer on top of the existing portfolio.

If possible, keep all new implementation inside a separate directory and integrate it through a minimal entry point.

## PHASE 3 — IMPLEMENT THE ACTUAL CONSTRUCTION MECHANISM

Do not create ordinary decorative cursor animations.

Recreate the visual behavior of Swarm Rebuild.

### A. DOM inspection and snapshot

Before starting the animation, inspect the rendered portfolio and create a visual snapshot.

Capture relevant information for visible elements:

- DOM hierarchy.
- Bounding rectangles.
- Position and dimensions.
- Computed background colors.
- Borders and border radii.
- Typography and text content.
- Images and their dimensions.
- SVGs and icons.
- Shadows and opacity.
- Parent-child relationships.
- Z-index and stacking information.

Handle dynamically rendered components, fonts, images, and responsive layouts correctly.

Use the actual rendered website as the reconstruction reference rather than hardcoded coordinates.

### B. Construction overlay

Create a completely isolated animation overlay.

The overlay must:

- Cover the viewport without changing document layout.
- Reconstruct the original page visually.
- Use an isolated CSS environment, preferably Shadow DOM where appropriate.
- Preserve the original page's scroll position.
- Avoid CSS conflicts with the website.
- Avoid modifying the underlying React component tree unnecessarily.
- Support responsive viewport dimensions.

Capture everything needed before visually hiding the original page.

The original page must be restored perfectly when the animation finishes or is interrupted.

### C. Multiple cursor swarm

Recreate the extension's multiple-cursor visual language.

Implement a coordinated swarm of cursors with:

- Distinct cursor designs and colors.
- Smooth, natural movement.
- Independent movement paths.
- Coordinated trajectories.
- Click and drag animations.
- Cursor trails where appropriate.
- Selection behavior.
- Movement synchronization.
- Natural acceleration and deceleration.
- Appropriate movement timing.

Do not use simple linear movement or random cursor positions.

Reproduce the characteristic swarm movement, distribution, gathering, and coordinated interactions of the reference.

### D. Element reconstruction animations

Implement different animation routines according to element type.

**Text:**
- Cursor moves to the correct position.
- Creates a text area.
- Text appears progressively, as if being typed.
- Typography matches the original.

**Containers and rectangles:**
- Cursor selects the target area.
- Dragging motion creates the rectangle.
- Dimensions progressively match the original element.
- Background, borders, radius and other styling appear.

**Images:**
- Cursor moves to the image position.
- Creates the image placeholder.
- Image progressively reveals itself.
- Final dimensions and cropping match the original.

**Cards and repeated elements:**
- Build parent containers first.
- Reconstruct child elements.
- Use coordinated duplication-style animations for repeated structures.

**Borders and alignment:**
- Animate border drawing.
- Display temporary alignment guides and rulers.
- Show selection boundaries and resize handles.
- Reproduce the visual editing behavior of the reference.

**Icons and SVGs:**
- Reconstruct or reveal them accurately without distorting their shapes.

### E. Dependency-aware animation scheduling

Build a centralized animation scheduler.

Elements must not appear in arbitrary order.

Respect their hierarchy:

1. Main layout containers.
2. Section backgrounds.
3. Child components.
4. Text and images.
5. Borders and decorative details.
6. Final alignment and polish.

Allow multiple cursors to work simultaneously on independent elements.

Prevent conflicting animations when multiple cursors interact with the same component.

Do not use arbitrary timeouts scattered throughout components.

## PHASE 4 — AUTOMATIC INTRODUCTION

The construction experience must be enabled by default.

Expected visitor experience:

1. Visitor opens the portfolio.
2. The initial page is captured.
3. The construction overlay appears.
4. Multiple cursors enter the screen.
5. Cursors begin reconstructing the actual portfolio.
6. Sections, typography, images, cards, and other components appear progressively.
7. The entire page becomes visually complete.
8. Cursors perform their final movements and gather.
9. The overlay fades away.
10. The original portfolio becomes fully interactive.

The final result must be pixel-consistent with the original website.

Add unobtrusive controls:
- Skip animation.
- Replay construction.
- Optional sound toggle.

Do not introduce a large control panel or dashboard that changes the original design.

## PHASE 5 — SOUND EFFECTS

Study the reference sound design.

Where appropriate, reproduce subtle effects using Web Audio API or locally available sound assets:

- Cursor interaction.
- Clicking.
- Drawing.
- Element creation.
- Completion.

Sound must be optional and must never autoplay without respecting browser audio restrictions.

## PHASE 6 — PERFORMANCE AND RELIABILITY

This is essential.

The animation must not:

- Break existing interactions.
- Cause layout shifts.
- Modify the original DOM permanently.
- Leave hidden elements after completion.
- Create duplicate overlays.
- Leak event listeners.
- Leave animation frames or timers running.
- Interfere with scrolling.
- Break navigation.
- Cause hydration mismatches.
- Block the website indefinitely.

Use:
- A deterministic animation timeline.
- Proper lifecycle management.
- requestAnimationFrame where appropriate.
- Efficient DOM measurement.
- ResizeObserver where appropriate.
- Cleanup and cancellation mechanisms.
- Reduced-motion support.

Handle:
- Animation interruption.
- Browser tab visibility changes.
- Page navigation.
- Window resizing.
- Slow-loading images.
- Failed image resources.
- Mobile devices.
- Returning visitors.

If anything fails, immediately reveal the original portfolio. The website must never become inaccessible because of the animation.

## PHASE 7 — TESTING AND VISUAL VERIFICATION

Before declaring the task complete:

1. Capture screenshots of the original website.
2. Implement the animation.
3. Capture screenshots after the animation.
4. Compare the final website with the original.
5. Verify that no design elements were changed.
6. Test every section and route.
7. Test desktop, tablet, and mobile.
8. Test skip and replay.
9. Test reduced-motion settings.
10. Test browser refresh and navigation.
11. Verify that the original page is fully interactive after completion.

Use Playwright if available.

Fix all discovered bugs before finishing.

## FINAL ACCEPTANCE CRITERIA

The implementation is complete only if:

- The animation plays automatically.
- Multiple cursors behave like the reference extension.
- Cursors visibly construct the actual website.
- Different element types have appropriate construction animations.
- Multiple animations can run concurrently without conflicts.
- The final website looks exactly like my original portfolio.
- All existing website functionality remains intact.
- Skip and replay work reliably.
- No major performance or console errors exist.

Do not settle for a generic multi-cursor animation or a simple fade-in effect.

I want a faithful Swarm Rebuild-style visual reconstruction experience integrated into my existing portfolio.

## WORKING INSTRUCTIONS

Work directly in the existing repository.

First inspect and document the current architecture. Then implement the animation in isolated, reusable modules.

Do not delete or replace existing code just to simplify implementation.

Make incremental changes, verify each phase, and keep the original website working throughout development.

At the end, provide:
- Files created.
- Files modified.
- Animation architecture.
- Any limitations compared with the reference extension.
- Testing results.
- Instructions for controlling, skipping, replaying, and disabling the animation.