import { lookup } from "node:dns/promises";
import type { z } from "zod";
import { deadlineBoundedPolicy, payAddressRule, payUrlRefusal } from "@escro/sdk";
import type { Escro, EscroOptions, PayRequest, PayUrlRefusal, TaskSpec } from "@escro/sdk";

import { EscroPluginError, moneyMayHaveMovedError } from "./errors.js";
import { readPaidBody } from "./paid-body.js";
import type { Action, ActionExample } from "./sak.js";
import {
  claimSchema,
  commissionSchema,
  findWorkersSchema,
  PAY_402_MAX_DEADLINE_SECONDS,
  pay402Schema,
  readEscrowSchema,
  releaseSchema,
  reputationSchema,
  submitSchema,
} from "./schema.js";

export type EscroActionName =
  | "escro_commission"
  | "escro_claim"
  | "escro_submit"
  | "escro_release"
  | "escro_read_escrow"
  | "escro_find_workers"
  | "escro_reputation"
  | "escro_pay_402";

/** The operator's configuration escro_pay_402's host rule reads; never action input. */
export interface PayGuardOptions {
  cluster: EscroOptions["cluster"];
  allowPrivateHosts: boolean;
}

/** Absent options take mainnet's rule with the opt-in off. */
const STRICTEST_GUARDS: PayGuardOptions = { cluster: "mainnet", allowPrivateHosts: false };

const HOST_REFUSALS: Record<PayUrlRefusal, string> = {
  private_host:
    "escro_pay_402 refuses a URL whose host is a loopback, link-local or private address, or a " +
    "name that resolves to one when checked. Nothing was sent or funded. The operator can admit " +
    "such hosts with createEscroPlugin's allowPrivateHosts option.",
  unresolved_host:
    "escro_pay_402 could not resolve the URL's host to check that it is public. Nothing was sent or funded.",
  mainnet_http: "escro_pay_402 on mainnet pays only https: URLs. Nothing was sent or funded.",
};

/**
 * The SDK's refusal of an address its transport resolved, as the sentence the URL check gives, read
 * by code and reason: a refused answer is the private-host sentence, or the mainnet https sentence
 * where the rule admits only private hosts; an unresolved one is the unresolved sentence. Null for
 * any other error.
 */
function hostRefusal(err: unknown, guards: PayGuardOptions, url: string): string | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, reason, detail } = err as Record<string, unknown>;
  if (code !== "PAY_REFUSED" || reason !== "host") return null;
  if (detail === "unresolved") return HOST_REFUSALS.unresolved_host;
  const mainnetHttpRule =
    guards.allowPrivateHosts &&
    guards.cluster !== "devnet" &&
    URL.canParse(url) &&
    new URL(url).protocol === "http:";
  return mainnetHttpRule ? HOST_REFUSALS.mainnet_http : HOST_REFUSALS.private_host;
}

const EXAMPLE_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const EXAMPLE_SIGNATURE = "5Nv2hJ8mXq3sLpW9tYcRfGdKa1ZbVuE7oNiQjHk4TwPxMy6CzSgBrDnFeUAL";

// The handler's result is `status` last, so no field of the SDK's can read as a success or hide a failure.
const success = (fields: Record<string, unknown>): Record<string, unknown> => ({
  ...fields,
  status: "success",
});

interface ActionDefinition<S extends z.AnyZodObject> {
  name: EscroActionName;
  similes: string[];
  description: string;
  examples: ActionExample[][];
  schema: S;
  run: (client: Escro, input: z.output<S>) => Promise<Record<string, unknown>>;
}

/** The client is resolved before the input is parsed, so an uninitialized plugin refuses whatever it is given. */
function define<S extends z.AnyZodObject>(
  clientOf: () => Escro,
  { run, ...action }: ActionDefinition<S>,
): Action {
  return {
    ...action,
    handler: async (_agent, input) => {
      const client = clientOf();
      return run(client, action.schema.parse(input) as z.output<S>);
    },
  };
}

function taskSpecOf(task: z.output<typeof commissionSchema>["task"]): TaskSpec {
  return {
    version: "1.0.0",
    taskType: task.taskType ?? "custom",
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria.map(({ id, description, required }) => ({
      id,
      description,
      ...(required !== undefined && { required }),
    })),
    deliverableFormat: { type: task.deliverableType ?? "text" },
    metadata: {},
  };
}

function payRequestOf(input: z.output<typeof pay402Schema>): PayRequest | null {
  const contentType = input.contentType ?? undefined;
  const body = input.body ?? undefined;
  const { method } = input;
  if (method === undefined && contentType === undefined && body === undefined) return null;
  return {
    ...(method !== undefined && { method }),
    ...(contentType !== undefined && { headers: { "content-type": contentType } }),
    ...(body !== undefined && { body }),
  };
}

async function commission(
  client: Escro,
  input: z.output<typeof commissionSchema>,
): Promise<Record<string, unknown>> {
  try {
    const { escrowId, escrowPda, signature } = await client.createEscrow({
      taskSpec: taskSpecOf(input.task),
      amountUsdc: input.amountMicroUsdc,
      deadlineUnix: Math.floor(Date.now() / 1000) + input.deadlineSeconds,
      assignedWorker: input.worker,
    });
    return success({ escrowId, escrowPda, signature });
  } catch (err) {
    const translated = moneyMayHaveMovedError("escro_commission", err);
    if (translated !== null) throw translated;
    throw err;
  }
}

async function pay402(
  client: Escro,
  input: z.output<typeof pay402Schema>,
  guards: PayGuardOptions,
): Promise<Record<string, unknown>> {
  const refusal = await payUrlRefusal(input.url, { ...guards, lookup });
  if (refusal !== null) throw new EscroPluginError(HOST_REFUSALS[refusal]);
  const request = payRequestOf(input);
  const admitAddress = payAddressRule({ ...guards, url: input.url });
  try {
    const { response, ...paid } = await client.pay({
      url: input.url,
      to: input.to,
      amountMicroUsdc: input.amountMicroUsdc,
      policy: deadlineBoundedPolicy({
        to: input.to,
        amountMicroUsdc: input.amountMicroUsdc,
        cluster: guards.cluster,
        maxDeadlineSeconds: input.maxDeadlineSeconds ?? PAY_402_MAX_DEADLINE_SECONDS,
      }),
      ...(request !== null && { request }),
      ...(admitAddress === undefined ? {} : { admitAddress }),
    });
    if (response === undefined) return success(paid);
    return success({
      ...paid,
      response: {
        status: response.status,
        contentType: response.headers.get("content-type"),
        ...(await readPaidBody(response)),
      },
    });
  } catch (err) {
    const refused = hostRefusal(err, guards, input.url);
    if (refused !== null) throw new EscroPluginError(refused);
    const translated = moneyMayHaveMovedError("escro_pay_402", err);
    if (translated !== null) throw translated;
    throw err;
  }
}

/** One definition per action, each making one SDK call plus shaping; `methods` reuses these handlers. */
export function buildActions(
  clientOf: () => Escro,
  guards: PayGuardOptions = STRICTEST_GUARDS,
): Action[] {
  return [
    define(clientOf, {
      name: "escro_commission",
      similes: ["commission a worker", "hire a worker bot", "lock USDC for a task"],
      description:
        "Lock USDC in an Escro escrow for work a named worker bot will deliver. The buyer judges the delivery and releases; if the work never arrives the escrow refunds.",
      examples: [
        [
          {
            input: {
              worker: EXAMPLE_ADDRESS,
              amountMicroUsdc: 5_000_000,
              deadlineSeconds: 3_600,
              task: {
                description: "Summarise the report in five lines",
                acceptanceCriteria: [{ id: "ac-1", description: "It has five lines" }],
              },
            },
            output: {
              status: "success",
              escrowId: "ab".repeat(16),
              escrowPda: EXAMPLE_ADDRESS,
              signature: EXAMPLE_SIGNATURE,
            },
            explanation: "Commission a worker for 5 USDC with one hour to deliver.",
          },
        ],
      ],
      schema: commissionSchema,
      run: commission,
    }),
    define(clientOf, {
      name: "escro_claim",
      similes: ["claim a task", "accept an escrow task"],
      description:
        "Claim an escrow task as its assigned worker. Only the wallet the escrow names can claim it.",
      examples: [
        [
          {
            input: { address: EXAMPLE_ADDRESS },
            output: { status: "success", signature: EXAMPLE_SIGNATURE },
            explanation: "Claim the task this agent was assigned.",
          },
        ],
      ],
      schema: claimSchema,
      run: async (client, { address }) => success({ signature: await client.claimTask(address) }),
    }),
    define(clientOf, {
      name: "escro_submit",
      similes: ["submit a deliverable", "deliver the work"],
      description:
        "Submit the deliverable's content hash for an escrow task this agent claimed. The buyer then releases or disputes.",
      examples: [
        [
          {
            input: { address: EXAMPLE_ADDRESS, contentHash: "cd".repeat(32), proofUri: null },
            output: { status: "success", signature: EXAMPLE_SIGNATURE },
            explanation: "Submit the finished work's hash.",
          },
        ],
      ],
      schema: submitSchema,
      run: async (client, { address, contentHash, proofUri }) =>
        success({
          signature: await client.submitDeliverable(address, {
            contentHash,
            ...(proofUri != null && { proofUri }),
          }),
        }),
    }),
    define(clientOf, {
      name: "escro_release",
      similes: ["release payment", "pay the worker", "approve the delivery"],
      description:
        "Release an escrow's funds to its worker. This is the buyer's own decision that the delivery is acceptable, and it cannot be undone.",
      examples: [
        [
          {
            input: { address: EXAMPLE_ADDRESS },
            output: { status: "success", signature: EXAMPLE_SIGNATURE },
            explanation: "Pay the worker after checking the delivery.",
          },
        ],
      ],
      schema: releaseSchema,
      run: async (client, { address }) =>
        success({ signature: await client.releasePayment(address) }),
    }),
    define(clientOf, {
      name: "escro_read_escrow",
      similes: ["read an escrow", "check escrow state"],
      description: "Read an escrow's state, parties, amount and deadline.",
      examples: [
        [
          {
            input: { address: EXAMPLE_ADDRESS },
            output: {
              status: "success",
              escrow: { address: EXAMPLE_ADDRESS, amount: "5000000", state: "FUNDED" },
            },
            explanation: "See whether the worker has delivered yet.",
          },
        ],
      ],
      schema: readEscrowSchema,
      run: async (client, { address }) => {
        const escrow = await client.getEscrow(address);
        return success({ escrow: { ...escrow, amount: escrow.amount.toString() } });
      },
    }),
    define(clientOf, {
      name: "escro_find_workers",
      similes: ["find workers", "browse the bot directory"],
      description:
        "List worker bots from the EscroBots directory, in the directory's order. Capabilities are the workers' own unverified claims.",
      examples: [
        [
          {
            input: { capability: "translate", limit: 5, offset: null },
            output: { status: "success", workers: [] },
            explanation: "Find up to five workers claiming a translation capability.",
          },
        ],
      ],
      schema: findWorkersSchema,
      run: async (client, { capability, limit, offset }) =>
        success({
          workers: await client.findWorkers({
            ...(capability != null && { capability }),
            ...(limit != null && { limit }),
            ...(offset != null && { offset }),
          }),
        }),
    }),
    define(clientOf, {
      name: "escro_reputation",
      similes: ["check reputation", "read a wallet's history"],
      description:
        "Read the raw on-chain reputation components of the named wallets. Escro computes no score; the agent weighs them itself.",
      examples: [
        [
          {
            input: { wallets: [EXAMPLE_ADDRESS] },
            output: { status: "success", reputations: [], missing: [EXAMPLE_ADDRESS] },
            explanation: "Check a worker's history before commissioning it.",
          },
        ],
      ],
      schema: reputationSchema,
      run: async (client, { wallets }) => {
        const all = new Map((await client.listReputations()).map((r) => [r.wallet, r]));
        return success({
          reputations: wallets.flatMap((wallet) => all.get(wallet) ?? []),
          missing: wallets.filter((wallet) => !all.has(wallet)),
        });
      },
    }),
    define(clientOf, {
      name: "escro_pay_402",
      similes: ["pay a 402", "pay for a resource", "x402 payment"],
      description:
        "Pay a resource that answers HTTP 402, only to the wallet and for the amount you name. Each call pays; there is no retry protection. " +
        "A URL whose host is a loopback, link-local or private address, or a name that resolves to one, is refused unless the operator set createEscroPlugin's allowPrivateHosts option; on mainnet only https: URLs are paid. " +
        `An escrow whose deadline is later than now plus maxDeadlineSeconds (default ${String(PAY_402_MAX_DEADLINE_SECONDS)}, 7 days; you may only lower it) is refused before anything is signed or funded.`,
      examples: [
        [
          {
            input: {
              url: "https://worker.example.com/v1/data",
              to: EXAMPLE_ADDRESS,
              amountMicroUsdc: 1_000_000,
              contentType: null,
              body: null,
            },
            output: {
              status: "success",
              rail: "x402",
              reference: EXAMPLE_SIGNATURE,
              response: {
                status: 200,
                contentType: "text/plain",
                body: "the data",
                bodyTruncated: false,
              },
            },
            explanation: "Pay 1 USDC for the data at this URL.",
          },
        ],
      ],
      schema: pay402Schema,
      run: (client, input) => pay402(client, input, guards),
    }),
  ];
}
