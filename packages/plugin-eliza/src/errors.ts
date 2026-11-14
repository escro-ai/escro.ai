/** Base error for all @escro/plugin-eliza failures. */
export class EscroPluginError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Thrown when the commission parameters supplied by the agent/runtime are
 * missing or malformed (fails validation before any transaction is built).
 */
export class CommissionInputError extends EscroPluginError {}

/**
 * Thrown when the plugin's runtime settings are missing or invalid
 * (e.g. no wallet secret). Never carries secret material in its message.
 */
export class EscroConfigError extends EscroPluginError {}

/** Thrown when an action's input is refused before it is validated against the action's schema. */
export class ActionInputError extends EscroPluginError {}

/** Thrown when text in a chat message supplies fund-moving input the operator has not admitted. */
export class ChatInputRefusedError extends EscroPluginError {}
