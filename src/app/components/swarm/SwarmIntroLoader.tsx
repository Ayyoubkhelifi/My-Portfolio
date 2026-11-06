"use client";

/**
 * SwarmIntroLoader.tsx — Client component wrapper for dynamic import.
 *
 * Next.js 15.5 App Router requires that `ssr: false` dynamic imports
 * live inside a 'use client' boundary. This thin wrapper provides that.
 */

import dynamic from "next/dynamic";

const SwarmIntroLazy = dynamic(
  () => import("./SwarmIntro"),
  { ssr: false }
);

export default function SwarmIntroLoader() {
  return <SwarmIntroLazy />;
}
