# Changelog

## 0.1.0

### Added

- The 402 menu: `createX402Menu`, the `./express` handler and the `./fastify` plugin.
- `bazaar` on a route and `service` (`serviceName`, `tags`, `iconUrl`) on the menu: every 402 of
  the route carries the declaration as `extensions.bazaar` beside `extensions.escro`, and its
  `resource` the service metadata; a paid `exact` request forwards the menu's own declaration and
  resource to the facilitator, so a discovery catalog can list the route. `createX402Menu` refuses
  a declaration over 1 024 bytes and service metadata a catalog would drop, naming the field. A
  route without `bazaar` carries no `extensions.bazaar`, and on a menu without `service` its
  `resource` names no service metadata. See the README's Discovery.
- `settleExact` on a route and `facilitator` (with `facilitatorCacheMs`) on the menu: the menu
  offers an `exact` entry it builds itself beside `on-delivery`, settles a payment of it through the
  facilitator, and answers the paid request with your `serve`'s answer and the settlement's
  `PAYMENT-RESPONSE`. A route without `settleExact` offers no `exact` entry the menu builds: its
  402 lists the `on-delivery` entry and any `exact` entries the route declares itself. See the
  README's `exact` entries.
- `createX402Menu` refuses a route `description` that is empty, over 500 UTF-8 bytes, or holds a
  control character or a lone surrogate, naming the field.
- The 402's `extensions.escro.schema` is a reference to the published schema,
  `{"$ref": "https://escro.ai/schemas/escro-extension/0.4.json"}`. A default route's 402 is about
  1.5 KB and the buyer's echoing paid request about 2.0 KB, under the nginx and Apache default line
  limits. A paid request is claimed whatever `schema` it echoes. See the README's header sizes
  behind a proxy.
