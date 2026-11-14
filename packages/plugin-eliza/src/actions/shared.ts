import { EscroError, SPEND_CAP_ERROR_CODES } from "@escro/sdk";
import type { HandlerOptions, IAgentRuntime, Memory } from "../eliza.js";
import { ActionInputError, ChatInputRefusedError } from "../errors.js";

/** Decides whether a chat message may supply fund-moving input as text. */
export type ChatInputAuthorizer = (message: Memory) => boolean | Promise<boolean>;

export const CHAT_INPUT_SETTING = "ESCRO_CHAT_INPUT_CONSENT";
export const CHAT_INPUT_RISK_ACKNOWLEDGED =
  "anyone who can message this agent can spend its wallet";
export const CHAT_INPUT_REFUSED =
  "text in a chat message cannot spend this wallet unless the operator authorizes it: see authorizeChatInput and ESCRO_CHAT_INPUT_CONSENT in the README.";

const FENCED_JSON = /```json[ \t]*\r?\n([\s\S]*?)```/;
const ONCE_CAPACITY = 1000;

/**
 * An action's input: `options[key]`, then `message.content[key]`, then the first fenced json block
 * of the message text. Only the block path asks `admit`, and it asks before the block is parsed, so
 * an unadmitted sender learns nothing about their block.
 */
export async function readActionInput(
  message: Memory,
  options: HandlerOptions | undefined,
  key: string,
  admit: () => Promise<boolean>,
): Promise<unknown> {
  const fromOptions = options?.[key];
  if (fromOptions !== undefined) return fromOptions;
  const fromContent = message.content[key];
  if (fromContent !== undefined) return fromContent;

  const block =
    typeof message.content.text === "string" ? FENCED_JSON.exec(message.content.text) : null;
  if (block === null) return undefined;

  let admitted = false;
  try {
    admitted = await admit();
  } catch (err) {
    throw new ChatInputRefusedError(CHAT_INPUT_REFUSED, { cause: err });
  }
  if (!admitted) throw new ChatInputRefusedError(CHAT_INPUT_REFUSED);

  try {
    return JSON.parse(block[1] ?? "") as unknown;
  } catch (err) {
    throw new ActionInputError("the fenced json block is not valid JSON", { cause: err });
  }
}

/** The fund-moving actions' gate: the operator's authorizer alone, or else the exact sentence. */
export function chatInputGate(
  deps: { authorizeChatInput?: ChatInputAuthorizer },
  runtime: IAgentRuntime,
  message: Memory,
): () => Promise<boolean> {
  return async () => {
    if (deps.authorizeChatInput !== undefined) {
      // A hook typed boolean can still answer anything at run time; only `true` admits.
      const answer: unknown = await deps.authorizeChatInput(message);
      return answer === true;
    }
    return runtime.getSetting(CHAT_INPUT_SETTING) === CHAT_INPUT_RISK_ACKNOWLEDGED;
  };
}

/** Refuses a field that only the operator may supply, wherever a message could carry it. */
export function refuseSiblings(
  message: Memory,
  options: HandlerOptions | undefined,
  names: readonly string[],
): void {
  for (const name of names) {
    if ((options !== undefined && name in options) || name in message || name in message.content) {
      throw new ActionInputError(`${name} cannot be supplied in a message or action options`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const fields = Object.keys(source)
      .filter((key) => source[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What `once` needs of a result: a failure that carries a handle in `data` may have moved money. */
export interface OnceResult {
  success: boolean;
  data?: Record<string, unknown>;
}

export type Once = <R extends OnceResult>(
  messageId: string | undefined,
  input: unknown,
  run: () => Promise<R>,
) => Promise<R>;

/**
 * One action instance's replay memory: a redelivered message and input share the first run's
 * result, in flight or settled. A failure with no handle moved nothing, so it is forgotten and may
 * be retried. Without a message id there is nothing to recognize a replay by.
 */
export function createOnce(): Once {
  const results = new Map<string, Promise<OnceResult>>();
  return <R extends OnceResult>(
    messageId: string | undefined,
    input: unknown,
    run: () => Promise<R>,
  ): Promise<R> => {
    if (messageId === undefined) return run();
    const key = `${messageId}\n${canonicalJson(input)}`;
    const known = results.get(key);
    // Only `run` below ever stores under this key, so the entry is this caller's R.
    if (known !== undefined) return known as Promise<R>;

    const result = run();
    results.set(key, result);
    if (results.size > ONCE_CAPACITY) {
      const oldest = results.keys().next().value;
      if (oldest !== undefined) results.delete(oldest);
    }
    const forgetIfRetryable = (settled: OnceResult | null): void => {
      if (settled === null || (!settled.success && settled.data === undefined)) {
        results.delete(key);
      }
    };
    result.then(forgetIfRetryable, () => {
      forgetIfRetryable(null);
    });
    return result;
  };
}

export interface FailureHandle {
  escrowPda: string;
  signature: string;
}

/** A failure's on-chain handle, read structurally: a consumer's SDK copy has other error classes. */
export function failureHandle(err: unknown): FailureHandle | null {
  if (typeof err !== "object" || err === null) return null;
  const { escrowPda, createSignature, signature, address, code } = err as Record<string, unknown>;
  const funded = createSignature ?? signature;
  if (typeof escrowPda === "string" && typeof funded === "string") {
    return { escrowPda, signature: funded };
  }
  // TX_FAILED is the one confirm code meaning the transaction moved nothing.
  if (typeof address === "string" && typeof signature === "string" && code !== "TX_FAILED") {
    return { escrowPda: address, signature };
  }
  return null;
}

/** Why an action failed, naming the operator setting when the spend cap refused it. */
export function failureReason(err: unknown, noun: string): string {
  if (err instanceof EscroError && err.code === SPEND_CAP_ERROR_CODES.required) {
    return (
      `a mainnet ${noun} needs a spend cap: set ESCRO_SPEND_CAP_USDC to the most USDC this ` +
      "agent may hold in open escrows, fees included."
    );
  }
  if (err instanceof EscroError && err.code === SPEND_CAP_ERROR_CODES.exceeded) {
    return (
      `this ${noun} would pass ESCRO_SPEND_CAP_USDC, the most USDC this agent may hold in ` +
      "open escrows, each counted as amount plus fee."
    );
  }
  return err instanceof Error ? err.message : String(err);
}

export function walletConfigured(runtime: IAgentRuntime): boolean {
  const secret = runtime.getSetting("ESCRO_WALLET_SECRET");
  return typeof secret === "string" && secret.length > 0;
}
