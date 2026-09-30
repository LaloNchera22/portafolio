import { describe, expect, it } from "vitest";
import {
  HOSTED_SIZES, appealDepositCents, bracketRounds, bracketSizeFor, byesFor, formatCountdown, formatInviteCode, hostedSplit,
  isInviteCode, lobbyImagePath, normalizeBracket, normalizeDashboard, normalizeHostInfo, normalizePreview, normalizeInviteCode,
  parseEntryFee, parseInviteInput, playerStanding, roundLabel, shapeBracket, shareUrl, validateHostedForm,
  validateLobbyImage,
} from "../../src/scripts/lib/hosted.js";
import { playReturn } from "../../src/scripts/lib/wild-rift.js";

describe("hostedSplit", () => {
  it("matches the payout job: platform 10%, host 5%, the winner the rest", () => {
    // 8 players x 10 rcoin.
    expect(hostedSplit(1000, 8)).toEqual({ pool: 8000, platform: 800, host: 400, winner: 6800 });
  });

  it("floors platform and host and gives every leftover cent to the winner", () => {
    // pool 3 x 137 = 411: platform floor(41.1) = 41, host floor(20.55) = 20.
    expect(hostedSplit(137, 3)).toEqual({ pool: 411, platform: 41, host: 20, winner: 350 });
    for (const fee of [100, 137, 999, 2500, 50000]) {
      for (const n of [4, 5, 7, 16, 32]) {
        const s = hostedSplit(fee, n);
        expect(s.winner + s.host + s.platform).toBe(s.pool);
        expect(s.winner / s.pool).toBeGreaterThanOrEqual(0.85); // Riot: >= 70% of fees to prizes
      }
    }
  });

  it("uses the actual entrants, and is all zeros when free", () => {
    expect(hostedSplit(500, 5).pool).toBe(2500);
    expect(hostedSplit(0, 32)).toEqual({ pool: 0, platform: 0, host: 0, winner: 0 });
    expect(hostedSplit(-100, 4).pool).toBe(0);
  });
});

describe("appeal deposit", () => {
  it("is 10% of the entry fee with a 1 rcoin minimum, none when free", () => {
    expect(appealDepositCents(5000)).toBe(500);
    expect(appealDepositCents(500)).toBe(100);
    expect(appealDepositCents(100)).toBe(100);
    expect(appealDepositCents(0)).toBe(0);
  });
});

describe("create form", () => {
  it("parses whole rcoin from 0 to 500", () => {
    expect(parseEntryFee("10")).toEqual({ cents: 1000 });
    expect(parseEntryFee("")).toEqual({ cents: 0 });
    expect(parseEntryFee(" 0 ")).toEqual({ cents: 0 });
    expect(parseEntryFee("500")).toEqual({ cents: 50000 });
    expect(parseEntryFee("501").error).toBeTruthy();
    expect(parseEntryFee("2.5").error).toBeTruthy();
    expect(parseEntryFee("-1").error).toBeTruthy();
  });

  it("builds rib_hosted_create's arguments", () => {
    expect(validateHostedForm({ name: " Friday Cup ", size: 16, fee: "5", visibility: "private", rules: "  " })).toEqual({
      value: { p_name: "Friday Cup", p_size: 16, p_entry_fee_cents: 500, p_visibility: "private", p_rules: null },
    });
    expect(HOSTED_SIZES).toEqual([4, 8, 16, 32]);
  });

  it("names the field to fix", () => {
    expect(validateHostedForm({ name: "", size: 4, fee: "1", visibility: "public" }).field).toBe("name");
    expect(validateHostedForm({ name: "x", size: 6, fee: "1", visibility: "public" }).field).toBe("size");
    expect(validateHostedForm({ name: "x", size: 4, fee: "1.5", visibility: "public" }).field).toBe("fee");
    expect(validateHostedForm({ name: "x", size: 4, fee: "1", visibility: "secret" }).field).toBe("visibility");
    expect(validateHostedForm({ name: "x", size: 4, fee: "1", visibility: "public", rules: "a".repeat(1001) }).field).toBe("rules");
  });
});

describe("invite codes", () => {
  it("normalizes case, spaces and dashes", () => {
    expect(normalizeInviteCode(" abcde-fgh23 ")).toBe("ABCDEFGH23");
    expect(normalizeInviteCode("abcde fgh 23")).toBe("ABCDEFGH23");
    expect(isInviteCode("abcde-fgh23")).toBe(true);
  });

  it("rejects letters outside the alphabet (no I, O, 0, 1) and wrong lengths", () => {
    expect(isInviteCode("ABCDEFGHJI")).toBe(false);
    expect(isInviteCode("ABCDEFGHJ0")).toBe(false);
    expect(isInviteCode("ABCDEFGH1K")).toBe(false);
    expect(isInviteCode("ABCDEFGH")).toBe(false); // the old 8-character codes
    expect(isInviteCode("ABCDEFGHJKL")).toBe(false);
  });

  it("finds the code in a pasted share link", () => {
    expect(parseInviteInput("https://runinback.com/console.html#join/abcdefgh23")).toBe("ABCDEFGH23");
    expect(parseInviteInput("ABCDE-FGH23")).toBe("ABCDEFGH23");
    expect(parseInviteInput("https://runinback.com/console.html#page-wallet")).toBeNull();
    expect(parseInviteInput("")).toBeNull();
  });

  it("builds the share link from the console page's URL, and a readable code", () => {
    expect(shareUrl("https://runinback.com/console.html", "abcdefgh23")).toBe("https://runinback.com/console.html#join/ABCDEFGH23");
    expect(shareUrl("http://localhost:5173/console.html#page-hosting/t1", "ABCDEFGH23")).toBe("http://localhost:5173/console.html#join/ABCDEFGH23");
    expect(formatInviteCode("abcdefgh23")).toBe("ABCDE-FGH23");
  });

  it("is a valid way back from linking a Riot ID or adding rcoin", () => {
    expect(playReturn("j/abcde-fgh23")).toBe("j/ABCDEFGH23");
    expect(playReturn("j/nope")).toBeNull();
  });
});

describe("brackets", () => {
  it("counts rounds and names them from the final", () => {
    expect([4, 8, 16, 32].map(bracketRounds)).toEqual([2, 3, 4, 5]);
    expect(bracketRounds(6)).toBe(0);
    expect([1, 2, 3, 4, 5].map((r) => roundLabel(r, 5))).toEqual(["Round of 32", "Round of 16", "Quarterfinals", "Semifinals", "Final"]);
  });

  it("shrinks to the next power of two and gives the top seeds byes", () => {
    expect(bracketSizeFor(4)).toBe(4);
    expect(bracketSizeFor(5)).toBe(8);
    expect(bracketSizeFor(17)).toBe(32);
    expect(byesFor(5)).toBe(3);
    expect(byesFor(8)).toBe(0);
  });

  const jsonb = {
    tournament_id: "t1", size: 4, rounds: 2, status: "active",
    rooms: [
      { room_id: "r3", round: 2, slot: 0, player_a: "u1", player_b: null, a_username: "me", b_username: null, status: "waiting", winner_id: null, walkover: false },
      { room_id: "r2", round: 1, slot: 1, player_a: "u3", player_b: "u4", a_username: "neo", b_username: "tri", status: "live", winner_id: null, walkover: false },
      { room_id: "r1", round: 1, slot: 0, player_a: "u1", player_b: "u2", a_username: "me", b_username: "rival", status: "done", winner_id: "u1", walkover: false },
    ],
  };

  it("reads the jsonb shape and the older table shape alike", () => {
    const b = normalizeBracket(jsonb);
    expect(b.size).toBe(4);
    expect(b.rounds).toBe(2);
    expect(b.rows.map((m) => m.room_id)).toEqual(["r1", "r2", "r3"]);
    const table = normalizeBracket(jsonb.rooms);
    expect(table.rows).toHaveLength(3);
    expect(table.size).toBeNull();
    expect(normalizeBracket(null).rows).toEqual([]);
  });

  it("groups matches into labelled rounds", () => {
    const shaped = shapeBracket(normalizeBracket(jsonb).rows, { size: 4 });
    expect(shaped.map((c) => c.label)).toEqual(["Semifinals", "Final"]);
    expect(shaped[0].matches.map((m) => m.slot)).toEqual([0, 1]);
    expect(shapeBracket([], { size: 32 })).toHaveLength(5);
  });

  it("knows where a player stands", () => {
    const rows = normalizeBracket(jsonb).rows;
    expect(playerStanding(rows, "u1", 2)).toMatchObject({ entrant: true, eliminated: false, champion: false });
    expect(playerStanding(rows, "u1", 2).current.room_id).toBe("r3");
    expect(playerStanding(rows, "u2", 2)).toMatchObject({ eliminated: true, outIn: 1, current: null });
    expect(playerStanding(rows, "u9", 2).entrant).toBe(false);
    const won = rows.map((m) => (m.room_id === "r3" ? Object.assign({}, m, { status: "done", winner_id: "u1", player_b: "u3" }) : m));
    expect(playerStanding(won, "u1", 2).champion).toBe(true);
  });
});

describe("jsonb RPC shapes", () => {
  it("reads rib_tournament_preview and recomputes the prizes", () => {
    const p = normalizePreview({
      id: "t1", name: "Cup", host_username: "host", mode: "hosted", visibility: "private", status: "open",
      size: 8, entrants: 3, min_entrants: 4, entry_fee_cents: 1000, rules: "Bo1", is_host: false, joined: null,
      prize_now: { pool_cents: 3000 }, prize_full: { pool_cents: 8000 },
    });
    expect(p).toMatchObject({ id: "t1", host: "host", visibility: "private", size: 8, entrants: 3, feeCents: 1000, isHost: false, joined: false });
    expect(p.now.pool).toBe(3000);
    expect(p.full.winner).toBe(6800);
    expect(normalizePreview(null)).toBeNull();
    expect(normalizePreview({})).toBeNull();
  });

  it("reads rib_host_dashboard", () => {
    const data = {
      host: { hosted_completed: 2, host_strikes: 1, live_limit: 3, paid_allowed: true, max_entry_fee_cents: 2500 },
      tournaments: [{
        id: "t1", name: "Cup", status: "active", visibility: "public", invite_code: "ABCDEF23", size: 8, entrants: 6,
        entry_fee_cents: 500, open_appeals: 0,
        rooms_needing_action: [{
          room_id: "r1", round: 1, slot: 0, status: "live", player_a: "u1", player_b: "u2", a_username: "a", b_username: "b",
          a_riot_id: "A#NA1", b_riot_id: "B#NA1", a_report: "u1", b_report: null, lobby_code: "X1", lobby_password: "pw",
          review_flag: true, evidence: [{ id: 5, user_id: "u1", storage_path: "r1/u1/t.jpg", check_status: "verified" }],
        }],
      }],
    };
    const [t] = normalizeDashboard(data);
    expect(t).toMatchObject({ id: "t1", inviteCode: "ABCDEF23", size: 8, entrants: 6, feeCents: 500, actionCount: 1 });
    expect(t.rooms[0]).toMatchObject({ room_id: "r1", a_report: "u1", lobby_code: "X1", a_riot_id: "A#NA1", review_flag: true });
    expect(t.rooms[0].evidence).toHaveLength(1);
    expect(normalizeHostInfo(data)).toEqual({ completed: 2, strikes: 1, paidAllowed: true, maxFeeCents: 2500 });
    expect(normalizeDashboard(null)).toEqual([]);
    expect(normalizeHostInfo([])).toBeNull();
  });
});

describe("lobby screenshot", () => {
  const file = (type, size) => ({ type, size });
  it("accepts PNG, JPEG and WebP up to 5 MB", () => {
    expect(validateLobbyImage(file("image/png", 1000))).toEqual({ ext: "png" });
    expect(validateLobbyImage(file("image/jpeg", 5 * 1024 * 1024))).toEqual({ ext: "jpg" });
    expect(validateLobbyImage(file("image/webp", 10))).toEqual({ ext: "webp" });
  });
  it("refuses anything else", () => {
    expect(validateLobbyImage(file("image/gif", 10)).error).toBeTruthy();
    expect(validateLobbyImage(file("image/png", 5 * 1024 * 1024 + 1)).error).toBeTruthy();
    expect(validateLobbyImage(file("image/png", 0)).error).toBeTruthy();
    expect(validateLobbyImage(null).error).toBeTruthy();
  });
  it("stores it at <room_id>/<uuid>.<ext>", () => {
    expect(lobbyImagePath("r1", "0b7c3a52-6c1e-4b1e-9d0a-3f7a1c2b4d5e", "png")).toBe("r1/0b7c3a52-6c1e-4b1e-9d0a-3f7a1c2b4d5e.png");
  });
});

describe("countdown", () => {
  it("reads hours and minutes to payout", () => {
    const now = Date.parse("2026-09-30T00:00:00Z");
    expect(formatCountdown("2026-09-30T23:05:30Z", now)).toBe("23 h 05 min");
    expect(formatCountdown("2026-09-30T00:12:00Z", now)).toBe("12 min");
    expect(formatCountdown("2026-09-30T00:00:30Z", now)).toBe("under a minute");
    expect(formatCountdown("2026-09-29T00:00:00Z", now)).toBe("");
  });
});
