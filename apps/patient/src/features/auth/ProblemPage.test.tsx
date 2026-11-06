import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemPage } from './ProblemPage.js';
import { problemCopy } from './problems.js';
import type { ProblemCode } from './problems.js';

afterEach(cleanup);

describe('every documented problem has its own state', () => {
  const codes = Object.keys(problemCopy) as ProblemCode[];
  it('has distinct titles', () => {
    expect(new Set(codes.map((c) => problemCopy[c].title)).size).toBe(codes.length);
  });
  it.each(codes)('%s: titled, focused, announced, with a way forward', (code) => {
    const onRetry = vi.fn();
    const onSignIn = vi.fn();
    render(
      <ProblemPage problem={{ code, requestId: 'req-9' }} onRetry={onRetry} onSignIn={onSignIn} />,
    );
    const heading = screen.getByRole('heading', { name: problemCopy[code].title });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(problemCopy[code].body);
    expect(screen.getByText('req-9')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    if (problemCopy[code].action === 'retry') expect(onRetry).toHaveBeenCalledOnce();
    else expect(onSignIn).toHaveBeenCalledOnce();
  });
  it('mentions neither passwords nor codes to type', () => {
    for (const c of codes) expect(JSON.stringify(problemCopy[c])).not.toMatch(/password|one-time/i);
  });
});
