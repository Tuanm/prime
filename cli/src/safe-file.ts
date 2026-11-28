// Reading a file that something else controls (a space puts what it likes in its state directory): the host process that reads it must not wait on it,
// follow a link out of the directory, or take in more of it than it needs.

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export interface ControlledRead {
  text: string;
  /** Only the end of the file was read (it is longer than the limit). */
  truncated: boolean;
}

/**
 * The text of a file, or undefined when there is none. A link is not followed and a file that is not a regular one (a named pipe, a device) is not opened
 * for reading: both throw, and so does a file longer than `maxBytes` unless `tail` is asked for, which reads its last `maxBytes`. O_NONBLOCK keeps the
 * open of a named pipe that nobody writes to from waiting for a writer.
 */
export function readControlledFile(path: string, maxBytes: number, options: { tail?: boolean } = {}): ControlledRead | undefined {
  let fd: number;
  try {
    // O_NOFOLLOW and O_NONBLOCK are not there on Windows; the check of the kind of file below is.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new Error(`${path} is a link, and is not read`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file, and is not read`);
    if (st.size > maxBytes && options.tail !== true) throw new Error(`${path} is longer than ${maxBytes} bytes, and is not read`);
    const length = Math.min(st.size, maxBytes);
    const buffer = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buffer, got, length - got, st.size - length + got);
      if (n === 0) break;
      got += n;
    }
    return { text: buffer.subarray(0, got).toString("utf8"), truncated: st.size > length };
  } finally {
    closeSync(fd);
  }
}
