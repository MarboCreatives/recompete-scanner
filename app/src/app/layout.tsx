// The frame every page sits in.
//
// The header and footer are here because ITERATION-0-SPEC section 5 asked for
// them and they were never built. Without them every page had to carry its own
// way out, which is why the pages are full of "Back to the start" links, and it
// is why a link that looked like plain text left a person with nowhere to go.
//
// Neither reads a cookie or touches the database, on purpose. The landing page,
// the privacy policy, the sent page and the deleted page are prerendered, and a
// session read in this file would make every one of them dynamic.

import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Canadian Recompete Radar',
  description: 'Follow federal contracts coming up for renewal, and the suppliers who hold them.',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="site-header">
            <Link href="/">Canadian Recompete Radar</Link>
          </header>

          {children}

          <footer className="site-footer">
            <p>Canadian Recompete Radar</p>
            <p>PO Box 1184, Pembroke, Ontario K8A 6Y6</p>
            <p>
              <Link href="/privacy">Privacy</Link> ·{' '}
              <a href="https://recompeteradar.ca">recompeteradar.ca</a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  )
}
