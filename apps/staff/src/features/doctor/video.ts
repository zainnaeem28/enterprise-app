/**
 * The only thing the doctor portal knows about video (DR-04): a vendor-neutral adapter. The vendor SDK (undecided, C-11) is
 * wrapped by an adapter that implements this; nothing here imports a vendor. The room and the host's join token come from the
 * API; the adapter gets only what it needs to show the call in a container.
 */
export interface VideoHandle {
  /** Leaves the call and releases camera and microphone. Safe to call twice. */
  leave(): Promise<void>;
}
export interface VideoAdapter {
  /** Puts the call into `container`. Rejects when the call cannot start (no token, no device, vendor down). */
  join(container: HTMLElement, session: { reservationId: string }): Promise<VideoHandle>;
}
