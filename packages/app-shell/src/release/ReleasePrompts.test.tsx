import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { AlertsPausedBar, ReleasePrompts } from './ReleasePrompts.js';
import { ReleaseStore } from './release-store.js';
import { releaseStrings as s } from './strings.js';

afterEach(cleanup);

function setup(newer = true) {
  const reload = vi.fn();
  const store = new ReleaseStore({
    clientRelease: 'r10.aaaaaaaaaaaa',
    fetchManifest: async () => ({ release_number: newer ? 11 : 10 }),
    reload,
  });
  return { store, reload };
}

describe('non-blocking bar', () => {
  it('announces politely, reloads at once without unsaved input', async () => {
    const { store, reload } = setup();
    render(<ReleasePrompts store={store} />);
    await act(() => store.poll());
    expect(screen.getByRole('status')).toHaveTextContent(s.barText);
    fireEvent.click(screen.getByRole('button', { name: s.reload }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('with unsaved input asks first, naming forms and never content', async () => {
    const { store, reload } = setup();
    render(<ReleasePrompts store={store} />);
    await act(async () => {
      await store.poll();
      store.setForms([{ name: 'Visit note' }]);
    });
    expect(screen.getByRole('status')).toHaveTextContent(s.barUnsaved);
    fireEvent.click(screen.getByRole('button', { name: s.reload }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Visit note');
    expect(screen.getByRole('button', { name: s.stay })).toHaveFocus();
    expect(screen.queryByRole('button', { name: s.saveAndReload })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: s.reloadAnyway }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('offers save-and-reload only where a draft route exists, and stays on failure', async () => {
    const { store, reload } = setup();
    render(<ReleasePrompts store={store} />);
    await act(async () => {
      await store.poll();
      store.setForms([{ name: 'Visit note', saveDraft: async () => false }]);
    });
    fireEvent.click(screen.getByRole('button', { name: s.reload }));
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names.slice(-3)).toEqual([s.saveAndReload, s.stay, s.reloadAnyway]);
    fireEvent.click(screen.getByRole('button', { name: s.saveAndReload }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(s.saveFailed));
    expect(reload).not.toHaveBeenCalled();
  });

  it('remind me later hides the bar', async () => {
    const { store } = setup();
    render(<ReleasePrompts store={store} />);
    await act(() => store.poll());
    fireEvent.click(screen.getByRole('button', { name: s.remindLater }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('blocking dialog', () => {
  it('pulls focus back when it escapes the dialog (backdrop click)', async () => {
    const { store } = setup();
    render(<ReleasePrompts store={store} />);
    act(() => store.refuse('req-8'));
    const reloadBtn = screen.getByRole('button', { name: s.reload });
    expect(reloadBtn).toHaveFocus();
    await act(async () => {
      reloadBtn.blur();
      await Promise.resolve();
    });
    expect(reloadBtn).toHaveFocus();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(reloadBtn).toHaveFocus();
    outside.remove();
  });

  it('opens on refusal with the exact text, request id and no auto reload', () => {
    const { store, reload } = setup();
    render(<ReleasePrompts store={store} />);
    act(() => store.refuse('req-7'));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(s.blockedText);
    expect(dialog).toHaveTextContent('req-7');
    expect(screen.getByRole('button', { name: s.reload })).toHaveFocus();
    expect(reload).not.toHaveBeenCalled();
  });

  it('keep-open shows the red bar and closes the dialog', () => {
    const { store } = setup();
    render(<ReleasePrompts store={store} />);
    act(() => store.refuse());
    fireEvent.click(screen.getByRole('button', { name: s.keepOpen }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(s.keepOpenBar);
  });

  it('shows the paused-alerts bar so a refused stream never looks like no alerts', () => {
    const { store } = setup();
    render(<AlertsPausedBar store={store} />);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => store.refuse());
    expect(screen.getByRole('alert')).toHaveTextContent(s.alertsPaused);
  });
});
