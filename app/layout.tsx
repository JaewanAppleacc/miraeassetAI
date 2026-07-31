import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DART Corpus Viewer",
  description: "공시 코퍼스 로컬 열람 도구",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
