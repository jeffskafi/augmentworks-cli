import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

const defaultBodyLimit = 512 * 1024;

export interface ListeningServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function listenLoopback(server: Server): Promise<ListeningServer> {
  await new Promise<void>((fulfill, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      fulfill();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("HTTP test server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((fulfill, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else fulfill();
        });
      })
  };
}

export async function readJsonBody(request: IncomingMessage, limit = defaultBodyLimit): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error(`HTTP request body exceeded ${String(limit)} bytes`);
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  return source === "" ? undefined : JSON.parse(source);
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}
