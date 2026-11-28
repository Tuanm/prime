// The ports the end-to-end tests start gateways on, shifted so that two runs on one machine do not meet.
//
// Every test names its ports as 88xx. Left as they are, two runs at once (two worktrees, a reviewer and an author, a
// run that was killed and left its worker behind) start workers on the same ports and fail in ways that look like
// bugs in the gateway. So a port is shifted by an offset: SMOKE_PORT_OFFSET if it is set, else a number from the
// path of this checkout, a multiple of 100 from 0 to 9900, which keeps the checkouts of one machine apart.
import { createHash } from "node:crypto";

const ROOT = import.meta.dir + "/..";

function offset(): number {
  const given = process.env.SMOKE_PORT_OFFSET;
  if (given !== undefined && given !== "") {
    const n = Number(given);
    if (!Number.isInteger(n) || n < 0 || n > 9900) throw new Error("SMOKE_PORT_OFFSET is a whole number from 0 to 9900, not " + given);
    return n;
  }
  return (createHash("sha256").update(ROOT).digest().readUInt16BE(0) % 100) * 100;
}

const shift = offset();

/** The port a test names (8801, 8842, ...) as it is on this checkout. */
export const port = (n: number): number => n + shift;
