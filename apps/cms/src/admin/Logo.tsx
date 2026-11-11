import type { ReactElement } from 'react';
import { brand } from './brand';

// Login and nav branding, read from ./brand.ts (organisation name from configuration, neutral title when none is entered).
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
