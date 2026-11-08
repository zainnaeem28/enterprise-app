// A scriptable stand-in for `EventSource`, used by the unit tests and the browser harness (the real stream is checked in one test).
import type { StreamLike } from './alerts.js';

export class FakeStream implements StreamLike {
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private l = new Map<string, Array<(e: MessageEvent) => void>>();
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), cb]);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  emit(type: string) {
    (this.l.get(type) ?? []).forEach((cb) => cb(new MessageEvent(type)));
  }
  refuse() {
    this.readyState = 2;
    this.onerror?.(new Event('error'));
  }
  drop() {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }
}
