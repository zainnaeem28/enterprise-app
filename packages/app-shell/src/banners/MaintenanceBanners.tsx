import { useEffect, useState } from 'react';
import { MaintenanceBanner } from '@ehr/ui';
import type { createApiClient } from '../api/client.js';

type Api = ReturnType<typeof createApiClient>;

export interface BannerItem {
  id: string;
  message: string;
}

/** `GET /api/v1/banners`: current maintenance banners for the caller's portal (C0, no PHI). A failed read shows nothing. */
export async function loadBanners(api: Api): Promise<BannerItem[]> {
  try {
    const { data } = await api.GET('/api/v1/banners', { params: { header: api.header } });
    return (data?.items ?? []).map((b) => ({ id: b.id, message: b.message }));
  } catch {
    return [];
  }
}

/** Renders the current maintenance banners above the page content; renders nothing when there are none. */
export function MaintenanceBanners({ api }: { api: Api }) {
  const [items, setItems] = useState<BannerItem[]>([]);
  useEffect(() => {
    let live = true;
    void loadBanners(api).then((b) => {
      if (live) setItems(b);
    });
    return () => {
      live = false;
    };
  }, [api]);
  return (
    <>
      {items.map((b) => (
        <MaintenanceBanner key={b.id}>{b.message}</MaintenanceBanner>
      ))}
    </>
  );
}
