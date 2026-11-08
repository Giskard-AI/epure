import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedUpstreamRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeLlmUpstream {
  readonly url: string;
  readonly requests: RecordedUpstreamRequest[];
  close(): Promise<void>;
}

// A provider stand-in on 127.0.0.1 that records what the proxy forwarded.
export async function startFakeLlmUpstream(
  respond: (req: RecordedUpstreamRequest, res: ServerResponse) => void | Promise<void>
): Promise<FakeLlmUpstream> {
  const requests: RecordedUpstreamRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8")
      };
      requests.push(recorded);
      void respond(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

export interface RawProxyResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly rawBody: Buffer;
}

// Sends request lines fetch() refuses to build (absolute-form targets, CONNECT, dot segments).
export function rawProxyRequest(
  proxyUrl: string,
  params: {
    readonly method: string;
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  }
): Promise<RawProxyResponse> {
  const { hostname, port } = new URL(proxyUrl);
  return new Promise((resolve) => {
    const req = request(
      { host: hostname, port, method: params.method, path: params.path, headers: params.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const rawBody = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: rawBody.toString("utf8"),
            rawBody
          });
        });
      }
    );
    const empty = { headers: {}, body: "", rawBody: Buffer.alloc(0) };
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, ...empty });
    });
    req.on("error", () => resolve({ status: 0, ...empty }));
    req.end(params.body);
  });
}
