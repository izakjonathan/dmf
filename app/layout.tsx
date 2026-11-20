import type { Metadata } from "next";
import "./style.css";
export const metadata: Metadata = {
  title: "Stagebook · Musician payments",
  description: "Musician registration and venue payment records.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
