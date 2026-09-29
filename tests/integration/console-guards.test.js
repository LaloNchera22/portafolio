// @vitest-environment jsdom
// Guards found by browser QA: account closure must confirm against the saved
// username, withdrawals must not round or overdraw, and console pages must
// be real history entries.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HTML = readFileSync(resolve(import.meta.dirname, "../../src/console.html"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 10));

const calls = [];
const invoked = [];
let profileRow = null; // null = the profile load fails
const tables = { wallets: [{ test_balance_cents: 12000, test_locked_cents: 0 }] };

function query(table) {
  let single = false;
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === "then") {
        const rows = table === "profiles" ? (profileRow ? [profileRow] : []) : tables[table] || [];
        return (res, rej) => Promise.resolve(single ? { data: rows[0] || null, error: null } : { data: rows, error: null }).then(res, rej);
      }
      if (prop === "single") return () => { single = true; return builder; };
      return () => builder;
    },
  });
  return builder;
}
const client = {
  from: (table) => query(table),
  rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: {}, error: null }); },
  functions: { invoke: (name) => { invoked.push(name); return Promise.resolve({ data: null, error: { message: "stop" } }); } },
  auth: { signOut: () => Promise.resolve() },
};

const $ = (id) => document.getElementById(id);
let profile;
let nav;

beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  window.scrollTo = () => {};
  const ctx = await import("../../src/scripts/console/context.js");
  nav = await import("../../src/scripts/console/navigation.js");
  profile = await import("../../src/scripts/console/profile.js");
  const wallet = await import("../../src/scripts/console/wallet.js");
  ctx.initContext(client, "u1");
  nav.initNavigation({});
  profile.initProfile();
  profile.initAccountClosure();
  wallet.initWallet();
  await wallet.refreshWallet();
  await tick();
});

describe("account closure", () => {
  it("refuses while the profile hasn't loaded, even for an empty confirmation", async () => {
    profile.loadProfile();
    await tick();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("");
    $("account-close").click();
    await tick();
    expect(prompt).not.toHaveBeenCalled();
    expect(invoked).toEqual([]);
    expect($("account-close-msg").textContent).toContain("hasn't loaded");
    prompt.mockRestore();
  });

  it("confirms against the saved username, not an unsaved edit", async () => {
    profileRow = { username: "real_name", display_name: null, created_at: "2026-09-01T00:00:00Z" };
    profile.loadProfile();
    await tick();
    $("profile-username").value = "typed_unsaved";
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("typed_unsaved");
    $("account-close").click();
    await tick();
    expect(invoked).toEqual([]);
    prompt.mockReturnValue("real_name");
    $("account-close").click();
    await tick();
    expect(invoked).toEqual(["close-account"]);
    prompt.mockRestore();
  });
});

describe("withdrawals", () => {
  const withdrawCalls = () => calls.filter((c) => c[0] === "rib_withdraw_test");

  it("rejects decimals instead of rounding them", () => {
    $("withdraw-amount").value = "0.6";
    $("withdraw-submit").click();
    expect(withdrawCalls()).toHaveLength(0);
    expect($("wallet-msg").textContent).toBe("Enter whole rcoin, no decimals.");
    expect($("wallet-msg").getAttribute("role")).toBe("alert");
  });

  it("rejects more than the available balance", () => {
    $("withdraw-amount").value = "500";
    $("withdraw-submit").click();
    expect(withdrawCalls()).toHaveLength(0);
    expect($("wallet-msg").textContent).toContain("available");
  });

  it("sends a valid whole amount in cents", () => {
    $("withdraw-amount").value = "20";
    $("withdraw-submit").click();
    expect(withdrawCalls().pop()[1]).toEqual({ p_amount_cents: 2000 });
  });
});

describe("console history", () => {
  it("pushes a hash per page and follows popstate back", () => {
    nav.goToPage("page-wallet");
    expect(window.location.hash).toBe("#page-wallet");
    expect($("page-wallet").hidden).toBe(false);
    nav.goToPage("page-ranking");
    window.dispatchEvent(new PopStateEvent("popstate", { state: { page: "page-wallet" } }));
    expect($("page-wallet").hidden).toBe(false);
    expect($("page-ranking").hidden).toBe(true);
  });

  it("ignores ids that aren't console pages", () => {
    window.location.hash = "#not-a-page";
    expect(nav.initialPage()).toBeNull();
  });
});
