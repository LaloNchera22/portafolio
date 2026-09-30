import { describe, expect, it } from "vitest";
import { friendlyError } from "../../src/scripts/lib/errors.js";

describe("friendlyError", () => {
  it("maps stable database hints first", () => {
    expect(friendlyError({ message: "anything", hint: "insufficient_balance" }))
      .toBe("You don't have enough rcoin for that. Top up your wallet and try again.");
  });

  it("still maps legacy Spanish messages from older RPC versions", () => {
    expect(friendlyError({ message: "Saldo insuficiente" }))
      .toBe("You don't have enough rcoin for that. Top up your wallet and try again.");
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

describe("hosted tournament hints (docs/hosted-tournaments.md)", () => {
  const hints = [
    "host_cannot_play", "host_limit", "host_restricted", "host_fee_limit", "not_host", "invalid_size",
    "invalid_visibility", "invite_invalid", "tournament_private", "not_enough_players", "room_not_setup",
    "lobby_required", "invalid_winner", "appeal_closed", "already_appealed", "not_an_entrant", "already_started",
    "invalid_rules", "invalid_lobby", "host_decides",
  ];
  it("maps every one to its own sentence, never the fallback", () => {
    for (const hint of hints) {
      const text = friendlyError({ message: "x", hint }, "FALLBACK");
      expect(text, hint).not.toBe("FALLBACK");
      expect(text).not.toMatch(/wager|bet\b|stake|pot\b|gambl/i);
    }
  });
});
