// Shared envelope types for gateway <-> client communication

export interface RegisterMessage {
  type: 'register';
  deviceId: string;
}

export interface RegisteredMessage {
  type: 'registered';
  deviceId: string;
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

export type DeviceMessage = RegisterMessage | RegisteredMessage;
export type TunnelMessage = TunnelRequest | TunnelResponse | TunnelError;
