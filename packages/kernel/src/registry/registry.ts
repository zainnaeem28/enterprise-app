// Participant registries (ARCHITECTURE 22.16, 24). They exist before any consumer: the merge job (BE-09) and the
// privacy export (BE-20) iterate them and own no per-module logic. A duplicate module is refused; listing is in
// module-name order so a run does not depend on import order.

import type { Tx } from '../scope/with-scope.js';

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

const MODULE = /^[a-z][a-z0-9_]*$/;

export interface MergeCounts {
  table: string;
  found: number;
  repointed: number;
  resolved: number;
  kept: number;
  /** Content of every deleted row, for `patient.merge_residue` (22.16 step 3). */
  deleted: unknown[];
}

export interface ConflictRule {
  table: string;
  /** Human-readable rule from the 22.16 table: kept as data so the merge report can name it. */
  rule: string;
}

export interface MergeParticipant {
  module: string;
  tables: readonly string[];
  repointPatient(
    tx: Tx,
    mergedId: string,
    survivorId: string,
    requestId: string,
  ): Promise<MergeCounts[]>;
  conflictRules: readonly ConflictRule[];
}

export interface ExportContributor {
  module: string;
  /** Returns one export part; the privacy module assembles them. */
  exportPart(tx: Tx, patientIds: readonly string[], requestId: string): Promise<unknown>;
}

class ModuleRegistry<T extends { module: string }> {
  private readonly items = new Map<string, T>();
  constructor(private readonly what: string) {}

  add(item: T): void {
    if (typeof item.module !== 'string' || !MODULE.test(item.module))
      throw new RegistryError(`${this.what}: bad module name`);
    if (this.items.has(item.module))
      throw new RegistryError(`${this.what} for module ${item.module} already registered`);
    this.items.set(item.module, item);
  }

  list(): readonly T[] {
    return [...this.items.values()].sort((a, b) =>
      a.module < b.module ? -1 : a.module > b.module ? 1 : 0,
    );
  }

  clear(): void {
    this.items.clear();
  }
}

export class ParticipantRegistries {
  private readonly merge = new ModuleRegistry<MergeParticipant>('merge participant');
  private readonly exports = new ModuleRegistry<ExportContributor>('export contributor');

  registerMergeParticipant(p: MergeParticipant): void {
    if (p.tables.length === 0) throw new RegistryError('merge participant must name its tables');
    const seen = new Set<string>();
    for (const t of p.tables) {
      if (!t.startsWith(`${p.module}.`))
        throw new RegistryError(`table ${t} is not in schema ${p.module}`);
      if (seen.has(t)) throw new RegistryError(`table ${t} listed twice`);
      seen.add(t);
    }
    for (const r of p.conflictRules) {
      if (!seen.has(r.table))
        throw new RegistryError(`conflict rule names unlisted table ${r.table}`);
    }
    this.merge.add({ ...p, tables: [...p.tables], conflictRules: [...p.conflictRules] });
  }

  registerExportContributor(c: ExportContributor): void {
    this.exports.add(c);
  }

  mergeParticipants(): readonly MergeParticipant[] {
    return this.merge.list();
  }

  exportContributors(): readonly ExportContributor[] {
    return this.exports.list();
  }
}

/** Process-wide default instance, and the two functions the ticket names. */
export const defaultRegistries = new ParticipantRegistries();
export const registerMergeParticipant = (p: MergeParticipant): void =>
  defaultRegistries.registerMergeParticipant(p);
export const registerExportContributor = (c: ExportContributor): void =>
  defaultRegistries.registerExportContributor(c);
