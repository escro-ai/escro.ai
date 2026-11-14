import type { TaskSpec } from "@escro/sdk";

/** The TaskSpecs of the 402s answered, bounded and expiring: an anonymous flood costs at most `maxSpecs` entries. */
export class SpecStore {
  private readonly documents = new Map<string, { text: string; expiresAtMs: number }>();

  constructor(private readonly maxSpecs: number) {}

  put(specHash: string, spec: TaskSpec, expiresAtMs: number): void {
    // Re-inserted so the most recently stored is the last evicted.
    this.documents.delete(specHash);
    this.documents.set(specHash, { text: JSON.stringify(spec), expiresAtMs });
    for (const oldest of this.documents.keys()) {
      if (this.documents.size <= this.maxSpecs) break;
      this.documents.delete(oldest);
    }
  }

  /** The stored document's text; undefined when unknown or expired at `nowMs`. */
  get(specHash: string, nowMs: number): string | undefined {
    const held = this.documents.get(specHash);
    if (held === undefined) return undefined;
    if (nowMs >= held.expiresAtMs) {
      this.documents.delete(specHash);
      return undefined;
    }
    return held.text;
  }
}
