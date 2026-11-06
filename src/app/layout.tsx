import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "./components/theme-provider";

// NOTE: Geist/Geist Mono were previously registered via next/font but their CSS
// variables were never referenced, so every element was rendered with
// Tailwind's default system font stack. Removing them keeps the identical
// rendering while dropping the dead font work entirely.

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
