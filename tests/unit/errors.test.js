import { describe, expect, it } from "vitest";
import { friendlyError } from "../../src/scripts/lib/errors.js";

describe("friendlyError", () => {
  it("maps stable database hints first", () => {
    expect(friendlyError({ message: "anything", hint: "insufficient_balance" }))
      .toBe("You don't have enough USD for that. Top up your wallet and try again.");
  });

  it("still maps legacy Spanish messages from older RPC versions", () => {
    expect(friendlyError({ message: "Saldo insuficiente" }))
      .toBe("You don't have enough USD for that. Top up your wallet and try again.");
    expect(friendlyError({ message: "reto no encontrado" })).toBe("We couldn't find that challenge.");
  });

  it("maps English messages and SQLSTATE codes", () => {
    expect(friendlyError({ message: "not your turn" })).toBe("It's not your turn yet.");
    expect(friendlyError({ message: "duplicate key", code: "23505" })).toBe("That's already taken. Please pick another.");
  });

  it("recognizes network failures", () => {
    expect(friendlyError({ message: "TypeError: Failed to fetch" }))
      .toBe("Network error. Please check your connection and try again.");
  });

  it("never leaks an unknown database message", () => {
    const leaked = 'relation "public.wallets" violates check constraint';
    expect(friendlyError({ message: leaked }, "Couldn't save.")).toBe("Couldn't save.");
    expect(friendlyError({ message: leaked })).toBe("Something went wrong. Please try again.");
  });

  it("ignores unknown hints and falls through to the message rules", () => {
    expect(friendlyError({ message: "not your turn", hint: "some_future_code" })).toBe("It's not your turn yet.");
  });
});
