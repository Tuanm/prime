import { describe, expect, test } from 'bun:test';
import { DownloadRelay } from '../src/download-relay';
const ticket = 'a'.repeat(64);
function setup(timeout = 1000) {
  const frames: any[] = [];
  const relay = new DownloadRelay((m) => frames.push(m), timeout);
  const abort = new AbortController();
  const response = relay.start(ticket, 'secret', abort.signal);
  const id = frames[0].id;
  const head = (length: string, extra: object = {}) => relay.frame({ type: 'download-head', id, status: 200, headers: { 'content-length': length, ...extra } });
  return { relay, frames, abort, response, id, head };
}
describe('download relay', () => {
  test('pull-driven binary stream, safe headers, exact bytes and completion', async () => {
    const x = setup(); x.head('3', { 'set-cookie': 'evil=1', 'content-disposition': 'inline' });
    const r = await x.response;
    expect(x.frames.length).toBe(1);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('content-disposition')).toBe('attachment');
    const reader = r.body!.getReader(); const read = reader.read();
    await Promise.resolve();
    expect(x.frames[1].type).toBe('download-pull');
    x.relay.frame({ type: 'download-chunk', id: x.id, data: 'AP+A', done: true });
    expect(Array.from((await read).value!)).toEqual([0, 255, 128]);
    expect((await reader.read()).done).toBe(true);
  });
  test('empty file', async () => {
    const x = setup(); x.head('0'); const r = await x.response; const p = r.arrayBuffer();
    await Promise.resolve(); x.relay.frame({ type: 'download-chunk', id: x.id, data: '', done: true });
    expect((await p).byteLength).toBe(0);
  });
  for (const length of ['104857601', '-1', '1e3', '', '01']) test('reject length ' + length, async () => {
    const x = setup(); x.head(length); expect((await x.response).status).toBe(502); expect(x.frames.at(-1).type).toBe('download-cancel');
  });
  for (const [data, done] of [['AA==', true], ['AAAA', true], ['!!!!', true], ['', false], ['A'.repeat(87384), true]] as const) test('reject bad or mismatched chunk ' + data.length + done, async () => {
    const x = setup(); x.head('2'); const r = await x.response; const p = r.arrayBuffer();
    const rejected = p.then(() => "resolved", e => e.message); await Promise.resolve();
    x.relay.frame({ type: 'download-chunk', id: x.id, data, done }); expect(await rejected).not.toBe("resolved");
    expect(await rejected).not.toContain("timeout");
    expect(x.frames.at(-1).type).toBe('download-cancel');
  });
  test('unsolicited chunks and duplicate heads fail', async () => {
    for (const duplicate of [false, true]) {
      const x = setup(); x.head('1'); const r = await x.response;
      x.relay.frame(duplicate ? { type: 'download-head', id: x.id, status: 200, headers: { 'content-length': '1' } } : { type: 'download-chunk', id: x.id, data: 'AA==', done: true });
      await expect(r.arrayBuffer()).rejects.toThrow();
    }
  });
  test('cancel, concurrency budget, disconnect and replacement cleanup', async () => {
    const x = setup(); const pending = [x.response];
    for (let n = 0; n < 3; n++) pending.push(x.relay.start(ticket, 'secret', new AbortController().signal));
    expect((await x.relay.start(ticket, 'secret', new AbortController().signal)).status).toBe(503);
    x.relay.failAll('device tunnel replaced');
    expect((await Promise.all(pending)).map(r => r.status)).toEqual([503, 503, 503, 503]);
    expect(x.frames.filter(f => f.type === 'download-cancel').length).toBe(4);
    const y = setup(); y.head('1'); const r = await y.response; await r.body!.cancel(); expect(y.frames.at(-1).type).toBe('download-cancel');
  });
  test('head and pull timeouts', async () => {
    const x = setup(10); expect((await x.response).status).toBe(504);
    const y = setup(10); y.head('1'); await expect((await y.response).arrayBuffer()).rejects.toThrow('timeout');
  });
  test('error status and signal cancellation', async () => {
    const x = setup(); x.relay.frame({ type: 'download-head', id: x.id, status: 410 }); expect((await x.response).status).toBe(410);
    const y = setup(); y.abort.abort(); expect((await y.response).status).toBe(499);
  });
});
