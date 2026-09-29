// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { toast, notify, functionError } from "../../src/scripts/lib/errors.js";

describe("errors DOM interactions", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="capp"></div>';
    vi.stubGlobal("alert", vi.fn());
    // Clear toast stack reference by resetting the DOM
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("toast", () => {
    it("creates and appends a toast element", () => {
      toast("Test message", "err");
      const toasts = document.querySelectorAll(".rib-toast");
      expect(toasts.length).toBe(1);
      expect(toasts[0].textContent).toBe("Test message");
      expect(toasts[0].classList.contains("rib-toast--err")).toBe(true);
    });

    it("creates ok and info toasts", () => {
      toast("Success", "ok");
      toast("Info", "info");
      const okToast = document.querySelector(".rib-toast--ok");
      const infoToast = document.querySelector(".rib-toast--info");
      expect(okToast.textContent).toBe("Success");
      expect(infoToast.textContent).toBe("Info");
    });
    
    it("ignores empty text", () => {
      toast("", "err");
      expect(document.querySelectorAll(".rib-toast").length).toBe(0);
    });
  });

  describe("notify", () => {
    it("uses toast when document is available", () => {
      notify({ message: "not your turn" });
      const toasts = document.querySelectorAll(".rib-toast");
      expect(toasts.length).toBe(1);
      expect(toasts[0].textContent).toBe("It's not your turn yet.");
    });
  });

  describe("functionError", () => {
    it("resolves context error from edge function", async () => {
      const edgeError = {
        context: {
          json: () => Promise.resolve({ error: "wallet_not_found" })
        }
      };
      const result = await functionError(edgeError);
      expect(result).toEqual({ message: "wallet_not_found", hint: "wallet_not_found" });
    });

    it("handles missing context or json gracefully", async () => {
      const result = await functionError({ message: "fallback message" });
      expect(result).toEqual({ message: "fallback message", hint: undefined });
    });
  });
});
