import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sydaris",
  description: "以组织记忆支持真实工作的智能协作系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
