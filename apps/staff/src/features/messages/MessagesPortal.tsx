import { useMemo, useState } from 'react';
import { ErrorState, LoadingState, OfflineBanner, Tabs } from '@ehr/ui';
import type { ShellRuntime } from '@ehr/app-shell';
import { createMessagesApi } from './api.js';
import { MessagesContext } from './MessagesContext.js';
import { Tasks } from './Tasks.js';
import { Threads } from './Threads.js';
import { useDoctorSession } from '../doctor/session.js';
import { useOnline } from '../doctor/DoctorContext.js';
import { msgStrings as s } from './strings.js';
import './messages.css';

/** The one path this feature serves (the navigation item "Tasks & messages" already points here). It carries no record identifier. */
export const MESSAGES_PATHS = ['/tasks'] as const;
export type MessagesPath = (typeof MESSAGES_PATHS)[number];
export const isMessagesPath = (path: string): path is MessagesPath =>
  (MESSAGES_PATHS as readonly string[]).includes(path);

type Section = 'tasks' | 'messages';

/**
 * Tasks & messages for staff (FE-12, DR-08). Permissions only decide what is drawn; the server authorizes every call and applies the
 * participant, assignee and organisation rules.
 */
export function MessagesPortal({ runtime }: { runtime: Pick<ShellRuntime, 'api'> }) {
  const sessionLoad = useDoctorSession(runtime);
  const api = useMemo(() => createMessagesApi(runtime.api), [runtime.api]);
  const online = useOnline();
  const [section, setSection] = useState<Section>('tasks');

  if (sessionLoad.kind === 'loading') return <LoadingState label={s.title} lines={4} />;
  if (sessionLoad.kind === 'error')
    return <ErrorState kind="server" onRetry={() => window.location.reload()} />;
  const ready = sessionLoad.session;
  const ctx = {
    api,
    can: (p: string) => ready.permissions.includes(p),
    principalId: ready.principalId,
    locationIds: ready.locationIds,
    online,
  };

  return (
    <MessagesContext.Provider value={ctx}>
      <h1>{s.title}</h1>
      {!online && <OfflineBanner />}
      <Tabs
        label={s.tabsLabel}
        selected={section}
        onSelect={(id) => setSection(id as Section)}
        items={[
          { id: 'tasks', label: s.tabTasks, panel: <Tasks /> },
          { id: 'messages', label: s.tabMessages, panel: <Threads /> },
        ]}
      />
    </MessagesContext.Provider>
  );
}
