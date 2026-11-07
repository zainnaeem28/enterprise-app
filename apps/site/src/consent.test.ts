// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readChoice } from './consent.js';
import { createConsent } from './consent.js';
import { sanitise } from './analytics.js';

const env = () => ({
  document,
  analyticsSrc: 'https://analytics.example.net/a.js',
  template: 'doctor-profile' as const,
  secure: true,
});
const scripts = () => [...document.querySelectorAll('script')].map((s) => s.src);
const layer = () => (window as unknown as { dataLayer?: unknown[] }).dataLayer;

beforeEach(() => {
  document.head.innerHTML = '';
  document.cookie = 'site_consent=; Max-Age=0; Path=/';
  delete (window as unknown as { dataLayer?: unknown }).dataLayer;
});

describe('cookie consent (TC-BS-08)', () => {
  it('loads nothing and records nothing before a choice', () => {
    const c = createConsent(env());
    c.start();
    c.track({ event: 'page_view', template: 'home' });
    expect(scripts()).toEqual([]);
    expect(layer()).toBeUndefined();
  });
  it('"Essential only" loads nothing and is remembered', () => {
    const c = createConsent(env());
    c.choose('essential');
    expect(scripts()).toEqual([]);
    expect(readChoice(document.cookie)).toBe('essential');
    createConsent(env()).start();
    expect(scripts()).toEqual([]);
  });
  it('"Accept all" loads analytics once, and a later visit loads it again without asking', () => {
    const c = createConsent(env());
    c.choose('all');
    c.choose('all');
    expect(scripts()).toEqual(['https://analytics.example.net/a.js']);
    expect(layer()).toEqual([{ event: 'page_view', template: 'doctor-profile' }]);
    document.head.innerHTML = '';
    createConsent(env()).start();
    expect(scripts()).toEqual(['https://analytics.example.net/a.js']);
  });
  it('withdrawing stops events and clears the queue', () => {
    const c = createConsent(env());
    c.choose('all');
    c.choose('essential');
    c.track({ event: 'book_click', template: 'home' });
    expect(layer()).toEqual([]);
  });
  it('with no analytics configured, "all" loads no script at all', () => {
    createConsent({ ...env(), analyticsSrc: null }).choose('all');
    expect(scripts()).toEqual([]);
  });
});

describe('analytics payload allow-list (TC-BS-04)', () => {
  it('keeps only event and template', () => {
    expect(
      sanitise({
        event: 'page_view',
        template: 'home',
        name: 'Jane',
        dob: '1980-01-01',
        path: '/doctors/abc',
      }),
    ).toEqual({
      event: 'page_view',
      template: 'home',
    });
  });
  it('drops unknown events and free-text templates', () => {
    expect(sanitise({ event: 'search', template: 'home' })).toBeNull();
    expect(sanitise({ event: 'page_view', template: 'Dr. Jane Doe, oncology' })).toBeNull();
    expect(sanitise(null)).toBeNull();
  });
});
