import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Clinical Reasoning Study",
  description:
    "A research study of clinical reasoning and diagnostic decisions.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
