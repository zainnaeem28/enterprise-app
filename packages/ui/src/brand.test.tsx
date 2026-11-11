import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandWordmark, resolveBrandName } from './brand.js';

describe('brand', () => {
  it('shows the configured organisation name', () => {
    render(<BrandWordmark name={resolveBrandName('  Example Clinic ', 'Patient portal')} />);
    expect(screen.getByText('Example Clinic')).toBeInTheDocument();
  });
  it('falls back to the neutral product title when no name is entered', () => {
    expect(resolveBrandName(undefined, 'Patient portal')).toBe('Patient portal');
    expect(resolveBrandName('   ', 'Staff portal')).toBe('Staff portal');
  });
  it('renders no "placeholder" text', () => {
    const { container } = render(<BrandWordmark name={resolveBrandName(null, 'Staff portal')} />);
    expect(container.textContent ?? '').not.toMatch(/placeholder/i);
  });
});
