// The tests run under bun and node, whose type packages are not installed here:
// the few things the tests use from them are declared, so that the tests are
// still checked against the witness's own types.
declare module "bun:test" {
  type Fn = () => unknown;
  interface Test {
    (name: string, fn: Fn): void;
    each(cases: unknown[][]): (name: string, fn: (...args: any[]) => unknown) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  export const test: Test;
  export function describe(name: string, fn: () => void): void;
  export function beforeEach(fn: Fn): void;
  export function expect(value: unknown): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string);
    query(sql: string): { all(...bindings: unknown[]): unknown[] };
    run(sql: string, bindings?: unknown[]): void;
  }
}
declare module "node:crypto" {
  export function createHash(alg: string): { update(data: string): { digest(): Uint8Array } };
  export function generateKeyPairSync(alg: string): { publicKey: { export(o: object): Uint8Array }; privateKey: unknown };
  export function sign(alg: null, data: Uint8Array, key: unknown): Uint8Array;
}
declare const Buffer: {
  from(data: string | Uint8Array): Uint8Array & { toString(enc?: string): string; subarray(start: number): Uint8Array };
};
