import { describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { ADMIN_HTML } from "../src/admin-ui";

const origin = { ip: "203.0.113.7", country: "NL", region: "North Holland", city: "Amsterdam", asn: 12876, as: "Scaleway", colo: "AMS", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", at: "2026-10-21T09:41:45.779Z" };

/** The admin page from a real origin, with /admin/api/** answered by fixed data. */
async function openAdmin(): Promise<{ page: Page; close: () => Promise<void>; blocked: () => boolean }> {
  const browser: Browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 760 } })).newPage();
  let blocked = false;
  await page.route("**/admin/api/**", (route) => {
    const url = new URL(route.request().url());
    const json = (o: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (url.pathname === "/admin/api/devices") return json({ devices: [{ deviceId: "ui-dev", token: "x", online: true }, { deviceId: "other-dev", online: false }], count: 2, max_devices: 100 });
    if (url.pathname === "/admin/api/anonymous") return json({ devices: [{ ref: "e8aaeb02ffffffffffffffff", online: true, disabled: false, locked: false, createdAt: Date.now() - 60_000, lastSeenAt: Date.now() - 5_000 }], count: 3, max_devices: 100 });
    if (url.pathname.endsWith("/origin")) {
      if (url.pathname.includes("/anonymous/")) return json({ online: true, origin: { ...origin, ip: "2001:bc8:17c0:420::d8c0" }, block_key: "ipv6:2001:bc8:17c0:420::/64", blocked });
      return json({ online: true, origin, block_key: "ipv4:203.0.113.7", blocked });
    }
    if (url.pathname === "/admin/api/blocked" && route.request().method() === "POST") {
      blocked = JSON.parse(route.request().postData() || "{}").blocked === true;
      return json({ ok: true, key: "ipv4:203.0.113.7", blocked });
    }
    return json({});
  });
  await page.route((u) => new URL(u).pathname === "/devices", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ online: ["ui-dev"] }) }));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/admin") return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      return Response.json({});
    },
  });
  await page.goto("http://127.0.0.1:" + server.port + "/admin", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector("li.row", { timeout: 15_000 });
  return {
    page,
    blocked: () => blocked,
    close: async () => {
      await browser.close();
      server.stop(true);
    },
  };
}

async function rowWith(page: Page, value: string) {
  const rows = page.locator("li.row");
  for (let i = 0; i < (await rows.count()); i++) {
    if ((await rows.nth(i).locator("input.id-input").inputValue().catch(() => "")) === value) return rows.nth(i);
  }
  throw new Error("row not found: " + value);
}

describe("admin View dialog", () => {
  test("View comes first, shows where the device connects from, and blocks its address", async () => {
    const admin = await openAdmin();
    try {
      const { page } = admin;
      const row = await rowWith(page, "ui-dev");
      await row.locator(".menu-btn").click();
      expect(await row.locator(".menu button").allTextContents()).toEqual(["View", "Tools", "Clients", "Save", "Deactivate", "Delete"]);
      await row.locator(".menu button", { hasText: "View" }).click();
      await page.waitForFunction(() => /203\.0\.113\.7/.test(document.querySelector(".dlg-body")?.textContent || ""), null, { timeout: 15_000 });
      const body = (await page.textContent(".dlg-body")) || "";
      expect(body).toContain("IP address");
      expect(body).toContain("Amsterdam");
      expect(body).toContain("Scaleway");
      expect(body).toContain("AMS edge");
      expect(body).toContain("ipv4:203.0.113.7");
      expect(body).not.toContain("(blocked)");
      // The button must look like the rest of the page (not a native control).
      const look = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll(".dlg-bar .btn")).find((el) => el.textContent === "Block") as HTMLElement;
        const s = getComputedStyle(b);
        return { bg: s.backgroundColor, color: s.color, border: s.borderTopWidth + " " + s.borderTopColor, radius: s.borderRadius, font: s.fontFamily };
      });
      expect(look.bg).toBe("rgb(185, 28, 28)");
      expect(look.color).toBe("rgb(255, 255, 255)");
      expect(look.border).toBe("1px rgb(185, 28, 28)");
      expect(look.radius).toBe("0px");
      expect(look.font.toLowerCase()).toContain("mono");
      expect(await page.evaluate(() => Array.from(document.querySelectorAll(".dlg-bar")).every((el) => getComputedStyle(el).display === "flex"))).toBe(true);
      await page.click('.dlg-bar .btn:has-text("Block")');
      await page.waitForFunction(() => /\(blocked\)/.test(document.querySelector(".dlg-body")?.textContent || ""), null, { timeout: 15_000 });
      expect(admin.blocked()).toBe(true);
      expect(await page.isVisible('.dlg-bar .btn:has-text("Unblock")')).toBe(true);
      await page.click('.dlg-bar .btn:has-text("Unblock")');
      await page.waitForFunction(() => !/\(blocked\)/.test(document.querySelector(".dlg-body")?.textContent || ""), null, { timeout: 15_000 });
      expect(admin.blocked()).toBe(false);
      expect(await page.isVisible('.dlg-bar .btn:has-text("Block")')).toBe(true);
    } finally {
      await admin.close();
    }
  }, 60_000);

  test("anonymous devices get the same View, blocking the IPv6 /64", async () => {
    const admin = await openAdmin();
    try {
      const { page } = admin;
      const row = await rowWith(page, "e8aaeb02");
      await row.locator(".menu-btn").click();
      expect((await row.locator(".menu button").allTextContents())[0]).toBe("View");
      await row.locator(".menu button", { hasText: "View" }).click();
      await page.waitForFunction(() => /2001:bc8/.test(document.querySelector(".dlg-body")?.textContent || ""), null, { timeout: 15_000 });
      const body = (await page.textContent(".dlg-body")) || "";
      expect(body).toContain("ipv6:2001:bc8:17c0:420::/64");
      expect(await page.isVisible('.dlg-bar .btn:has-text("Block")')).toBe(true);
    } finally {
      await admin.close();
    }
  }, 60_000);
});
