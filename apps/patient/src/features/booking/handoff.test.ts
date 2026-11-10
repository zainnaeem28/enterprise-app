import { describe, expect, it, vi } from 'vitest';
import { emptyDraft } from './context.js';
import { readHandoff, seedDraft } from './handoff.js';
import type { Service } from './types.js';

const S = '33333333-3333-4333-8333-333333333333';
const D = '55555555-5555-4555-8555-555555555555';
const services: Service[] = [{ id: S, name: 'General', durationMin: 30, mode: 'video' }];
const api = (ids: string[], ok = true) => ({
  doctors: vi.fn(async () =>
    ok
      ? { ok: true as const, data: ids.map((clinicianId) => ({ clinicianId, displayName: 'Dr' })) }
      : { ok: false as const, status: 500, code: 'x', alternatives: [] },
  ),
});
const q = (s: string) => readHandoff(new URLSearchParams(s));

describe('readHandoff', () => {
  it('keeps UUIDs lowercased and ignores everything else', () => {
    expect(q(`serviceId=${S.toUpperCase()}&clinicianId=${D}&x=1`)).toEqual({
      serviceId: S,
      clinicianId: D,
    });
    expect(q('serviceId=abc&clinicianId=<script>')).toEqual({
      serviceId: undefined,
      clinicianId: undefined,
    });
    expect(q('')).toEqual({ serviceId: undefined, clinicianId: undefined });
  });
});

describe('seedDraft', () => {
  it('applies a bookable service and its mode', async () => {
    const a = api([D]);
    const d = await seedDraft({ serviceId: S, clinicianId: undefined }, services, a, emptyDraft);
    expect(d).toMatchObject({ serviceId: S, clinicianId: undefined, mode: 'video' });
    expect(a.doctors).not.toHaveBeenCalled();
  });
  it('applies the doctor when the service offers them (case-insensitive)', async () => {
    const d = await seedDraft(
      { serviceId: S, clinicianId: D },
      services,
      api([D.toUpperCase()]),
      emptyDraft,
    );
    expect(d.clinicianId).toBe(D.toUpperCase());
  });
  it('drops a doctor who does not offer the service, or a failed lookup', async () => {
    const h = { serviceId: S, clinicianId: D };
    expect((await seedDraft(h, services, api([]), emptyDraft)).clinicianId).toBeUndefined();
    expect((await seedDraft(h, services, api([], false), emptyDraft)).serviceId).toBe(S);
  });
  it('drops an unknown service, and a doctor without a service', async () => {
    const a = api([D]);
    const other = '99999999-9999-4999-8999-999999999999';
    expect(await seedDraft({ serviceId: other, clinicianId: D }, services, a, emptyDraft)).toBe(
      emptyDraft,
    );
    expect(await seedDraft({ serviceId: undefined, clinicianId: D }, services, a, emptyDraft)).toBe(
      emptyDraft,
    );
    expect(a.doctors).not.toHaveBeenCalled();
  });
});
