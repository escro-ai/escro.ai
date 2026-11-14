import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { lazyBody, webRequest } from "./node-request.js";
import type { X402Menu } from "./index.js";

const fallThrough = (_request: FastifyRequest, reply: FastifyReply): FastifyReply => {
  reply.callNotFound();
  return reply;
};

/**
 * The menu as a Fastify plugin, registered before the routes it guards. Applies to the whole instance (no encapsulation
 * of its own). Answers at preParsing, before a content-type parser can reject a body the menu's own rule has to read, and
 * adds the spec and poll GET routes.
 */
export function x402Plugin(menu: X402Menu): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = (app) => {
    app.addHook("preParsing", (request, reply, payload, done) => {
      const web = webRequest(request.raw, () => lazyBody(payload));
      if (web === undefined) {
        done(null, payload);
        return;
      }
      menu
        .fetch(web)
        .then(async (response) => {
          if (response === undefined) {
            done(null, payload);
            return;
          }
          const body = Buffer.from(await response.arrayBuffer());
          // `done` is not called: the answer is sent and the route's handler must not run.
          void reply.headers(Object.fromEntries(response.headers)).code(response.status).send(body);
        })
        .catch((err: unknown) => {
          done(err instanceof Error ? err : new Error(String(err)));
        });
    });
    app.get(`${menu.paths.spec}/:file`, fallThrough);
    app.get(`${menu.paths.poll}/:escrow`, fallThrough);
    return Promise.resolve();
  };
  return Object.assign(plugin, {
    [Symbol.for("skip-override")]: true,
    [Symbol.for("fastify.display-name")]: "@escro/x402-middleware",
  });
}
