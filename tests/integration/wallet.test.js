// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { initWallet, refreshWallet, loadLedger, updatePurchaseQuote, handleCheckoutReturn } from "../../src/scripts/console/wallet.js";
import { initContext, session } from "../../src/scripts/console/context.js";

describe("wallet", () => {
  let client, calls;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="wallet-chip"></div>
      <div id="games-balance"></div>
      <div id="wallet-balance"></div>
      <div id="wallet-locked"></div>
      <div id="wallet-usd"></div>
      <div id="dev-balance"></div>
      <div id="wallet-ledger"></div>
      <input id="buy-amount" value="10" />
      <div id="buy-pay"></div>
      <div id="buy-fee"></div>
      <div id="buy-receive"></div>
      <button id="buy-submit"></button>
      <input id="withdraw-amount" value="50" />
      <div id="withdraw-receive"></div>
      <input id="withdraw-destination" />
      <button id="withdraw-submit"></button>
      <input id="dev-withdraw-amount" value="50" />
      <button id="dev-withdraw-submit"></button>
      <div id="dev-withdraw-msg"></div>
      <div id="wallet-msg"></div>
      <div id="pay-method" hidden>
        <div data-chips="pay-method">
          <button data-method="card">Card</button>
          <button data-method="crypto">Crypto</button>
        </div>
      </div>
      <div id="pay-note"></div>
    `;

    calls = [];
    const tables = {
      wallets: [{ test_balance_cents: 2000, test_locked_cents: 500 }],
      wallet_ledger: [
        { kind: "deposit", amount_cents: 2000, balance_after_cents: 2000, memo: "Deposit", created_at: "2026-01-01T00:00:00Z" }
      ]
    };
    
    function query(table) {
      let single = false;
      const builder = new Proxy({}, {
        get(_, prop) {
          if (prop === "then") {
            const rows = tables[table] || [];
            return (res) => Promise.resolve(single ? { data: rows[0] || null, error: null } : { data: rows, error: null, count: 0 }).then(res);
          }
          if (prop === "single") return () => { single = true; return builder; };
          if (prop === "order") return () => { return builder; };
          if (prop === "limit") return () => { return builder; };
          return () => builder;
        }
      });
      return builder;
    }

    client = {
      from: (table) => query(table),
      rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: {}, error: null }); },
      functions: { invoke: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: { url: "http://checkout" }, error: null }); } }
    };

    initContext(client, "u1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshWallet updates DOM elements", async () => {
    await refreshWallet();
    expect(document.getElementById("wallet-chip").textContent).toBe("20 rcoin");
    expect(document.getElementById("games-balance").textContent).toBe("20 rcoin");
    expect(session.balanceCents).toBe(2000);
  });

  it("loadLedger populates the ledger", async () => {
    await loadLedger();
    const ledger = document.getElementById("wallet-ledger");
    expect(ledger.innerHTML).toContain("Deposit");
    expect(ledger.innerHTML).toContain("+20");
  });

  it("updatePurchaseQuote calculates correctly", () => {
    updatePurchaseQuote();
    expect(document.getElementById("buy-pay").textContent).toBe("$10.00");
    expect(document.getElementById("buy-receive").textContent).toBe("9.5 rcoin");
  });

  it("initWallet binds events and handles test checkout", () => {
    initWallet();
    
    const buyBtn = document.getElementById("buy-submit");
    buyBtn.click();
    
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe("rib_buy_rcoin_test");
    expect(calls[0][1]).toEqual({ p_pay_cents: 1000 });
  });

  it("handles checkout return success", () => {
    const originalLocation = window.location;
    delete window.location;
    window.location = { search: "?checkout=success", pathname: "/" };
    vi.useFakeTimers();

    const goToPage = vi.fn();
    handleCheckoutReturn(goToPage);
    
    expect(goToPage).toHaveBeenCalledWith("page-wallet");
    expect(document.getElementById("wallet-msg").textContent).toContain("Payment received");
    
    vi.runOnlyPendingTimers(); // Should trigger setInterval for refresh
    window.location = originalLocation;
    vi.useRealTimers();
  });
});
