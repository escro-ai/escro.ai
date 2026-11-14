// The one walk over a transaction's log messages that attributes `Program data:` lines to the
// program's own invocations; no other source walks them.
const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const EXIT = /^Program (\w+) (?:success|failed)/;
const DATA = "Program data: ";
const TRUNCATED = "Log truncated";

/** The logs end in `Log truncated`: what is left cannot say what the transaction did. */
export class LogTruncatedError extends Error {
  constructor() {
    super("the logs are truncated; their events cannot be trusted");
    this.name = "LogTruncatedError";
  }
}

export interface ProgramLogEvent {
  /** The line's index in the log messages. */
  logIndex: number;
  /** The top-level instruction under which the program's frame ran. */
  instructionIndex: number;
  /** The program frame's invocation depth: 1 at the top level, more when reached by CPI. */
  depth: number;
  /** The payload as logged (base64). */
  data: string;
}

export interface ProgramLogWalk {
  /** The program id of each top-level invocation, in instruction order. */
  topLevelPrograms: string[];
  /** Every `Program data:` line logged while one of `programId`'s frames was innermost. */
  events: ProgramLogEvent[];
  /** The top-level instructions under which `programId` was invoked by CPI (depth above 1). */
  cpiInstructionIndexes: number[];
}

/**
 * Walk `logs` keeping the invocation stack. A `Program data:` line is attributed to `programId`
 * only while that program's frame is innermost; a line under any other program's frame, at any
 * depth, is not. Throws {@link LogTruncatedError} on `Log truncated`, and a plain Error on frames
 * that do not nest.
 */
export function walkProgramLogs(logs: readonly string[], programId: string): ProgramLogWalk {
  const stack: { program: string; depth: number }[] = [];
  const walk: ProgramLogWalk = { topLevelPrograms: [], events: [], cpiInstructionIndexes: [] };
  for (const [logIndex, line] of logs.entries()) {
    if (line === TRUNCATED) throw new LogTruncatedError();
    const invoke = INVOKE.exec(line);
    if (invoke) {
      const program = invoke[1] ?? "";
      const depth = Number(invoke[2]);
      if (depth !== stack.length + 1) {
        throw new Error(
          `log line ${String(logIndex)} invokes at depth ${String(depth)} inside ${String(stack.length)} frames`,
        );
      }
      if (depth === 1) walk.topLevelPrograms.push(program);
      const instructionIndex = walk.topLevelPrograms.length - 1;
      if (
        depth > 1 &&
        program === programId &&
        !walk.cpiInstructionIndexes.includes(instructionIndex)
      ) {
        walk.cpiInstructionIndexes.push(instructionIndex);
      }
      stack.push({ program, depth });
      continue;
    }
    const exit = EXIT.exec(line);
    if (exit) {
      if (stack.pop()?.program !== exit[1]) {
        throw new Error(`log line ${String(logIndex)} exits a frame it did not enter`);
      }
      continue;
    }
    const top = stack.at(-1);
    if (!line.startsWith(DATA) || top?.program !== programId) continue;
    walk.events.push({
      logIndex,
      instructionIndex: walk.topLevelPrograms.length - 1,
      depth: top.depth,
      data: line.slice(DATA.length),
    });
  }
  return walk;
}
