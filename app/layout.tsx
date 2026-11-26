import type { Metadata } from "next";
import "@festo-ui/icon-font/icons.css";
import "../src/connector/connector.css";
import "../src/c2m/c2m.css";
import "../src/debug-agent/debug-agent.css";
import "./globals.css";
export const metadata: Metadata = {
  title: "Broker King · Connector / C2M / Smartenance",
  description:
    "Unified Festo application integrating PLC & MQTT Connector, MSE6-C2M configuration, and Smartenance repair export.",
  robots: { index: false, follow: false },
  icons: {
    icon: { url: "/brand-icon.png", type: "image/png", sizes: "48x48" },
  },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
