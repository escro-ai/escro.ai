// Funding a selected `on-delivery` entry through the SDK's own `createEscrow`
// (docs/specs/scheme_on_delivery_svm.md, "Job specification", "Job creation", "Payment payload").
import { PublicKey, type Keypair } from "@solana/web3.js";
import {
  computeTaskSpecHash,
  isRecord,
  type OnDeliveryPaymentPayload,
  type TaskSpec,
} from "@escro/shared";
import { deriveEscrowPda } from "@escro/shared/solana";

import type { Escro } from "../client.js";
import { EscroError } from "../errors.js";
import { spendSelection, type EscrowAcceptSelection } from "./accept.js";
import { isAbsoluteHttpUrl, isSignedAt, signEscrowPayload } from "./buyer-signature.js";
import { OnDeliveryFundError } from "./errors.js";
import {
  callResolver,
  isBadPortUrl,
  judge,
  pinnedRequest,
  untilAborted,
  type HostResolver,
} from "./pinned-request.js";

const SPEC_FETCH_TIMEOUT_MS = 10_000;
const SPEC_MAX_BYTES = 256 * 1024;
const MAX_TASK_ID_BYTES = 32;

/**
 * A job specification document: a non-null, non-array object. The API's TaskSpec schema validates
 * its members when `createEscrow` sends it.
 */
function isSpecDocument(value: unknown): value is TaskSpec {
  return isRecord(value);
}

const specFetchError = (message: string, cause?: unknown): OnDeliveryFundError =>
  new OnDeliveryFundError("spec_fetch", message, cause === undefined ? {} : { cause });

/** The response body's bytes, refusing past `SPEC_MAX_BYTES` without reading further. */
async function boundedBody(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SPEC_MAX_BYTES) {
        await reader.cancel();
        throw specFetchError(`The job specification is over ${String(SPEC_MAX_BYTES)} bytes`);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The spec host's address rule and the resolutions it reads. */
interface SpecPinning {
  admit: (address: string) => boolean;
  resolve: HostResolver;
}

/**
 * The spec GET through the pin: the host resolved once (within the fetch's deadline), every answer put to the rule,
 * the connection made only to the admitted answers.
 */
async function pinnedSpecGet(
  specUri: string,
  pinning: SpecPinning,
  signal: AbortSignal,
): Promise<Response> {
  let answers: Awaited<ReturnType<HostResolver>>;
  try {
    answers = await untilAborted(pinning.resolve(new URL(specUri).hostname), signal);
  } catch (cause) {
    throw specFetchError("The job specification's host did not resolve", cause);
  }
  const judged = judge(answers, pinning.admit);
  if ("refused" in judged) {
    if (judged.refused === "unresolved") {
      throw specFetchError("The job specification's host did not resolve");
    }
    throw new OnDeliveryFundError(
      "spec_host",
      "The job specification's host answered an address the address rule refuses",
    );
  }
  return pinnedRequest(
    specUri,
    { method: "GET", headers: new Headers({ accept: "application/json" }), signal },
    judged.admitted,
  );
}

/**
 * The job specification at an `https:` `specUri`, fetched with no SDK header (only `Accept`), no
 * redirect, a total deadline of `timeoutMs` (default 10 000) and at most 256 KiB of body. Throws
 * {@link OnDeliveryFundError} `spec_fetch` on any other URI, a network failure, a non-2xx status,
 * an oversized, non-UTF-8 or non-JSON body, or a document that is not a JSON object; a URI carrying a
 * username or password, or naming a port `fetch` blocks, is refused before any lookup or connection. With
 * `admitAddress`, the host is resolved once within the deadline, every answer is put to it, and the
 * request connects only to the answers it admitted (exactly `true`); a refused answer throws
 * `spec_host`, an unresolved host `spec_fetch`.
 */
export function fetchTaskSpec(
  specUri: string,
  options: { timeoutMs?: number; admitAddress?: (address: string) => boolean } = {},
): Promise<Record<string, unknown>> {
  const { admitAddress } = options;
  return readTaskSpec(
    specUri,
    options.timeoutMs,
    admitAddress === undefined ? undefined : { admit: admitAddress, resolve: callResolver() },
  );
}

async function readTaskSpec(
  specUri: string,
  timeoutMs: number | undefined,
  pinning: SpecPinning | undefined,
): Promise<Record<string, unknown>> {
  let parsed: URL;
  try {
    parsed = new URL(specUri);
  } catch (cause) {
    throw specFetchError("The job specification URI is not a URL", cause);
  }
  if (parsed.protocol !== "https:") {
    throw specFetchError("The default job specification fetch reads https: URIs only");
  }
  // node:https would send these as Authorization: Basic; fetch refuses them.
  if (parsed.username !== "" || parsed.password !== "") {
    throw specFetchError("The job specification URI carries a username or password");
  }
  if (isBadPortUrl(parsed)) {
    throw specFetchError("The job specification URI names a port fetch blocks");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("The job specification fetch timed out"));
  }, timeoutMs ?? SPEC_FETCH_TIMEOUT_MS);
  let document: unknown;
  try {
    const response =
      pinning === undefined
        ? await fetch(specUri, {
            headers: { accept: "application/json" },
            redirect: "error",
            signal: controller.signal,
          })
        : await pinnedSpecGet(specUri, pinning, controller.signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw specFetchError(`The job specification answered HTTP ${String(response.status)}`);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(response));
    document = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof OnDeliveryFundError) throw cause;
    throw specFetchError("The job specification could not be fetched as JSON", cause);
  } finally {
    clearTimeout(timer);
  }
  if (!isRecord(document)) throw specFetchError("The job specification is not a JSON object");
  return document;
}

export interface FundFromAcceptDeps {
  escro: Pick<Escro, "createEscrow">;
  wallet: Keypair;
  /** The absolute URL the paid request goes to: the 402's `resource.url`. */
  resourceUrl: string;
  /** Fetches `extra.specUri`; the only way to read an `ipfs:` URI. Default {@link fetchTaskSpec}. */
  fetchSpec?: (specUri: string) => Promise<unknown>;
  /**
   * Decides each address the default spec fetch may connect to (see {@link fetchTaskSpec}); a caller's
   * `fetchSpec` is its own transport and does not read it.
   */
  admitAddress?: (address: string) => boolean;
  /** The buyer's veto over the hash-checked specification, before `createEscrow`; absent admits. */
  admitSpec?: (spec: TaskSpec) => boolean;
  /** Unix milliseconds. */
  now?: () => number;
}

export interface FundFromAcceptResult {
  payment: OnDeliveryPaymentPayload;
  taskSpec: TaskSpec;
}

async function specDocument(
  specUri: string,
  fetchSpec: FundFromAcceptDeps["fetchSpec"],
  pinning: SpecPinning | undefined,
): Promise<TaskSpec> {
  let document: unknown;
  if (fetchSpec === undefined) {
    document = await readTaskSpec(specUri, undefined, pinning);
  } else {
    try {
      document = await fetchSpec(specUri);
    } catch (cause) {
      throw specFetchError("fetchSpec failed", cause);
    }
  }
  if (!isSpecDocument(document)) throw specFetchError("The job specification is not a JSON object");
  return document;
}

/** The escrow PDA of `buyer` and `taskId` under `program`; undefined for a task id over 32 bytes. */
function escrowPdaOf(program: string, buyer: PublicKey, taskId: string): string | undefined {
  if (new TextEncoder().encode(taskId).length > MAX_TASK_ID_BYTES) return undefined;
  return deriveEscrowPda(new PublicKey(program), buyer, taskId).toBase58();
}

/**
 * Funds a selection {@link parseEscrowAccept} returned, once: fetches the job specification, checks
 * its hash before it is used or sent, creates the escrow through `deps.escro.createEscrow` with
 * `payTo` as the assigned worker, and returns the `PAYMENT-SIGNATURE` payload signed by
 * `deps.wallet` over `deps.resourceUrl`, with the hash-checked specification.
 *
 * A selection is known only to the copy of the SDK that parsed it. An `escro` built with another
 * wallet, or for another cluster, is caught after the create lands, as `escrow_mismatch`; that
 * error carries `escrowId`, `escrowPda` and `signature`, and `cancelEscrow` is the recovery. An
 * error from `createEscrow` propagates unchanged.
 */
export function fundFromAccept(
  selection: EscrowAcceptSelection,
  deps: FundFromAcceptDeps,
): Promise<FundFromAcceptResult> {
  return fundSelection(selection, deps, callResolver());
}

/** {@link fundFromAccept} reading the spec host through `resolve`, the resolutions of the pay() call it belongs to. */
export async function fundSelection(
  selection: EscrowAcceptSelection,
  deps: FundFromAcceptDeps,
  resolve: HostResolver,
): Promise<FundFromAcceptResult> {
  // Synchronous up to the first await, so two calls in flight cannot both find it fresh.
  const state = spendSelection(selection);
  if (state === undefined) {
    throw new OnDeliveryFundError(
      "selection_unknown",
      "parseEscrowAccept did not return this selection",
    );
  }
  if (state === "spent") {
    throw new OnDeliveryFundError("selection_spent", "This selection has already been funded");
  }
  const { entry, resource } = selection;
  if (!isAbsoluteHttpUrl(deps.resourceUrl)) {
    throw new OnDeliveryFundError(
      "resource_url",
      "resourceUrl must be an absolute http: or https: URL",
    );
  }
  if (deps.resourceUrl !== resource.url) {
    throw new OnDeliveryFundError("resource_mismatch", "resourceUrl is not the 402's resource.url");
  }
  const now = (): number => deps.now?.() ?? Date.now();
  if (!isSignedAt(now())) {
    throw new EscroError(
      "now() must return non-negative safe-integer Unix milliseconds",
      "VALIDATION_ERROR",
    );
  }
  const { admitAddress } = deps;
  const taskSpec = await specDocument(
    entry.extra.specUri,
    deps.fetchSpec,
    admitAddress === undefined ? undefined : { admit: admitAddress, resolve },
  );
  if (computeTaskSpecHash(taskSpec) !== entry.extra.specHash) {
    throw new OnDeliveryFundError(
      "spec_hash_mismatch",
      "The job specification does not hash to the entry's specHash",
    );
  }
  if (deps.admitSpec !== undefined && !deps.admitSpec(taskSpec)) {
    throw new OnDeliveryFundError("spec_refused", "admitSpec refused the job specification");
  }
  const created = await deps.escro.createEscrow({
    taskSpec,
    amountUsdc: Number(entry.amount),
    deadlineUnix: entry.extra.deadline,
    assignedWorker: entry.payTo,
  });
  const { escrowId, escrowPda, signature } = created;
  if (escrowPdaOf(entry.extra.program, deps.wallet.publicKey, escrowId) !== escrowPda) {
    throw new OnDeliveryFundError(
      "escrow_mismatch",
      `The created escrow ${escrowPda} is not this wallet's escrow under the entry's program; recover the deposit with cancelEscrow`,
      { escrowId, escrowPda, signature },
    );
  }
  const payload = signEscrowPayload(
    {
      escrow: escrowPda,
      buyer: deps.wallet.publicKey.toBase58(),
      taskId: escrowId,
      createSignature: signature,
    },
    { wallet: deps.wallet, resourceUrl: deps.resourceUrl, now },
  );
  const payment: OnDeliveryPaymentPayload = {
    x402Version: 2,
    resource,
    accepted: entry,
    payload,
    ...(selection.extensions === undefined ? {} : { extensions: selection.extensions }),
  };
  return { payment, taskSpec };
}
