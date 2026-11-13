import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "./components/theme-provider";

// NOTE: Geist/Geist Mono were previously registered via next/font but their CSS
// variables were never referenced, so every element was rendered with
// Tailwind's default system font stack. Removing them keeps the identical
// rendering while dropping the dead font work entirely.

/**
 * Swarm pre-show guard — runs inline (parser-blocking) BEFORE the first paint.
 *
 * When this page load is going to play the intro (mirrors SwarmIntro's
 * resolvePolicy skip rules; fail-open: if in doubt, do nothing), it:
 *   1. disables scroll restoration and forces the top — the reload "scroll
 *      jump" the user sees before the animation never happens;
 *   2. hides the body and paints the intro backdrop (navy + grid) on the
 *      <html> element itself, so the very first frame is already the intro
 *      surface — no page content, no scrolling, ever;
 *   3. arms a fail-safe that un-hides the page if the overlay never mounts
 *      (failed chunk, policy mismatch, etc.) so the site always renders.
 */
const SWARM_PRESHOW = `(function () {
  try {
    var q = location.search;
    var replay = /(?:^|[?&])replay=1(?:&|$)/.test(q);
    if (/(?:^|[?&])noSwarm=1(?:&|$)/.test(q)) return;
    try { if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; } catch (e) {}
    try {
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn && conn.saveData) return;
    } catch (e) {}
    try {
      var cores = navigator.hardwareConcurrency || 4;
      var mem = navigator.deviceMemory || 4;
      if (!replay && (cores <= 2 || mem <= 2)) return;
    } catch (e) {}
    var played = null;
    try { played = sessionStorage.getItem("swarm.played"); } catch (e) {}
    if (played && !replay) return;

    try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}
    window.scrollTo(0, 0);

    var st = document.createElement("style");
    st.id = "swarm-preshow";
    st.textContent =
      "html.swarm-pending{background-color:#000319!important;" +
      "background-image:linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px)," +
      "linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px)!important;" +
      "background-size:40px 40px!important;" +
      "background-attachment:fixed!important;" +
      "scrollbar-color:transparent transparent;}" +
      "html.swarm-pending::-webkit-scrollbar{background:transparent;}" +
      "html.swarm-pending::-webkit-scrollbar-thumb{background:transparent;}" +
      "html.swarm-pending::-webkit-scrollbar-track{background:transparent;}" +
      "html.swarm-pending>body{opacity:0!important;}";
    document.head.appendChild(st);
    document.documentElement.classList.add("swarm-pending");

    var tries = 0;
    var clear = function () {
      document.documentElement.classList.remove("swarm-pending");
      var s = document.getElementById("swarm-preshow");
      if (s && s.parentNode) s.parentNode.removeChild(s);
    };
    var tick = function () {
      if (document.querySelector("[data-swarm-host]")) return; // overlay took over
      if (++tries >= 40) clear();
      else setTimeout(tick, 500);
    };
    if (document.readyState === "complete") setTimeout(tick, 500);
    else window.addEventListener("load", function () { setTimeout(tick, 500); });
    window.addEventListener("pagehide", clear);
  } catch (e) {}
})();`;


export const metadata: Metadata = {
  metadataBase: new URL("https://ayyoub-khelifi.vercel.app"),
  title: "Ayyoub Khelifi",
  description: "Cyber Security Engineer And Full Stack Dev",
  openGraph: {
    title: "Ayyoub Khelifi",
    description: "Cyber Security Engineer And Full Stack Dev",
    type: "website",
    url: "/",
  },
  twitter: {
    card: "summary",
    title: "Ayyoub Khelifi",
    description: "Cyber Security Engineer And Full Stack Dev",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html suppressHydrationWarning lang="en">
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: SWARM_PRESHOW }} />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          forcedTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
          enableColorScheme
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
