// @vitest-environment jsdom
// Profile, Settings, Security and the public player card (migration 0024):
// every write goes through its RPC, errors keep the form, loosening a limit
// is shown as pending, and a player's privacy is reflected on their card.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HTML = readFileSync(resolve(import.meta.dirname, "../../src/console.html"), "utf8");
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));

const calls = [];
const auth = [];
const later = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
let settings = {
  match_toasts: true, product_emails: false, show_on_leaderboard: true, show_game_accounts: false,
  monthly_cap_cents: 5000, month_spent_cents: 1000, cooloff_until: null, pending_cap: null, pending_cooloff_end_at: null, next_export_at: null,
};
const replies = {
  rib_my_profile: () => ({ data: { username: "neo", display_name: "Neo", bio: "Hi", country: "MX", avatar_version: 0, created_at: "2026-09-01T00:00:00Z", username_next_change_at: null } }),
  rib_profile_update: (args) => args.p_username === "taken_one"
    ? { data: null, error: { message: "that username is taken", hint: "username_taken" } }
    : { data: { username: args.p_username, display_name: args.p_display_name, bio: args.p_bio, country: args.p_country, avatar_version: 0, created_at: "2026-09-01T00:00:00Z", username_next_change_at: later } },
  rib_settings_get: () => ({ data: settings }),
  rib_settings_update: (args) => {
    const p = args.p_patch;
    if ("monthly_cap_cents" in p && p.monthly_cap_cents > settings.monthly_cap_cents) {
      settings = Object.assign({}, settings, { pending_cap: { cents: p.monthly_cap_cents, at: later } });
    } else if ("cooloff_days" in p) {
      settings = Object.assign({}, settings, { cooloff_until: later });
    } else {
      settings = Object.assign({}, settings, p);
    }
    return { data: settings };
  },
  rib_public_profile: (args) => args.p_username === "ghost" ? { data: null } : {
    data: { username: "trinity", display_name: null, bio: "Rocket League main", country: "AR", avatar: null, created_at: "2026-01-01T00:00:00Z",
      is_me: false, ranked: false, stats: null, game_accounts: null,
      tournaments: [{ name: "Friday Cup", game: "CS2", size: 4, placement: 1, finished_at: "2026-09-20T00:00:00Z" }] },
  },
};

const client = {
  from: () => new Proxy({}, { get: (_, prop) => prop === "then" ? (res) => Promise.resolve({ data: [], error: null }).then(res) : () => client.from() }),
  rpc: (name, args) => { calls.push([name, args]); return Promise.resolve(Object.assign({ error: null }, replies[name] ? replies[name](args || {}) : { data: null })); },
  auth: {
    signInWithPassword: (a) => { auth.push(["signIn", a.password]); return Promise.resolve(a.password === "right-password" ? { data: {}, error: null } : { data: null, error: { message: "Invalid login credentials" } }); },
    updateUser: (a) => { auth.push(["update", Object.keys(a)[0]]); return Promise.resolve({ data: {}, error: null }); },
    signOut: (o) => { auth.push(["signOut", o && o.scope]); return Promise.resolve({ error: null }); },
  },
  storage: { from: () => ({ upload: () => Promise.resolve({ error: null }), remove: () => Promise.resolve({ error: null }) }) },
};
const $ = (id) => document.getElementById(id);
const last = (name) => calls.filter((c) => c[0] === name).pop();

let profile, settingsMod, security, player, nav;
beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  window.scrollTo = () => {};
  $("acct-email").textContent = "neo@example.test";
  const ctx = await import("../../src/scripts/console/context.js");
  nav = await import("../../src/scripts/console/navigation.js");
  profile = await import("../../src/scripts/console/profile.js");
  settingsMod = await import("../../src/scripts/console/settings.js");
  security = await import("../../src/scripts/console/security.js");
  player = await import("../../src/scripts/console/player.js");
  ctx.initContext(client, "u1");
  nav.initNavigation({ "page-player": () => player.loadPlayer(nav.currentRouteArg()) });
  profile.initProfile();
  settingsMod.initSettings();
  security.initSecurity();
  player.initPlayer();
});

describe("profile", () => {
  it("loads through rib_my_profile and fills the form and header", async () => {
    await profile.loadProfile();
    expect($("profile-username").value).toBe("neo");
    expect($("profile-bio").value).toBe("Hi");
    expect($("profile-country").value).toBe("MX");
    expect($("profile-bio-count").textContent).toBe("2 / 160");
    expect($("acct-name").textContent).toBe("@neo");
    expect($("profile-avatar").textContent).toBe("N");
    expect($("profile-public").getAttribute("href")).toBe("#page-player/neo");
  });

  it("keeps the form and marks the field when the username is taken", async () => {
    $("profile-username").value = "taken_one";
    $("profile-username").dispatchEvent(new Event("input", { bubbles: true }));
    $("profile-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect($("profile-msg").textContent).toBe("That username is taken. Try another one.");
    expect($("profile-username").getAttribute("aria-invalid")).toBe("true");
    expect($("profile-username").value).toBe("taken_one");
    expect($("profile-save").textContent).toBe("Save changes");
  });

  it("saves the whole form in one call and shows the next allowed change", async () => {
    $("profile-username").value = "neo_two";
    $("profile-bio").value = "New bio";
    $("profile-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(last("rib_profile_update")[1]).toEqual({ p_username: "neo_two", p_display_name: "Neo", p_bio: "New bio", p_country: "MX" });
    expect($("profile-msg").textContent).toBe("Saved.");
    expect($("profile-username").hasAttribute("aria-invalid")).toBe(false);
    expect($("profile-username-hint").textContent).toContain("You can pick a new username on");
  });

  it("opens the section named by the route", () => {
    expect(profile.showProfileSection("settings")).toBe("settings");
    expect($("profile-panel-settings").hidden).toBe(false);
    expect($("profile-panel-profile").hidden).toBe(true);
    expect(document.querySelector('#profile-nav [aria-current="page"]').textContent).toBe("Settings");
    expect(profile.showProfileSection("link/riot/abc")).toBe("profile");
  });
});

describe("settings", () => {
  it("renders switches and this month's spend against the limit", async () => {
    await settingsMod.loadSettings();
    expect($("set-match_toasts").checked).toBe(true);
    expect($("set-show_game_accounts").checked).toBe(false);
    expect($("settings-privacy").disabled).toBe(false);
    expect($("cap-meter-text").textContent).toBe("10 rcoin of 50 rcoin used this month · 40 rcoin left");
    expect($("cap-amount").value).toBe("50");
  });

  it("saves a switch on change and turns match pop-ups off", async () => {
    $("set-match_toasts").checked = false;
    $("set-match_toasts").dispatchEvent(new Event("change"));
    await tick();
    expect(last("rib_settings_update")[1]).toEqual({ p_patch: { match_toasts: false } });
    expect(settingsMod.prefs.match_toasts).toBe(false);
    expect($("settings-msg").textContent).toBe("Pop-ups when a match needs me: off.");
  });

  it("shows a raised limit as pending, with a way to cancel", async () => {
    $("cap-amount").value = "80";
    $("cap-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(last("rib_settings_update")[1]).toEqual({ p_patch: { monthly_cap_cents: 8000 } });
    expect($("settings-msg").textContent).toBe("Your new limit takes effect in 24 hours.");
    expect($("cap-pending").hidden).toBe(false);
    expect($("cap-pending-text").textContent).toContain("Raising your limit to 80 rcoin on");
  });

  it("rejects a limit that isn't whole rcoin before calling the server", () => {
    const before = calls.length;
    $("cap-amount").value = "12.5";
    $("cap-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(calls.length).toBe(before);
    expect($("settings-msg").textContent).toContain("whole rcoin");
  });

  it("starts a cool-off after confirming and says what stays open", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    document.querySelector('#cooloff-days input[value="30"]').checked = true;
    $("cooloff-start").click();
    await tick();
    expect(last("rib_settings_update")[1]).toEqual({ p_patch: { cooloff_days: 30 } });
    expect($("cooloff-on").hidden).toBe(false);
    expect($("cooloff-text").textContent).toContain("Free games and friendlies stay open.");
    confirm.mockRestore();
  });
});

describe("security", () => {
  it("checks the current password before changing it", async () => {
    $("password-current").value = "wrong";
    $("password-new").value = "new-password-1";
    $("password-confirm").value = "new-password-1";
    $("password-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(auth).toEqual([["signIn", "wrong"]]);
    expect($("password-msg").textContent).toBe("Your current password isn't right.");
    $("password-current").value = "right-password";
    $("password-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(auth.slice(-2)).toEqual([["signIn", "right-password"], ["update", "password"]]);
    expect($("password-msg").textContent).toContain("Password changed");
  });

  it("refuses mismatched passwords without calling the server", () => {
    const before = auth.length;
    $("password-current").value = "right-password";
    $("password-new").value = "one-password";
    $("password-confirm").value = "another-one";
    $("password-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(auth.length).toBe(before);
    expect($("password-msg").textContent).toBe("The two new passwords don't match.");
  });

  it("signs out the other devices only", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    $("sessions-others").click();
    await tick();
    expect(auth.pop()).toEqual(["signOut", "others"]);
    expect($("sessions-msg").textContent).toBe("Other devices are signed out.");
    confirm.mockRestore();
  });
});

describe("public player card", () => {
  it("shows the card and respects a private record", async () => {
    nav.goToPage("page-player", { arg: "trinity" });
    await tick();
    const root = $("player-root");
    expect(root.querySelector("h1").textContent).toBe("@trinity");
    expect(root.textContent).toContain("Rocket League main");
    expect(root.textContent).toContain("Argentina");
    expect(root.textContent).toContain("This player keeps their record private.");
    expect(root.querySelector(".chip").textContent).toBe("Champion");
    expect(document.querySelector('.capp__tabs a[aria-current="page"]').getAttribute("data-page")).toBe("page-ranking");
  });

  it("says so when nobody has that name", async () => {
    nav.goToPage("page-player", { arg: "ghost" });
    await tick();
    expect($("player-root").textContent).toContain("No player called @ghost");
  });

  it("opens from any link to a player", async () => {
    document.body.insertAdjacentHTML("beforeend", '<a id="to-trinity" href="#page-player/trinity" data-player="trinity">x</a>');
    $("to-trinity").click();
    await tick();
    expect(location.hash).toBe("#page-player/trinity");
  });
});
