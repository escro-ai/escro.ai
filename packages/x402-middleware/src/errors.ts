/** A claim hook throws it to refuse a job before claimTask; the buyer is answered 503 with the cancel step. */
export class ClaimRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimRefusedError";
  }
}
