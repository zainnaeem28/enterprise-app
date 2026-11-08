// A recording in-memory terminology source for tests: it proves OUR side of the port (chunking, resume, idempotence), NOT the NLM/UMLS
// download, which needs the licence account (C-09). Contains only synthetic concepts the test supplies.
import type { SourceChunk, SourceConcept, TerminologySource } from './terminology-load.js';

export class InMemoryTerminologySource implements TerminologySource {
  readonly calls: { system: string; release: string; cursor: string | null; limit: number }[] = [];
  /** Throw on the nth call (1-based) to simulate a crash between chunks; cleared once thrown. */
  failOnCall: number | undefined;
  private readonly releases = new Map<string, SourceConcept[]>();

  set(system: string, release: string, concepts: SourceConcept[]): void {
    this.releases.set(`${system}:${release}`, concepts);
  }

  read(
    system: string,
    release: string,
    cursor: string | null,
    limit: number,
  ): Promise<SourceChunk> {
    this.calls.push({ system, release, cursor, limit });
    if (this.failOnCall === this.calls.length) {
      this.failOnCall = undefined;
      return Promise.reject(new Error('simulated source failure'));
    }
    const all = this.releases.get(`${system}:${release}`);
    if (all === undefined) return Promise.reject(new Error('no such release'));
    const from = cursor === null ? 0 : Number(cursor);
    const slice = all.slice(from, from + limit);
    const end = from + slice.length;
    return Promise.resolve({ concepts: slice, next: end >= all.length ? null : String(end) });
  }
}
