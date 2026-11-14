import type { IncomingMessage, ServerResponse } from "node:http";

import { lazyBody, parsedBody, webRequest } from "./node-request.js";
import type { X402Menu } from "./index.js";

async function serve(
  menu: X402Menu,
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  next: (err?: unknown) => void,
): Promise<void> {
  let response: Response | undefined;
  try {
    const request = webRequest(req, () =>
      req.body === undefined ? lazyBody(req) : parsedBody(req.body, req.headers["content-type"]),
    );
    response = request === undefined ? undefined : await menu.fetch(request);
    if (response !== undefined) {
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    }
  } catch (err) {
    next(err);
    return;
  }
  if (response === undefined) next();
}

/**
 * The menu as a connect-style handler, for Express 5 and plain `node:http`, mounted at the server root. A request the
 * menu passes on reaches `next` with its stream unread.
 */
export function x402Handler(
  menu: X402Menu,
): (
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void {
  return (req, res, next) => {
    void serve(menu, req, res, next);
  };
}
