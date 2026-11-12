import type { ReactNode } from 'react';
import { BrandMark, Icon, resolveBrandName, MaintenanceBanner, SkipLink } from '@ehr/ui';
import type { SiteBanner } from '../directory.js';

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

const NPP_LINK = { href: '/legal/npp', label: 'Notice of Privacy Practices' } as const;

export function Layout({
  current,
  bookHref,
  banners = [],
  siteName,
  hasNpp = false,
  children,
}: {
  current: string;
  bookHref: string;
  banners?: SiteBanner[];
  /** The organisation's name from the CMS; `null` until entered (then nothing is shown in its place). */
  siteName: string | null;
  /** The Notice of Privacy Practices has been entered in the CMS: show its link. */
  hasNpp?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <header className="site-header">
        <a className="site-brand" href="/" aria-label="Home">
          <BrandMark />
          <span>
            {resolveBrandName(siteName, 'Visit us')}
            <small>Care starts here</small>
          </span>
        </a>
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
      </header>
      {banners.map((b) => (
        <MaintenanceBanner key={b.id}>{b.message}</MaintenanceBanner>
      ))}
      <main id="main" className="site-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="site-footer__brand">
          <BrandMark />
          <div>
            <strong>{resolveBrandName(siteName, 'Visit us')}</strong>
            <p>A simpler way to connect with your care.</p>
          </div>
        </div>
        <p className="site-emergency">
          <Icon name="help" size={16} /> If this is an emergency, call 911.
        </p>
        <nav aria-label="Footer">
          <ul>
            {[...FOOTER, ...(hasNpp ? [NPP_LINK] : [])].map((n) => (
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
        {siteName !== null && <p>© {siteName}</p>}
      </footer>
    </>
  );
}
