import { signRequest } from "@escro/shared";
import type { Keypair } from "@solana/web3.js";
import type {
  BotDescriptor,
  EscrowAccount,
  EscrowErrorCode,
  EscrowState,
  OutstandingDeposits,
} from "@escro/shared";
import type { ReputationExport, ServedWalletReputation } from "./reputation-types.js";
import type {
  CreateEscrowParams,
  ListBotsParams,
  PaginatedResult,
  RaiseDisputeParams,
  SerializedEscrow,
  SubmitDeliverableParams,
} from "./types.js";
import {
  EscroError,
  EscrowNotFoundError,
  EscrowStateError,
  ReputationUnavailableError,
  UnauthorizedError,
} from "./errors.js";
import { assertPublicKey } from "./public-key.js";

function authHeaders(
  wallet: Keypair,
  method: string,
  path: string,
  rawBody = "",
): Record<string, string> {
  return signRequest(wallet, method, path, rawBody);
}

function deserialize(raw: SerializedEscrow): EscrowAccount {
  return { ...raw, amount: BigInt(raw.amount) };
}

async function handleError(res: Response, address?: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  const msg = body.error ?? `HTTP ${String(res.status)}`;
  if (res.status === 404) throw new EscrowNotFoundError(address ?? msg);
  if (res.status === 409) throw new EscrowStateError(msg);
  if (res.status === 401 || res.status === 403) throw new UnauthorizedError(msg);
  throw new EscroError(msg, body.code ?? "UNKNOWN", retryAfterMs(res.headers.get("retry-after")));
}

/** Retry-After in whole seconds, as milliseconds; an HTTP-date is ignored. */
function retryAfterMs(header: string | null): number | undefined {
  return header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) * 1000 : undefined;
}

/**
 * How long the outstanding-deposits read and the create POST may take, body included, before
 * they are abandoned with code `API_TIMEOUT`. A spend-capped create holds its wallet's admission
 * across both, so a stalled API would otherwise block every later create of that wallet.
 */
export const API_REQUEST_TIMEOUT_MS = 15_000;

/** Runs `request` with a signal that aborts it after {@link API_REQUEST_TIMEOUT_MS}. */
async function bounded<T>(what: string, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, API_REQUEST_TIMEOUT_MS);
  try {
    return await request(controller.signal);
  } catch (err) {
    if (!controller.signal.aborted) throw err;
    throw new EscroError(
      `${what} did not answer within ${String(API_REQUEST_TIMEOUT_MS / 1000)} s`,
      "API_TIMEOUT",
      undefined,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly wallet: Keypair,
  ) {
    const url = new URL(baseUrl);
    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocalhost) {
      throw new Error("apiUrl must use HTTPS in production");
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** GET /v1/escrows/:address */
  async getEscrow(address: string): Promise<EscrowAccount> {
    assertPublicKey("address", address);
    const path = `/v1/escrows/${encodeURIComponent(address)}`;
    const res = await fetch(this.url(path));
    if (!res.ok) await handleError(res, address);
    return deserialize((await res.json()) as SerializedEscrow);
  }

  /** GET /v1/escrows?assignedTo=...&maker=...&taker=...&state=... */
  async listEscrows(params: {
    assignedTo?: string;
    maker?: string;
    taker?: string;
    state?: EscrowState;
    limit?: number;
    offset?: number;
  }): Promise<PaginatedResult<EscrowAccount>> {
    const qs = new URLSearchParams();
    for (const filter of ["assignedTo", "maker", "taker"] as const) {
      const value = params[filter];
      if (value === undefined) continue;
      assertPublicKey(filter, value);
      qs.set(filter, value);
    }
    if (params.state) qs.set("state", params.state);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));

    const path = `/v1/escrows?${qs.toString()}`;
    const res = await fetch(this.url(path));
    if (!res.ok) await handleError(res);
    const body = (await res.json()) as {
      items: SerializedEscrow[];
      total: number;
      limit: number;
      offset: number;
    };
    return {
      items: body.items.map(deserialize),
      total: body.total,
      limit: body.limit,
      offset: body.offset,
    };
  }

  /**
   * GET /v1/bots?capability=...&role=...&limit=...&offset= : EscroBots registry
   * read. Unauthenticated public read (no auth headers). Returns descriptors in
   * registry order (newest first); descriptors are self-reported claims.
   */
  async listBots(params: ListBotsParams): Promise<PaginatedResult<BotDescriptor>> {
    const qs = new URLSearchParams();
    if (params.capability != null) qs.set("capability", params.capability);
    if (params.role != null) qs.set("role", params.role);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));

    const path = `/v1/bots?${qs.toString()}`;
    const res = await fetch(this.url(path));
    if (!res.ok) await handleError(res);
    const body = (await res.json()) as {
      items: BotDescriptor[];
      total: number;
      limit: number;
      offset: number;
    };
    return { items: body.items, total: body.total, limit: body.limit, offset: body.offset };
  }

  /**
   * GET /rep : EscroRep bulk export. Unauthenticated public
   * read (no auth headers). Returns every indexed wallet's RAW components exactly
   * once (no composite score). Ranking layers join against this ONE bulk fetch:
   * the per-wallet endpoint shares a 10/min public-metrics budget, so a
   * per-candidate fan-out would rate-limit itself. A 404 means the deployment
   * mounted no reputation source (unknown wallets return zeroed rep, never 404),
   * so it surfaces as {@link ReputationUnavailableError}, not EscrowNotFoundError.
   */
  async listReputations(): Promise<ServedWalletReputation[]> {
    const res = await fetch(this.url("/rep"));
    if (!res.ok) {
      if (res.status === 404) throw new ReputationUnavailableError();
      await handleError(res);
    }
    const body = (await res.json()) as ReputationExport;
    return body.wallets;
  }

  /**
   * GET /rep/:wallet : one wallet's EscroRep RAW components.
   * Unauthenticated public read (no auth headers). Unknown wallets return zeroed
   * components, never 404; a 404 means the deployment mounted no reputation
   * source and surfaces as {@link ReputationUnavailableError}. Shares the public
   * per-wallet rate budget with every other caller, so fan-outs should use
   * {@link listReputations} instead.
   */
  async getReputation(wallet: string): Promise<ServedWalletReputation> {
    assertPublicKey("wallet", wallet);
    const res = await fetch(this.url(`/rep/${encodeURIComponent(wallet)}`));
    if (!res.ok) {
      if (res.status === 404) throw new ReputationUnavailableError();
      await handleError(res);
    }
    return (await res.json()) as ServedWalletReputation;
  }

  /**
   * GET /v1/escrows/outstanding?maker=: the maker's open deposits (FUNDED, IN_PROGRESS,
   * SUBMITTED, DISPUTED; never CREATED). Unauthenticated. Abandoned with code `API_TIMEOUT`
   * after {@link API_REQUEST_TIMEOUT_MS}.
   */
  async getOutstandingDeposits(maker: string): Promise<OutstandingDeposits> {
    assertPublicKey("maker", maker);
    const path = `/v1/escrows/outstanding?${new URLSearchParams({ maker }).toString()}`;
    return bounded(`GET ${path}`, async (signal) => {
      const res = await fetch(this.url(path), { signal });
      if (!res.ok) await handleError(res);
      return (await res.json()) as OutstandingDeposits;
    });
  }

  /**
   * POST /v1/escrows: registers the escrow and returns its ids and the unsigned
   * `create_escrow`. Requires auth. Abandoned with code `API_TIMEOUT` after
   * {@link API_REQUEST_TIMEOUT_MS}.
   */
  async createEscrow(params: CreateEscrowParams): Promise<{
    escrowId: string;
    escrowPda: string;
    unsignedTx: string;
  }> {
    const path = "/v1/escrows";
    const bodyObj: Record<string, unknown> = {
      taskSpec: params.taskSpec,
      amountUsdc: params.amountUsdc,
      deadlineUnix: params.deadlineUnix,
      assignedWorker: params.assignedWorker,
    };

    const rawBody = JSON.stringify(bodyObj);
    return bounded(`POST ${path}`, async (signal) => {
      const res = await fetch(this.url(path), {
        method: "POST",
        headers: {
          ...authHeaders(this.wallet, "POST", path, rawBody),
          "content-type": "application/json",
        },
        body: rawBody,
        signal,
      });
      if (!res.ok) await handleError(res);
      return (await res.json()) as { escrowId: string; escrowPda: string; unsignedTx: string };
    });
  }

  /**
   * POST /v1/escrows/:address/claim: returns unsigned tx.
   * Requires auth (worker).
   */
  async claimTask(address: string): Promise<{ unsignedTx: string }> {
    assertPublicKey("address", address);
    const path = `/v1/escrows/${encodeURIComponent(address)}/claim`;
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: authHeaders(this.wallet, "POST", path),
    });
    if (!res.ok) await handleError(res, address);
    return res.json() as Promise<{ unsignedTx: string }>;
  }

  /**
   * POST /v1/escrows/:address/submit: returns unsigned tx.
   * Requires auth (worker).
   */
  async submitDeliverable(
    address: string,
    params: SubmitDeliverableParams,
  ): Promise<{ unsignedTx: string }> {
    assertPublicKey("address", address);
    const path = `/v1/escrows/${encodeURIComponent(address)}/submit`;
    const rawBody = JSON.stringify({
      contentHash: params.contentHash,
      proofUri: params.proofUri,
    });
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: {
        ...authHeaders(this.wallet, "POST", path, rawBody),
        "content-type": "application/json",
      },
      body: rawBody,
    });
    if (!res.ok) await handleError(res, address);
    return res.json() as Promise<{ unsignedTx: string }>;
  }

  /**
   * POST /v1/escrows/:address/release: records the landed release once the API's RPC shows
   * the escrow closed. Requires auth (buyer). No on-chain tx returned. A 409
   * `ESCROW_NOT_SETTLED`, a 5xx or a 429 throws an {@link EscroError} with the server's code,
   * or `HTTP_<status>` when the answer carries none; {@link Escro.releasePaymentWithOutcome}
   * decides which to retry. Other refusals throw as every route does.
   */
  async releasePaymentDb(address: string): Promise<void> {
    assertPublicKey("address", address);
    const path = `/v1/escrows/${encodeURIComponent(address)}/release`;
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: authHeaders(this.wallet, "POST", path),
    });
    if (res.ok) return;
    if (res.status !== 409 && res.status !== 429 && res.status < 500) {
      await handleError(res, address);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (res.status === 409 && body.code !== ("ESCROW_NOT_SETTLED" satisfies EscrowErrorCode)) {
      throw new EscrowStateError(body.error ?? `HTTP ${String(res.status)}`);
    }
    throw new EscroError(
      body.error ?? `HTTP ${String(res.status)}`,
      body.code ?? `HTTP_${String(res.status)}`,
      retryAfterMs(res.headers.get("retry-after")),
    );
  }

  /**
   * POST /v1/escrows/:address/cancel: returns unsigned tx.
   * Requires auth (buyer). Only valid when state is FUNDED.
   */
  async cancelEscrow(address: string): Promise<{ unsignedTx: string }> {
    assertPublicKey("address", address);
    const path = `/v1/escrows/${encodeURIComponent(address)}/cancel`;
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: authHeaders(this.wallet, "POST", path),
    });
    if (!res.ok) await handleError(res, address);
    return res.json() as Promise<{ unsignedTx: string }>;
  }

  /**
   * POST /v1/escrows/:address/dispute: returns unsigned tx.
   * Requires auth (buyer or worker).
   */
  async raiseDispute(
    address: string,
    params: Pick<RaiseDisputeParams, "reason">,
  ): Promise<{ unsignedTx: string }> {
    assertPublicKey("address", address);
    const path = `/v1/escrows/${encodeURIComponent(address)}/dispute`;
    const rawBody = JSON.stringify({ reason: params.reason });
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: {
        ...authHeaders(this.wallet, "POST", path, rawBody),
        "content-type": "application/json",
      },
      body: rawBody,
    });
    if (!res.ok) await handleError(res, address);
    return res.json() as Promise<{ unsignedTx: string }>;
  }

  /**
   * POST /v1/escrows/:address/confirm: the API records the create, claim, submit,
   * cancel or dispute the landed `signature` carries, after verifying it on chain.
   * A non-2xx answer throws an {@link EscroError} with the server's code, or
   * `HTTP_<status>` when the answer carries none; a network failure rejects with
   * fetch's own error. {@link Escro.confirm} decides which to retry.
   */
  async confirm(address: string, signature: string, evidence?: string): Promise<EscrowAccount> {
    assertPublicKey("address", address);
    const path = `/v1/escrows/${encodeURIComponent(address)}/confirm`;
    const rawBody = JSON.stringify({ signature, evidence });
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: {
        ...authHeaders(this.wallet, "POST", path, rawBody),
        "content-type": "application/json",
      },
      body: rawBody,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new EscroError(
        body.error ?? `HTTP ${String(res.status)}`,
        body.code ?? `HTTP_${String(res.status)}`,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    const body = (await res.json()) as { escrow: SerializedEscrow };
    return deserialize(body.escrow);
  }

  /**
   * GET /v1/stats: public protocol-wide stats.
   * No auth required. Upstream typing in {@link Escro.getStats} narrows the
   * return shape.
   */
  async getStats(): Promise<unknown> {
    const path = "/v1/stats";
    const res = await fetch(this.url(path));
    if (!res.ok) await handleError(res);
    return res.json();
  }
}
