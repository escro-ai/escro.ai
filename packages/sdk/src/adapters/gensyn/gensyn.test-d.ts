/**
 * Compile-time contract for the Gensyn buyer policy and pin port: the resolver and the spec are
 * required, and `GensynAdapterConfig["pin"]` keeps its published type in both directions. Each
 * `@ts-expect-error` must be an error for `tsc --noEmit` (the SDK typecheck) to pass; the complete
 * object is the positive control. The names come from the `@escro/sdk` root.
 */
import type { TaskSpec } from "@escro/shared";

import type {
  GensynAdapterConfig,
  GensynProofAutoReleaseOptions,
  ResolveProofUri,
} from "../../index.js";

declare const spec: TaskSpec;
const resolveProofUri: ResolveProofUri = () => "";

const complete: GensynProofAutoReleaseOptions = { resolveProofUri, spec };

// @ts-expect-error resolveProofUri is required: without it no bundle can be resolved.
const withoutResolver: GensynProofAutoReleaseOptions = { spec };

// @ts-expect-error spec is required: the buyer verifies against the task it commissioned.
const withoutSpec: GensynProofAutoReleaseOptions = { resolveProofUri };

type PublishedPin = ((content: string | Buffer) => Promise<string>) | undefined;
declare const pinPort: GensynAdapterConfig["pin"];
declare const publishedPin: PublishedPin;
const pinIsPublished: PublishedPin = pinPort;
const publishedIsPin: GensynAdapterConfig["pin"] = publishedPin;

void complete;
void withoutResolver;
void withoutSpec;
void pinIsPublished;
void publishedIsPin;
