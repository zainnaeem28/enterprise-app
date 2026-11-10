import type { ReactNode } from 'react';
import { AppBar, MaintenanceBanner, SkipLink } from '@ehr/ui';
import type { SiteBanner } from '../directory.js';
import { SITE_NAME } from '../seo.js';

const NAV = [
  { href: '/about', label: 'About' },
  { href: '/services', label: 'Services' },
  { href: '/doctors', label: 'Find a doctor' },
  { href: '/locations', label: 'Locations' },
  { href: '/contact', label: 'Contact' },
] as const;

const FOOTER = [
  { href: '/about', label: 'About' },
  { href: '/legal/privacy', label: 'Privacy' },
  { href: '/legal/terms', label: 'Terms' },
  { href: '/legal/cookies', label: 'Cookies' },
  { href: '/legal/accessibility', label: 'Accessibility statement' },
] as const;

export function Layout({
  current,
  bookHref,
  banners = [],
  children,
}: {
  current: string;
  bookHref: string;
  banners?: SiteBanner[];
  children: ReactNode;
}) {
  return (
    <>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <AppBar portalName="Visit us" productName={SITE_NAME}>
        <nav aria-label="Main" className="site-nav">
          <ul>
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href} aria-current={current === n.href ? 'page' : undefined}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <a className="ehr-btn ehr-btn--primary site-book" href={bookHref} data-book>
          Book appointment
        </a>
      </AppBar>
      {banners.map((b) => (
        <MaintenanceBanner key={b.id}>{b.message}</MaintenanceBanner>
      ))}
      <main id="main" className="site-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <p className="site-emergency">If this is an emergency, call 911.</p>
        <nav aria-label="Footer">
          <ul>
            {FOOTER.map((n) => (
              <li key={n.href}>
                <a href={n.href}>{n.label}</a>
              </li>
            ))}
            <li>
              <button type="button" className="site-linkbtn" data-cookie-settings>
                Cookie settings
              </button>
            </li>
          </ul>
        </nav>
        <p>© {SITE_NAME}</p>
      </footer>
    </>
  );
}
