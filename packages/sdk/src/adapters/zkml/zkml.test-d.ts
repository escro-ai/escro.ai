/**
 * Compile-time contract for the ZKML buyer policy: the resolver, the model pin and the input
 * commitment are required, so a buyer cannot build a policy that turns an unresolvable proof into
 * a dispute verdict. Each `@ts-expect-error` must be an error for `tsc --noEmit` (the SDK
 * typecheck) to pass; the complete objects are the positive controls. The names come from the
 * `@escro/sdk` root, so a dropped type export fails here too.
 */
import type {
  ResolveProofUri,
  ZkmlExpectation,
  ZkmlProofAutoReleaseOptions,
  ZkmlProofBundle,
} from "../../index.js";

const resolveProofUri: ResolveProofUri = () => Promise.resolve(Buffer.from(""));

const complete: ZkmlProofAutoReleaseOptions = {
  resolveProofUri,
  modelCommitment: "model",
  inputCommitment: "input",
};

// @ts-expect-error resolveProofUri is required: without it no proof can be resolved.
const withoutResolver: ZkmlProofAutoReleaseOptions = {
  modelCommitment: "model",
  inputCommitment: "input",
};

// @ts-expect-error modelCommitment is required: the buyer pins the model it hired.
const withoutModel: ZkmlProofAutoReleaseOptions = { resolveProofUri, inputCommitment: "input" };

// @ts-expect-error inputCommitment is required: the buyer commits to its own input.
const withoutInput: ZkmlProofAutoReleaseOptions = { resolveProofUri, modelCommitment: "model" };

const fullExpectation: ZkmlExpectation = {
  contentHash: "hash",
  modelCommitment: "model",
  inputCommitment: "input",
};

// @ts-expect-error ZkmlExpectation.modelCommitment is required.
const expectationWithoutModel: ZkmlExpectation = { contentHash: "hash", inputCommitment: "input" };

// @ts-expect-error ZkmlExpectation.inputCommitment is required.
const expectationWithoutInput: ZkmlExpectation = { contentHash: "hash", modelCommitment: "model" };

const bundle: ZkmlProofBundle = {
  content: "content",
  proof: {
    scheme: "s",
    modelCommitment: "m",
    inputCommitment: "i",
    outputHash: "o",
    verificationTag: "t",
  },
};

void complete;
void withoutResolver;
void withoutModel;
void withoutInput;
void fullExpectation;
void expectationWithoutModel;
void expectationWithoutInput;
void bundle;
