import type { ReactElement } from 'react';
import { brand } from './brand';

// Login and nav branding. BRAND-BRIEF 1: no brand files, product name or palette have been supplied yet (C-16), so
// these are the placeholder tokens in ./brand.ts. Supplying the brand later changes brand.ts only.
export function Logo(): ReactElement {
  return (
    <div className="ehr-brand" role="img" aria-label={brand.name}>
      <span className="ehr-brand__mark" aria-hidden="true">
        {brand.initial}
      </span>
      <span className="ehr-brand__name">{brand.name}</span>
    </div>
  );
}

export function Icon(): ReactElement {
  return (
    <span className="ehr-brand__mark ehr-brand__mark--icon" role="img" aria-label={brand.name}>
      {brand.initial}
    </span>
  );
}
