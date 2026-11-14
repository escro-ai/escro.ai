// Deliverable storage helper.
//
// Deliverables are dispute evidence: if a buyer disputes, the arbitrator needs
// to fetch what the worker delivered. So the helper carries a stated RETENTION
// policy of >= 90 days: a first arbitration must never find an expired URL. The
// on-chain `contentHash` carries integrity regardless of where the bytes live.
//
// Every deliverable lands at its own content-addressed URL, so a buyer reviewing
// job N after job N+1 was delivered still reads job N's bytes. Two backends ship,
// both dependency-free (plain `fetch` on Node 22+): no AWS SDK and no IPFS client
// are pulled into a scaffolded bot.
//   - "s3-presigned" (default): POST `{ key, retentionDays }` to `endpoint`, a
//     presign service you run, which answers `{ url }`, a presigned PUT URL for that
//     key, or 409 when the key is already stored; PUT the bytes there (none on 409)
//     and submit `publicBase + key`. The key is the unpadded base64url SHA-256 of the
//     bytes. The bucket's lifecycle rule enforces the retention; the helper sends the
//     requested retention with both requests.
//   - "ipfs": POST the bytes to a pinning endpoint that answers `{ cid }`, and
//     submit `ipfs://<cid>`. Set the pin's retention with your pinning provider; the
//     helper sends the requested retention too.
// Swap in any other backend by implementing the same tiny interface.

import { createHash } from "node:crypto";
import { proofUriError } from "@escro/sdk";
import { z } from "zod";

/** Minimum deliverable retention (days). Dispute evidence must outlive a first arbitration. */
export const MIN_RETENTION_DAYS = 90;

/** The object key of the bytes: their unpadded base64url SHA-256, 43 characters of `[A-Za-z0-9_-]`. */
export function contentKey(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("base64url");
}

const KEY_LENGTH = contentKey("").length;

/** A URL without its query and fragment: a presigned query is a bearer credential. */
function withoutQuery(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export const StorageConfigSchema = z
  .object({
    backend: z.enum(["s3-presigned", "ipfs"]).default("s3-presigned"),
    // Never below the floor, and 90 is the default when unset: shortening retention
    // silently would let dispute evidence expire before a first arbitration.
    retentionDays: z.number().int().min(MIN_RETENTION_DAYS).default(MIN_RETENTION_DAYS),
    /**
     * s3-presigned: your presign service, which mints a presigned PUT URL per object key.
     * ipfs: the pinning endpoint. An http(s) URL. Required before a real upload; left
     * optional here so a fresh scaffold type-checks before you wire your backend.
     */
    endpoint: z.string().optional(),
    /**
     * s3-presigned only: the URL prefix buyers read deliverables from (the bucket or a CDN),
     * ending in `/`. Each proof URI is `publicBase + key`, so it must fit the on-chain byte cap
     * with a key appended: a misfit fails at start instead of stranding a claimed job at submit.
     * Unset beside a presign service, the worker idles naming it and claims nothing.
     */
    publicBase: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    const { backend, endpoint, publicBase } = config;
    let presignedEndpoint = false;
    if (endpoint !== undefined) {
      const url = parseHttpUrl(endpoint);
      if (url === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endpoint"],
          message: "storage.endpoint must be an http or https URL",
        });
      } else if (
        backend === "s3-presigned" &&
        [...url.searchParams.keys()].some((name) => name.toLowerCase() === "x-amz-signature")
      ) {
        presignedEndpoint = true;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endpoint"],
          message:
            `storage.endpoint (${withoutQuery(endpoint)}) is a presigned URL for one object; set ` +
            "storage.endpoint to your presign service, which answers a POST of " +
            "{ key, retentionDays } with a presigned PUT URL for that key.",
        });
      }
    }
    if (backend === "ipfs") {
      if (publicBase !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publicBase"],
          message: "storage.publicBase does not apply to ipfs: its proof URIs are ipfs://<cid>",
        });
      }
      return;
    }
    if (publicBase === undefined) {
      if (presignedEndpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publicBase"],
          message:
            "storage.publicBase is not set: one fixed upload URL would overwrite every " +
            "deliverable with the next. Set storage.endpoint to your presign service and " +
            "storage.publicBase to the URL prefix buyers read deliverables from, ending in /.",
        });
      }
      return;
    }
    const base = parseHttpUrl(publicBase);
    if (base?.search !== "" || base.hash !== "" || !publicBase.endsWith("/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publicBase"],
        message:
          "storage.publicBase must be an http or https URL with no query or fragment, ending in /",
      });
      return;
    }
    const error = proofUriError(publicBase + "a".repeat(KEY_LENGTH));
    if (error !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publicBase"],
        message: `storage.publicBase with a ${String(KEY_LENGTH)}-character key cannot be submitted as a proof URI: ${error}`,
      });
    }
  });

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

/** Header the helper stamps the requested retention (days) onto every upload request. */
export const RETENTION_HEADER = "x-escro-retention-days";

export interface UploadInput {
  /** The deliverable bytes (a string is its UTF-8 bytes). */
  content: string | Uint8Array;
  /**
   * SHA-256 hex of `content` (for a content upload, the on-chain integrity anchor). The object
   * key is computed from the bytes, never taken from this.
   */
  contentHash: string;
}

export interface StorageRequest {
  url: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export interface UploadResult {
  /** Stable URI recorded on-chain as the deliverable proof. */
  proofUri: string;
  /** Retention policy (days) applied to this upload. */
  retentionDays: number;
}

export interface Storage {
  readonly config: StorageConfig;
  /**
   * Build the first HTTP request of an upload (s3-presigned: the mint POST; ipfs: the pin
   * POST): pure, so the key and retention wiring is testable.
   */
  buildRequest(input: UploadInput): StorageRequest;
  /** Upload the deliverable and return its proof URI. */
  upload(input: UploadInput): Promise<UploadResult>;
}

/**
 * Build a {@link Storage} helper from raw config. Validates with Zod (retention
 * >= 90, no presigned endpoint, a proof URI within the byte cap), so a misconfigured
 * storage backend fails at start, never mid-job. With no `publicBase`, `upload()` of
 * an s3-presigned backend rejects before any request, and `run()` idles before it can
 * be reached. `fetchImpl` is injectable for tests (defaults to global `fetch`).
 */
export function createStorage(raw: unknown, fetchImpl: typeof fetch = fetch): Storage {
  const config = StorageConfigSchema.parse(raw);
  const retention = String(config.retentionDays);

  function requireEndpoint(): string {
    if (config.endpoint === undefined) {
      throw new Error(
        "storage.endpoint is not set: wire your presign service and storage.publicBase " +
          "(s3-presigned) or a pinning endpoint (ipfs) in escro.config.ts before uploading deliverables.",
      );
    }
    return config.endpoint;
  }

  function buildRequest(input: UploadInput): StorageRequest {
    const endpoint = requireEndpoint();
    if (config.backend === "ipfs") {
      return {
        url: endpoint,
        method: "POST",
        headers: { "content-type": "application/octet-stream", [RETENTION_HEADER]: retention },
        body: input.content,
      };
    }
    return {
      url: endpoint,
      method: "POST",
      headers: { "content-type": "application/json", [RETENTION_HEADER]: retention },
      body: JSON.stringify({ key: contentKey(input.content), retentionDays: config.retentionDays }),
    };
  }

  // Messages name the URL without its query: a presigned query is a bearer credential, and
  // an endpoint's query may carry the bot's token for the presign service.
  function request(req: StorageRequest): Promise<Response> {
    return fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      // string and Uint8Array are both valid fetch bodies at runtime; the cast
      // bridges the DOM BodyInit type, which does not name the Uint8Array generic.
      body: req.body as BodyInit,
    });
  }

  function refuse(req: StorageRequest, res: Response): Error {
    return new Error(
      `Deliverable upload failed: ${String(res.status)} ${res.statusText} ` +
        `(${req.method} ${withoutQuery(req.url)}).`,
    );
  }

  async function send(req: StorageRequest): Promise<Response> {
    const res = await request(req);
    if (!res.ok) throw refuse(req, res);
    return res;
  }

  async function answerField(req: StorageRequest, res: Response, name: string): Promise<unknown> {
    let answer: unknown;
    try {
      answer = await res.json();
    } catch {
      throw new Error(
        `Deliverable upload failed: the answer to ${req.method} ${withoutQuery(req.url)} is not JSON.`,
      );
    }
    return typeof answer === "object" && answer !== null
      ? (answer as Record<string, unknown>)[name]
      : undefined;
  }

  async function uploadIpfs(input: UploadInput): Promise<UploadResult> {
    const req = buildRequest(input);
    const cid = await answerField(req, await send(req), "cid");
    if (typeof cid !== "string" || !/^[A-Za-z0-9]+$/.test(cid)) {
      throw new Error(
        `Deliverable pin failed: the answer to POST ${withoutQuery(req.url)} has no alphanumeric string cid.`,
      );
    }
    const proofUri = `ipfs://${cid}`;
    const error = proofUriError(proofUri);
    if (error !== null) {
      throw new Error(`Deliverable pin failed: ${error}`);
    }
    return { proofUri, retentionDays: config.retentionDays };
  }

  async function uploadPresigned(input: UploadInput, publicBase: string): Promise<UploadResult> {
    const mint = buildRequest(input);
    const key = contentKey(input.content);
    const proofUri = publicBase + key;
    const res = await request(mint);
    // The presign service mints write-once: 409 means these exact bytes are already stored at
    // this key (a retried job, or a second identical deliverable), so the URL already serves them.
    if (res.status === 409) return { proofUri, retentionDays: config.retentionDays };
    if (!res.ok) throw refuse(mint, res);
    const minted = await answerField(mint, res, "url");
    // A url not ending in the key names some other object (a presign service that ignores the
    // key mints one fixed object, and each PUT would overwrite the last deliverable).
    const putUrl = typeof minted === "string" ? parseHttpUrl(minted) : null;
    if (typeof minted !== "string" || !putUrl?.pathname.endsWith(`/${key}`)) {
      throw new Error(
        `Deliverable upload failed: the presign service at ${withoutQuery(mint.url)} did not ` +
          `answer an http(s) url whose path ends with the key ${key}.`,
      );
    }
    await send({
      url: minted,
      method: "PUT",
      headers: { "content-type": "application/octet-stream", [RETENTION_HEADER]: retention },
      body: input.content,
    });
    return { proofUri, retentionDays: config.retentionDays };
  }

  async function upload(input: UploadInput): Promise<UploadResult> {
    requireEndpoint();
    if (config.backend === "ipfs") return uploadIpfs(input);
    if (config.publicBase === undefined) {
      throw new Error(
        "storage.publicBase is not set: set the URL prefix buyers read deliverables from " +
          "in escro.config.ts before uploading deliverables.",
      );
    }
    return uploadPresigned(input, config.publicBase);
  }

  return { config, buildRequest, upload };
}
