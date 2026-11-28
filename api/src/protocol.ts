// Shared envelope types for gateway <-> client communication.
// Wire-compatible with the Bun gateway (gateway/protocol.ts).

export interface RegisterMessage {
  type: "register";
  deviceId: string;
  /** What this device can do beyond the base protocol, e.g. "call-raw-only" (see call-sig.ts). Older gateways ignore it. */
  capabilities?: string[];
}

export interface RegisteredMessage {
  type: "registered";
  deviceId: string;
}

// App-layer heartbeat. Data frames survive HTTP/2 tunnels (e.g. Cloudflare
// Zero Trust) that may swallow WS control ping/pong. Clients send keepalive
// every ~25s; server replies with keepalive-ack.
export interface KeepaliveMessage {
  type: "keepalive";
}

export interface KeepaliveAckMessage {
  type: "keepalive-ack";
}

export interface TunnelRequest {
  id: string;
  /** Left out of a signed call sent to a device that reads it from `raw` alone (`call-raw-only`). */
  request?: JsonRpcRequest;
  token?: string;
  /** Which MCP client sent it: a stable per-client id (salted hash, not the
   *  IP) and the name it gave in initialize. Devices may ignore it. */
  client?: { id: string; name: string };
  /** Only on a call the client signed: the request body exactly as it arrived (the signature is over
   *  these bytes; `request` is the parsed copy and is not what was signed). */
  raw?: string;
  /** Only on a call the client signed: the `x-prime-call-sig` header as it arrived. */
  callerSig?: string;
}

export interface TunnelResponse {
  id: string;
  /** May be left out by a device that sends `responseText` (the same answer, as text). */
  response?: JsonRpcResponse;
  /** The device's signature over its answer; returned to the caller as `x-prime-reply-sig`. */
  replySig?: string;
  /** The exact text the device signed; when present it is the response body, untouched. */
  responseText?: string;
}

export interface TunnelError {
  id: string;
  error: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type DeviceMessage =
  | RegisterMessage
  | RegisteredMessage
  | KeepaliveMessage
  | KeepaliveAckMessage;
export type TunnelMessage = TunnelRequest | TunnelResponse | TunnelError;
