import type { JobRecord, JobStore } from "./index.js";

/** A JobStore held by this process only; a server behind a load balancer shares one instead. */
export function memoryJobStore(): JobStore {
  const records = new Map<string, JobRecord>();
  return {
    get: (escrow) => records.get(escrow),
    put: (record) => {
      records.set(record.escrow, record);
    },
  };
}
