import { RealmBar } from '@ehr/app-shell';
import type { ShellRuntime } from '@ehr/app-shell';
import { ElevationChip } from './ElevationChip.js';
import type { ElevationStore } from './elevation.js';

/**
 * The app bar of every admin screen: the fixed rust banner "Administrator sign-in. Clinical data is not available here.", the realm
 * switch ("Sign out to switch to staff", which saves drafts first where a screen registered a draft route and warns about what
 * cannot be kept) and the "Elevated until" chip. Banner, switch and draft handling are the shell's `RealmBar` and `SessionStore`;
 * this adds only the chip.
 */
export function AdminRealmBar({
  runtime,
  elevation,
  productName,
  displayName,
}: {
  runtime: Pick<ShellRuntime, 'session'>;
  elevation: ElevationStore;
  productName: string;
  displayName?: string;
}) {
  return (
    <RealmBar
      realm="admin"
      productName={productName}
      store={runtime.session}
      {...(displayName === undefined ? {} : { displayName })}
    >
      <ElevationChip store={elevation} />
    </RealmBar>
  );
}
