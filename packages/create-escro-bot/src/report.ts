// Read a project's local funnel events (.escro/events.jsonl) and render the
// timings a clean-machine run produces: buyer-path TTFE (scaffolded -> settled)
// and worker-path registered -> discoverable. This is the shipped surface that
// makes the funnel "readable from a real run": `create-escro-bot --report`.
//
// p50 collapses to the single value when the file holds one funnel, and is a real
// median once a machine has scaffolded several bots into the same events file.

import {
  buyerTtfeP50Ms,
  groupByRun,
  p50,
  runElapsedMs,
  workerRegisterToDiscoverMs,
  type FunnelEvent,
} from "./telemetry.js";

function ms(value: number): string {
  return `${String(value)} ms (${(value / 1000).toFixed(1)} s)`;
}

/** Count runs of `path` that recorded both `from` and `to` (a completed leg). */
function completedFunnels(
  events: FunnelEvent[],
  path: FunnelEvent["path"],
  from: FunnelEvent["stage"],
  to: FunnelEvent["stage"],
): number {
  let count = 0;
  for (const runEvents of groupByRun(events).values()) {
    if (runEvents[0]?.path !== path) continue;
    if (runElapsedMs(runEvents, from, to) !== null) count += 1;
  }
  return count;
}

/**
 * Render a funnel report from raw events. Pure (no I/O) so it is unit-testable
 * against fixtures; the CLI reads the JSONL and prints the returned string.
 */
export function formatReport(events: FunnelEvent[]): string {
  if (events.length === 0) {
    return "No funnel events recorded yet. Run a scaffolded bot to its first settlement first.";
  }

  const funnels = groupByRun(events).size;
  const lines: string[] = [
    `Escro funnel report (${String(events.length)} events, ${String(funnels)} funnels)`,
    "",
  ];

  const settled = completedFunnels(events, "buyer", "scaffolded", "settled");
  const ttfe = buyerTtfeP50Ms(events);
  lines.push("Buyer path (scaffolded -> settled):");
  if (ttfe === null) {
    lines.push("  no settled buyer funnel yet (TTFE needs a completed scaffold -> settled run).");
  } else {
    lines.push(`  settled funnels: ${String(settled)}`);
    lines.push(`  TTFE p50: ${ms(ttfe)}`);
  }
  lines.push("");

  const discoverSpans = workerRegisterToDiscoverMs(events);
  const discoverP50 = p50(discoverSpans);
  lines.push("Worker path (registered -> discoverable):");
  if (discoverP50 === null) {
    lines.push("  no discoverable worker funnel yet.");
  } else {
    lines.push(`  discoverable funnels: ${String(discoverSpans.length)}`);
    lines.push(`  registered -> discoverable p50: ${ms(discoverP50)}`);
  }

  return lines.join("\n");
}
