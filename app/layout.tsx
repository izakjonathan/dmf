import type { Metadata, Viewport } from "next";
import "./style.css";
export const metadata: Metadata = {
  title: "Stagebook · Musician payments",
  description: "Musician registration and venue payment records.",
};
export const viewport: Viewport = { themeColor: "#1a1e3a" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
