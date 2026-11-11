import { describe, expect, it } from 'vitest';
import { route } from './render.js';
import { loadConfig } from './config.js';
import { defaultContent } from './content.js';
import type { DirectoryClient } from './directory.js';

const client = (banners?: DirectoryClient['banners']): DirectoryClient => ({
  services: async () => [],
  locations: async () => [],
  clinicians: async () => [],
  nextAvailable: async () => ({ state: 'unknown' }),
  ...(banners === undefined ? {} : { banners }),
});

describe('site banner rendering', () => {
  const content = defaultContent;
  const config = loadConfig(
    {
      SITE_ORIGIN: 'https://www.example.test',
      PATIENT_ORIGIN: 'https://my.example.test',
      PUBLIC_API_ORIGIN: 'https://api.example.test',
    },
    '/nonexistent',
  );
  it('renders the message on a page and nothing when there is none', async () => {
    const withB = await route('/', {
      config,
      content,
      client: client(async () => [{ id: 'a', message: 'Planned maintenance tonight' }]),
    });
    expect(withB.html).toContain('Planned maintenance tonight');
    const without = await route('/', { config, content, client: client(async () => []) });
    expect(without.html).not.toContain('Planned maintenance');
  });
});
