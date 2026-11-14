// Anonymous time-to-first-escrow (TTFE) funnel emitter.
//
// A funnel event names a stage and carries a timestamp, nothing else: no wallet,
// no task content, no key material. Events append to a local, gitignored file
// (.escro/events.jsonl) and correlate with the scaffold-time `scaffolded` event
// via the opaque runId the CLI wrote to .escro/session.json. Set `telemetry:
// false` in escro.config.ts (or scaffold with --no-telemetry) to emit nothing.
//
// This file is self-contained by design (a generated project cannot import the
// kit internals); the kit's own tests lock its stage vocabulary to the kit's
// canonical funnel contract.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type FunnelPath = "buyer" | "worker";

export type FunnelStage =
  | "scaffolded"
  | "started"
  | "worker_hired"
  | "escrow_created"
  | "settled"
  | "registered"
  | "discoverable";

export interface FunnelEvent {
  path: FunnelPath;
  stage: FunnelStage;
  runId: string;
  at: number;
}

export interface Telemetry {
  stage(stage: FunnelStage): void;
}

export interface TelemetryInit {
  path: FunnelPath;
  /** Usually `config.telemetry`; when false the emitter is a no-op. */
  enabled: boolean;
  /** Project root that holds the `.escro/` sidecar. */
  projectRoot: string;
  /** Overrides the persisted/generated runId (tests, or a caller-set id). */
  runId?: string;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sink (tests); defaults to appending JSONL under `.escro/`. */
  sink?: (event: FunnelEvent) => void;
}

function readRunId(escroDir: string): string | null {
  const sessionPath = join(escroDir, "session.json");
  if (!existsSync(sessionPath)) return null;
  try {
    const session = JSON.parse(readFileSync(sessionPath, "utf8")) as { runId?: string };
    return typeof session.runId === "string" && session.runId !== "" ? session.runId : null;
  } catch {
    return null;
  }
}

/**
 * Build a session-scoped telemetry emitter. Each stage fires at most once per
 * process. When disabled, nothing is read or written. The runId is taken from
 * the explicit override, else the scaffold-time session file, else a fresh
 * opaque id (a self-consistent funnel that simply will not join the CLI's
 * `scaffolded` event).
 */
export function createTelemetry(init: TelemetryInit): Telemetry {
  if (!init.enabled) {
    return {
      stage() {
        /* telemetry disabled: emit nothing */
      },
    };
  }

  const escroDir = join(init.projectRoot, ".escro");
  const runId = init.runId ?? readRunId(escroDir) ?? randomUUID();
  const now = init.now ?? ((): number => Date.now());
  const sink =
    init.sink ??
    ((event: FunnelEvent): void => {
      if (!existsSync(escroDir)) mkdirSync(escroDir, { recursive: true });
      appendFileSync(join(escroDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
    });

  const fired = new Set<FunnelStage>();
  return {
    stage(stage: FunnelStage): void {
      if (fired.has(stage)) return;
      fired.add(stage);
      sink({ path: init.path, stage, runId, at: now() });
    },
  };
}
