import type { Metadata } from "next";
import { Lexend, Public_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const lexend = Lexend({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });
const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-body", weight: ["400", "500", "600"] });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "Loop",
  description: "Event-driven order, loyalty & retention platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${lexend.variable} ${publicSans.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
