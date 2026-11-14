// Time-to-first-escrow (TTFE) funnel instrumentation.
//
// Anonymous funnel events name a stage and carry a duration, nothing else. Two
// paths are measured:
//   buyer:  scaffolded -> started -> worker_hired -> escrow_created -> settled
//           (TTFE p50 is computed on THIS path: scaffolded -> settled)
//   worker: scaffolded -> started -> registered -> discoverable
//
// This module is the CLI-side home of the funnel contract and the p50/elapsed
// analysis. The generated bot ships its own minimal, dependency-free emitter
// (templates/*/src/telemetry.ts) whose event shape is locked against the stage
// sets exported here by the kit's tests. Events sink to a local,
// gitignored JSONL file in the project (.escro/); there is deliberately NO
// network ingestion here (that surface is a later concern).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FunnelPath = "buyer" | "worker";

export const BUYER_STAGES = [
  "scaffolded",
  "started",
  "worker_hired",
  "escrow_created",
  "settled",
] as const;

export const WORKER_STAGES = ["scaffolded", "started", "registered", "discoverable"] as const;

export type BuyerStage = (typeof BUYER_STAGES)[number];
export type WorkerStage = (typeof WORKER_STAGES)[number];
export type FunnelStage = BuyerStage | WorkerStage;

/**
 * The complete, anonymous funnel-event shape. These are the ONLY fields an event
 * may carry: a stage name, a duration anchor (`at`), the path, and an opaque
 * `runId` that correlates the events of one scaffold->settle journey WITHOUT
 * identifying a wallet, a task, or any key material.
 */
export interface FunnelEvent {
  path: FunnelPath;
  stage: FunnelStage;
  /** Opaque per-scaffold id (NOT derived from any wallet). Correlates a funnel. */
  runId: string;
  /** Epoch milliseconds; only inter-stage differences are meaningful. */
  at: number;
}

/** The event field allowlist. A guard against any future PII leak into a payload. */
export const FUNNEL_EVENT_KEYS = ["path", "stage", "runId", "at"] as const;

export interface TelemetrySink {
  record(event: FunnelEvent): void;
}

/** In-memory sink for tests. */
export class MemorySink implements TelemetrySink {
  readonly events: FunnelEvent[] = [];
  record(event: FunnelEvent): void {
    this.events.push(event);
  }
}

/** A sink that drops everything (the disabled path uses this). */
export const NULL_SINK: TelemetrySink = {
  record() {
    /* drops every event */
  },
};

/**
 * Append events as JSON lines to `filePath`, creating the parent directory on
 * first write. Each event is exactly one line, so a partially-written run is
 * still readable up to the last complete line.
 */
export function fileSink(filePath: string): TelemetrySink {
  return {
    record(event: FunnelEvent): void {
      const dir = join(filePath, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(event)}\n`);
    },
  };
}

export interface TelemetryOptions {
  path: FunnelPath;
  runId: string;
  enabled: boolean;
  sink: TelemetrySink;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * A session-scoped emitter. Each stage fires at most once per instance, so a
 * loop that calls `stage("settled")` on every released escrow records the first
 * settlement only. When `enabled` is false nothing is recorded at all.
 */
export class FunnelTelemetry {
  private readonly path: FunnelPath;
  private readonly runId: string;
  private readonly enabled: boolean;
  private readonly sink: TelemetrySink;
  private readonly now: () => number;
  private readonly fired = new Set<FunnelStage>();

  constructor(opts: TelemetryOptions) {
    this.path = opts.path;
    this.runId = opts.runId;
    this.enabled = opts.enabled;
    this.sink = opts.sink;
    this.now = opts.now ?? (() => Date.now());
  }

  stage(stage: FunnelStage): void {
    if (!this.enabled) return;
    if (this.fired.has(stage)) return;
    this.fired.add(stage);
    this.sink.record({ path: this.path, stage, runId: this.runId, at: this.now() });
  }
}

// ── Cross-process session + event persistence ───────────────────────────────
// The CLI stamps `scaffolded` (and, for a worker, registered/discoverable); the
// running bot stamps the remaining stages in a later process. They correlate via
// a runId persisted at scaffold time under the project's .escro/ sidecar.

export interface TelemetrySession {
  runId: string;
  path: FunnelPath;
  enabled: boolean;
}

/** The gitignored sidecar directory under a generated project. */
export function escroDir(projectRoot: string): string {
  return join(projectRoot, ".escro");
}

export function sessionPath(dir: string): string {
  return join(dir, "session.json");
}

export function eventsPath(dir: string): string {
  return join(dir, "events.jsonl");
}

export function writeSession(dir: string, session: TelemetrySession): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(sessionPath(dir), `${JSON.stringify(session, null, 2)}\n`);
}

export function readSession(dir: string): TelemetrySession | null {
  const path = sessionPath(dir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as TelemetrySession;
}

export function readEvents(eventsFilePath: string): FunnelEvent[] {
  if (!existsSync(eventsFilePath)) return [];
  return readFileSync(eventsFilePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FunnelEvent);
}

// ── Analysis ────────────────────────────────────────────────────────────────

export function groupByRun(events: FunnelEvent[]): Map<string, FunnelEvent[]> {
  const byRun = new Map<string, FunnelEvent[]>();
  for (const ev of events) {
    const bucket = byRun.get(ev.runId);
    if (bucket === undefined) byRun.set(ev.runId, [ev]);
    else bucket.push(ev);
  }
  return byRun;
}

/** The earliest `at` recorded for `stage` in one run's events, or null if absent. */
function firstAt(runEvents: FunnelEvent[], stage: FunnelStage): number | null {
  let min: number | null = null;
  for (const ev of runEvents) {
    if (ev.stage !== stage) continue;
    if (min === null || ev.at < min) min = ev.at;
  }
  return min;
}

/**
 * Elapsed milliseconds between the first `from` and first `to` stage within one
 * run. Null if either stage never fired. Uses the earliest occurrence of each
 * stage so a restart that re-emits `started` does not distort the span.
 */
export function runElapsedMs(
  runEvents: FunnelEvent[],
  from: FunnelStage,
  to: FunnelStage,
): number | null {
  const start = firstAt(runEvents, from);
  const end = firstAt(runEvents, to);
  if (start === null || end === null) return null;
  return end - start;
}

/** Nearest-rank p50 (median): the value at rank ceil(0.5 * n), 1-indexed. */
export function p50(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.5 * sorted.length);
  return sorted[rank - 1] ?? null;
}

/**
 * The buyer-path TTFE p50: p50 over the scaffolded->settled span of every run
 * that reached `settled`. Incomplete funnels are excluded (they have no span),
 * so TTFE is measured on real settlements, never asserted.
 */
export function buyerTtfeP50Ms(events: FunnelEvent[]): number | null {
  const spans: number[] = [];
  for (const runEvents of groupByRun(events).values()) {
    const span = runElapsedMs(runEvents, "scaffolded", "settled");
    if (span !== null) spans.push(span);
  }
  return p50(spans);
}

/** Per-run worker registered->discoverable elapsed (only runs that reached both). */
export function workerRegisterToDiscoverMs(events: FunnelEvent[]): number[] {
  const spans: number[] = [];
  for (const runEvents of groupByRun(events).values()) {
    const span = runElapsedMs(runEvents, "registered", "discoverable");
    if (span !== null) spans.push(span);
  }
  return spans;
}
