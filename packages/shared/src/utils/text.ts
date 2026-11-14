// The one U+0000 rule: a text column refuses U+0000, so no value the store keeps may hold it. The
// request validators and the chain ingester's store rules both read it. A leaf: it imports nothing.

/** False exactly when `value` holds U+0000, which a text column refuses. */
export function storableText(value: string): boolean {
  return !value.includes("\u0000");
}
