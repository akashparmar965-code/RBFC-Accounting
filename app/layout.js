import "./globals.css";

export const metadata = {
  title: "Accounting Dashboard",
  description: "Store master data and accounting file processing",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
