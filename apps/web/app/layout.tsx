import type { Metadata, Viewport } from "next";
import { StudyFooter } from "@/components/study-footer";
import "./globals.css";
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};
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
      <body>
        {children}
        <StudyFooter />
      </body>
    </html>
  );
}
