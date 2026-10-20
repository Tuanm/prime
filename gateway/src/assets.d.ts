// Wrangler's default module rules: .txt imports as a string, .bin as an ArrayBuffer.
declare module "*.txt" {
  const text: string;
  export default text;
}
declare module "*.bin" {
  const bytes: ArrayBuffer;
  export default bytes;
}
