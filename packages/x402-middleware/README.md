# @escro/x402-middleware

Serve an x402 402 menu from your HTTP server. Each configured route answers an unpaid request with a 402 offering the
`on-delivery` escrow entry (Escro's conditional-release scheme on Solana USDC) beside any `exact` entries you configure,
or beside an `exact` entry the menu builds and settles itself through a facilitator you inject (`settleExact`).
A paid request is checked over RPC, the claim lands with your own `Escro` client, and the buyer gets a 202 with a poll
URL. You do the work and submit; the buyer releases.

The middleware holds no key and reads no environment variable or file. Through the client you inject it calls only
`claimTask`, `submitDeliverable` and `confirm`.

`rpc` must offer `getAccountInfo` and `getSignatureStatuses`, and the client `claimTask`, `submitDeliverable` and
`confirm`: a `Connection` from `@solana/web3.js` and an `Escro` from `@escro/sdk` do. A hand-built client implements
`confirm` too.

## Use it

```ts
import { createX402Menu } from "@escro/x402-middleware";
import { x402Handler } from "@escro/x402-middleware/express";

const menu = createX402Menu({
  cluster: "mainnet",
  payTo: wallet.publicKey.toBase58(), // the wallet `escro` signs with
  escro,
  rpc: connection,
  publicUrl: "https://worker.example.com",
  routes: [
    {
      method: "POST",
      path: "/v1/summarise",
      priceMicroUsdc: 25_000_000n,
      workSeconds: 3_600,
      taskSpec: (request) => summaryTask(request.body),
      onClaimed: (job) => queue.push(job),
    },
  ],
});

app.use(x402Handler(menu)); // plain node:http: call the handler from the server's request listener
```

Entries:

- `.`: `createX402Menu` and `menu.fetch(request)`, a Web `Request`/`Response` handler (a Cloudflare Worker, Bun, Deno).
- `./express`: `x402Handler(menu)`, a connect-style handler for Express 5 and plain `node:http`, mounted at the server
  root.
- `./fastify`: `x402Plugin(menu)`, registered before the routes it guards (`fastify` `^4 || ^5` is an optional peer).
  Register your paid routes after it; the plugin adds the spec and poll GET routes.

`publicUrl` is your server's `https:` origin. The resource, spec and poll URLs are built from it and never from `Host`
or `X-Forwarded-*`. The spec document is served at `<publicUrl>/specs/<specHash>.json` and the buyer polls
`<publicUrl>/v1/jobs/<escrow>`; `specPath` and `pollPath` move them.

When the work is done, call `menu.submit(escrow, { contentHash, proofUri })`.

## Who collects

Only the buyer collects: the paid request and every poll carry the buyer's signature over the URL being served, once.
A retried request (a dropped connection, a restart) never claims or starts the work twice.

## A claim that throws after it was sent

A claim can land on chain after the client threw (a lost send response, an expired confirmation). When the rejection
carries the claim transaction's own `signature` (the `Escro` client attaches it), the menu reads that signature's
status: landed, it calls `confirm(escrow, signature)` so the API records the claim, then records the job and runs
`onClaimed` once, as for a confirmed claim; failed on chain at `confirmed` or `finalized`, the buyer gets a 409;
unknown, or failed at processed level only (a fork can drop that failure and the claim still land), a 503, and the
signature stays pending. Each presentation of that escrow re-reads its pending signatures: a signature still unseen (`null`) five
minutes (`CLAIM_HOLD_MS`) after it was added is dropped, and a landed one is handed off whenever it is read. An operator
that also resumes such jobs from its own loop must submit through `menu.submit`: the landed path then sees a `submitted`
record and does not hand the job off again. A custom `claim` hook that rejects with a `signature` must set it to that
claim's own transaction. The unknown signatures live in this process only: after a restart, a claim that landed is not
handed off again (resume it from your own loop).

## Header sizes behind a proxy

A route's 402 carries `extensions.escro` with its JSON schema by reference
(`{"$ref": "https://escro.ai/schemas/escro-extension/0.4.json"}`), and a buyer echoes the 402's `extensions` in the
paid request. With the default extension, a `publicUrl` of `https://worker.example.com` and the route `/v1/summarise`,
the header lines are:

| Header                                 | Size         | With `extension: false` |
| -------------------------------------- | ------------ | ----------------------- |
| `PAYMENT-REQUIRED` (the 402, response) | about 1.5 KB | about 1.0 KB            |
| `PAYMENT-SIGNATURE` (the paid request) | about 2.0 KB | about 1.5 KB            |
| `PAYMENT-RESPONSE` (the claim's 202)   | about 1.5 KB | about 0.3 KB            |

A route with `settleExact` adds about 0.4 KB to the 402 only (about 1.9 KB). A buyer paying its `exact` entry echoes
the 402's `resource` and `extensions` too: that `PAYMENT-SIGNATURE` is about 2.0 KB at most, and its 200's
`PAYMENT-RESPONSE` is a few hundred bytes.

Each character of `publicUrl` or the route path adds up to about 3 bytes to each line, and an `mcpServer` URL adds about
150 bytes to the 402 and the paid request.

A route that declares itself for discovery (a `bazaar` declaration, a `description` and the menu's `service`;
Discovery, below) carries them in every 402, and a buyer echoes them. At the same origin and route, with `settleExact`:

| Header                                           | The kit's example | Every field at its cap |
| ------------------------------------------------ | ----------------- | ---------------------- |
| `PAYMENT-REQUIRED` (the 402, response)           | about 2.7 KB      | about 5.9 KB           |
| `PAYMENT-SIGNATURE` (the paid `on-delivery` one) | about 2.8 KB      | about 6.0 KB           |
| `PAYMENT-SIGNATURE` (the paid `exact` one)       | about 2.7 KB      | about 5.9 KB           |

The claim's `PAYMENT-RESPONSE` stays about 1.5 KB and the `exact` 200's a few hundred bytes. The kit's example is the
worker template's commented `discovery` and service example; every field at its cap is a 1 024-byte declaration, a
500-byte description, a 512-byte `iconUrl`, a 32-character `serviceName` and five 32-character tags, each character as
long as JSON can encode it.

Each of these lines is under the default per-line limit of nginx (`large_client_header_buffers 4 8k`) and Apache
(`LimitRequestFieldSize 8190`), so a paid request passes a default proxy whatever a route declares within the caps.
nginx holds a response's headers in `proxy_buffer_size`, one memory page by default (4 KB or 8 KB): behind a 4 KB page,
a route whose 402 exceeds about 3.8 KB (a long description or a large declaration) answers the unpaid request 502
unless the buffer grows:

```nginx
proxy_buffer_size 8k; # the 402's PAYMENT-REQUIRED
```

A long `publicUrl` or large `acceptance` or `receipt` terms grow every line; measure yours against these limits.

Node's own `node:http` server (Express, Fastify, plain `node:http`) allows 16 KB for all of a request's headers
together by default (`maxHeaderSize`), so the paid request leaves at least about 10 KB for the rest. A test in this package keeps
each of these headers at or under 4 KB (4 096 bytes) for a default route and for the kit's example, and at or under
7 KB (7 168 bytes) with every field at its cap.

## HTTP/2

Fastify with `http2: true` works through `./fastify`. `x402Handler` is typed on `node:http`; under `node:http2` pass the
compatibility request and response with a cast:

```ts
import { createServer } from "node:http2";
import type { IncomingMessage, ServerResponse } from "node:http";

const handler = x402Handler(menu);
createServer((req, res) => {
  handler(req as unknown as IncomingMessage, res as unknown as ServerResponse, (err) => {
    res.statusCode = err === undefined ? 404 : 500;
    res.end();
  });
});
```

## `exact` entries

A route offers a direct `exact` payment beside its `on-delivery` entry in one of two ways.

**Your own entries (`exact`).** Entries of `exact` (or any other scheme) are route configuration, placed after the
`on-delivery` entry byte-identical. The middleware does not verify them: a payment of a scheme the route configures
reaches your next handler untouched; a scheme it does not configure is answered with a fresh 402. Configuring one is
your assertion that a verifier for it is mounted after this middleware.

**An entry the menu settles (`settleExact`).** The menu builds the entry itself and settles it through the facilitator
you pass as `facilitator` (the SDK's `createHttpFacilitator({ url })`, or any object with the same `verify`, `settle` and
`getSupported`). A route sets one or the other, never both.

```ts
import { createHttpFacilitator } from "@escro/sdk";

const menu = createX402Menu({
  // ...
  facilitator: createHttpFacilitator({ url: "https://facilitator.payai.network" }),
  routes: [
    {
      // ...the on-delivery route as above
      settleExact: {
        priceMicroUsdc: 50_000n, // no escrow minimum
        maxTimeoutSeconds: 120, // the default; from 10 to 3600
        serve: async ({ request, taskSpec }, signal) => ({
          contentType: "application/json",
          body: JSON.stringify(await summarise(request.body, signal)),
        }),
      },
    },
  ],
});
```

The entry pays the cluster's USDC to `payTo`, the amount `priceMicroUsdc`, and names the fee payer the facilitator's
`/supported` lists for `exact` on the cluster's network. Your key signs nothing and nothing reaches Escro: no escrow, no
claim, no job record. The `/supported` answer is reused for `facilitatorCacheMs` (default 5 minutes) and a failed read
is retried after 30 s. An unpaid request waits at most 2 s for a read in flight, then offers `on-delivery` alone; a paid
`on-delivery` request never waits on the facilitator. A 402 issued just before the fee payer changes can still be paid
for `maxTimeoutSeconds` after the change.

A paid `exact` request is answered within `maxTimeoutSeconds` less one second (`D`). The menu derives the TaskSpec from
the body first, checks the presented terms against its own entry, then asks the facilitator to verify and to settle,
sending only its own entry, its own `resource`, its route's own `bazaar` declaration and the payment's `transaction`. `serve` runs once per settled payment,
after the settle:

| Outcome                                                                 | Status | `error`                                                    |
| ----------------------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| no fee payer known by `D`                                               | 402    | `exact_unavailable`                                        |
| the presented terms are not the menu's entry                            | 402    | `invalid_exact_accepted`                                   |
| no `payload.transaction`                                                | 402    | `invalid_exact_payload`                                    |
| the payment, or its settlement, was presented before                    | 409    | `exact_payment_replayed`                                   |
| `verify` refuses                                                        | 402    | its reason if a plain code, else `invalid_exact_payment`   |
| `verify` fails                                                          | 503    | `facilitator_unavailable`                                  |
| `D` passed before the settle                                            | 504    | `exact_deadline_passed`                                    |
| `settle` refuses with no transaction sent                               | 402    | its reason if a plain code, else `exact_settlement_failed` |
| `settle` fails, times out, or names a transaction it did not confirm    | 504    | `exact_settlement_unknown`                                 |
| `settle` succeeds for another network or amount, or with no transaction | 502    | `exact_settlement_invalid`                                 |
| settled at or after `D`, or `serve` still running at `D`                | 504    | `exact_service_timeout`                                    |
| `serve` rejects, or the replay store fails after the settle             | 500    | `exact_service_failed`                                     |
| `serve` answers                                                         | 200    | (your body and content type)                               |

The 200, and each 504 and 500 after the settle, carry the settlement's `PAYMENT-RESPONSE` (`success`, `transaction`,
`network`, `payer`): the buyer's proof of payment. Those three answers came after the buyer's USDC moved to you, and
`exact` has no refund path: there is no escrow behind it. An `exact_settlement_unknown` answer means the buyer may have
paid; a settle that may have sent a transfer is never answered with a fresh offer, so a buyer is not asked to pay twice.
The menu does not read the chain: it serves on the facilitator's word that it settled exactly the offered entry, so your
choice of facilitator is a trust decision. No facilitator message is answered to the buyer or logged.

Before you offer `exact`, create your wallet's USDC token account: without it the facilitator's verify fails and every
buyer is refused before any transfer. The facilitator URL must be `https:` with no username, password, query or
fragment; the upstream client follows redirects on `/verify` and `/settle`, so that check covers the URL you configure
only. A facilitator URL carrying a key does not belong in a committed config file. The upstream client prints
`[x402] extension responses: ...` to stdout. PayAI needs no key within its 1 000 free credits: on mainnet a settle costs
1.12 credits, so a keyless worker has about 890 settles before PayAI asks for one.

### A facilitator that needs a credential

`createHttpFacilitator` sends no credential. A facilitator that authenticates each request, such as Coinbase's CDP, is
your own wiring: pass as `facilitator` your own object with the `Facilitator` type's three methods,
`verify(payment, requirements)`, `settle(payment, requirements)` and `getSupported()`. Resolve a refusal as the
facilitator's answer (`isValid: false`, or `success: false` with any transaction it sent) and throw only when there is
no answer; the table above reads them that way. Your object signs CDP's authentication with your own credential, held
in your own code and read from your own environment. No Escro package or kit template holds, reads or ships that
credential. Never commit it or log it, and keep it out of the errors your object throws.

CDP's own limits apply. It refuses `verify` and `settle` for a resource whose `description` is over 500 characters, so
keep each route's `description` within that, or every `exact` payment through CDP fails (the menu refuses one over 500
bytes). CDP lists a route from the `bazaar` declaration its settle carries (Discovery, below) and drops a listed
resource after 30 days without a settle through it; `on-delivery` jobs never reach the facilitator, so they never
refresh the listing.

## Discovery (`bazaar` and `service`)

A discovery catalog (PayAI's, the CDP Bazaar) lists a route from what its facilitator receives with an `exact` payment.
A route's `bazaar` declares how the catalog calls it (an example request and, optionally, an example answer), and the
menu's `service` names the worker in every route's `resource`:

```ts
import { buildBazaarDeclaration } from "@escro/sdk";

const menu = createX402Menu({
  // ...
  service: {
    serviceName: "Example summarizer",
    tags: ["summarize"],
    iconUrl: "https://worker.example.com/icon.png",
  },
  routes: [
    {
      // ...the route with settleExact as above
      description: "Summarises a document posted as JSON.",
      bazaar: buildBazaarDeclaration({
        method: "POST",
        example: { text: "An example document." },
        output: { type: "json", example: { summary: "An example summary." } },
      }),
    },
  ],
});
```

Every 402 of the route carries the declaration as `extensions.bazaar`, beside `extensions.escro` (alone when
`extension` is `false`), and a `resource` of `url`, `description`, `mimeType`, `serviceName`, `tags` and `iconUrl`, each
from configuration and never from a request header. With a paid `exact` request the menu forwards its own declaration,
as `extensions.bazaar`, and its own resource to the facilitator's `verify` and `settle`; what the buyer echoed is never
forwarded. The catalog lists the route only after an `exact` payment to it settles: `on-delivery` payments never reach
a facilitator. It probes the route with the declaration's example request, unpaid, and expects a 402, so `taskSpec`
must accept that body.

`createX402Menu` refuses, naming the route or `service.<field>`:

- a `description` that is empty, over 500 UTF-8 bytes, not well-formed, or holds a control character;
- a `bazaar` over 1 024 bytes of JSON or that is not plain JSON, whose `info.input.type` is not `"http"` or whose
  `info.input.method` is not the route's, whose `schema` is not a Draft 2020-12 object, or that holds a `$ref` or `$id`
  other than a same-document `#` reference;
- a `serviceName` that is empty or not 1 to 32 printable ASCII characters;
- more than 5 `tags`, or one that is empty, not 1 to 32 printable ASCII characters, or a case-insensitive duplicate;
- an `iconUrl` that is not an absolute `https:` URL, carries a username or password, names an IP address or a loopback
  host, has a path ending `.svg` or `.svgz` (catalogs list JPG, PNG, WebP and GIF), holds a control character, or is
  over 512 bytes once JSON-encoded. The 402 serves it as parsed (`new URL(iconUrl).href`).

## Stores

The replay store and the job store default to memory, one per menu. A server running more than one process passes shared
ones (`replay`, `jobs`).
