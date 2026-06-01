// Shared envelope types for gateway <-> client communication

export interface RegisterMessage {
  type: 'register';
  deviceId: string;
}

export interface RegisteredMessage {
  type: 'registered';
  deviceId: string;
}

// App-layer heartbeat. Data frames survive HTTP/2 tunnels (e.g. Cloudflare
// Zero Trust) that may swallow WS control ping/pong. Clients send keepalive
// every ~25s; server replies with keepalive-ack.
export interface KeepaliveMessage {
  type: 'keepalive';
}

export interface KeepaliveAckMessage {
  type: 'keepalive-ack';
}

export interface TunnelRequest {
  id: string;
  request: JsonRpcRequest;
  token?: string;
}

export interface TunnelResponse {
  id: string;
  response: JsonRpcResponse;
}

export interface TunnelError {
  id: string;
  error: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
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
