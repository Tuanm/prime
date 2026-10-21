import { describe, expect, test } from "bun:test";
import { ipBlockKey } from "../src/config";

describe("ipBlockKey", () => {
  test("IPv4 is exact, IPv6 is its /64, mapped IPv4 collapses", () => {
    expect(ipBlockKey("203.0.113.7")).toBe("ipv4:203.0.113.7");
    expect(ipBlockKey("::ffff:203.0.113.7")).toBe("ipv4:203.0.113.7");
    expect(ipBlockKey("2001:bc8:17c0:420:1623:f2ff:fef0:d8c0")).toBe("ipv6:2001:bc8:17c0:420::/64");
    // Another host in the same /64 shares the key; another /64 does not.
    expect(ipBlockKey("2001:bc8:17c0:420:aaaa:bbbb:cccc:dddd")).toBe("ipv6:2001:bc8:17c0:420::/64");
    expect(ipBlockKey("2001:bc8:17c0:421::1")).toBe("ipv6:2001:bc8:17c0:421::/64");
    expect(ipBlockKey("2001:DB8:0:0::1")).toBe("ipv6:2001:db8:0:0::/64");
    expect(ipBlockKey("::1")).toBe("ipv6:0:0:0:0::/64");
  });

  test("junk is refused", () => {
    expect(ipBlockKey("")).toBeNull();
    expect(ipBlockKey("unknown")).toBeNull();
    expect(ipBlockKey("999.1.1.1")).toBeNull();
    expect(ipBlockKey("not-an-ip")).toBeNull();
    expect(ipBlockKey("2001:xyz::1")).toBeNull();
  });
});
