import {
  ADAPTER_IDS,
  NETWORKS,
  TEMPLATES,
  type AdapterId,
  type BotTemplate,
  type SolanaCluster,
} from "./config.js";

export interface ParsedArgs {
  name?: string;
  template?: BotTemplate;
  adapter?: AdapterId;
  network?: SolanaCluster;
  confirmMainnet: boolean;
  spendCap?: number;
  apiUrl?: string;
  fromMcp?: string;
  tools?: string[];
  registerMcp: boolean;
  register: boolean;
  telemetry: boolean;
  report: boolean;
  help: boolean;
  version: boolean;
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`Invalid value "${value}" for ${flag}. Expected one of: ${allowed.join(", ")}.`);
}

/**
 * Parse `process.argv.slice(2)` into a flag bag. Missing choice flags are left
 * undefined for the interactive resolver to fill; invalid values throw loudly.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    confirmMainnet: false,
    registerMcp: false,
    register: true,
    telemetry: true,
    report: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith("-")) {
      if (args.name === undefined) {
        args.name = token;
        continue;
      }
      throw new Error(`Unexpected extra argument "${token}".`);
    }

    // Support both `--flag value` and `--flag=value`.
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const takeValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`Flag ${flag} expects a value.`);
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case "--template":
      case "-t":
        args.template = oneOf("--template", takeValue(), TEMPLATES);
        break;
      case "--adapter":
      case "-a":
        args.adapter = oneOf("--adapter", takeValue(), ADAPTER_IDS);
        break;
      case "--network":
      case "-n":
        args.network = oneOf("--network", takeValue(), NETWORKS);
        break;
      case "--confirm-mainnet":
        args.confirmMainnet = true;
        break;
      case "--spend-cap": {
        const raw = takeValue();
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          throw new Error(`--spend-cap expects a USDC amount, got "${raw}".`);
        }
        args.spendCap = value;
        break;
      }
      case "--api-url":
        args.apiUrl = takeValue();
        break;
      case "--from-mcp":
        args.fromMcp = takeValue();
        break;
      case "--tools":
        args.tools = takeValue().split(",");
        break;
      case "--register-mcp":
        args.registerMcp = true;
        break;
      case "--no-register":
        args.register = false;
        break;
      case "--no-telemetry":
        args.telemetry = false;
        break;
      case "--report":
        args.report = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return args;
}
