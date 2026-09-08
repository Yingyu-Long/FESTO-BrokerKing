import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Repair task export · Smartenance',
  description:
    'Filter Smartenance repair tasks by machine and creation date, then export CSV.',
  robots: { index: false, follow: false },
  icons: {
    icon: { url: '/brand-icon.png', type: 'image/png', sizes: '48x48' },
  },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
