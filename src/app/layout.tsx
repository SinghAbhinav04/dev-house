import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

import { readRoster } from '@/lib/team/roster';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Hackeroom',
  description: 'Claude with its own dev team — members you create, on the models you choose.',
};

/**
 * The theme is stored with the roster, so it is read on the server and stamped
 * onto <html> before first paint. Setting it client-side would show the default
 * theme for a frame and then swap, which reads as a flash.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let theme = 'warm';
  try {
    theme = readRoster().theme || 'warm';
  } catch {
    // A missing or unreadable roster just means the default theme.
  }

  return (
    <html lang="en" data-theme={theme}>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <div className="min-h-screen bg-surface text-ink">
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
