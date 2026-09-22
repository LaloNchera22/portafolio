// ============================================================================
// steam-auth — Sign in with Steam.
//
// Steam uses OpenID 2.0 (not OAuth/OIDC), so Supabase can't do it natively.
// This function bridges it:
//   GET /steam-auth/login    → redirect the user to Steam's OpenID login
//   GET /steam-auth/callback → verify Steam's signed assertion, then mint a
//                              Supabase session (via a magic link) and bounce
//                              the user to the app already signed in.
//
// Zero-trust notes:
//  - The assertion is verified straight back against Steam (check_authentication)
//    before we trust the steamid — the query string alone is never trusted.
//  - `redirect_to` is validated against ALLOWED_ORIGIN to prevent open redirects.
//  - The service-role key stays server-side; Steam gives no email, so we mint a
//    stable synthetic identity (steam_<id>@steam.local) that RLS still ties to
//    this one user. Deploy with verify_jwt = false (this IS the login entry).
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";
const STEAM_WEB_API_KEY = Deno.env.get("STEAM_WEB_API_KEY") ?? ""; // optional (nice name/avatar)

const FUNCTION_BASE = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/steam-auth`;
const STEAM_OPENID = "https://steamcommunity.com/openid/login";

function safeRedirect(target: string | null): string {
  const fallback = ALLOWED_ORIGIN ? `${ALLOWED_ORIGIN}/console.html` : SUPABASE_URL;
  if (!target) return fallback;
  try {
    const u = new URL(target);
    if (ALLOWED_ORIGIN && u.origin !== new URL(ALLOWED_ORIGIN).origin) return fallback;
    return u.href;
  } catch {
    return fallback;
  }
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

// --- GET /login : send the user to Steam -------------------------------------
function handleLogin(url: URL): Response {
  const redirectTo = safeRedirect(url.searchParams.get("redirect_to"));
  const realm = ALLOWED_ORIGIN || url.origin;
  const returnTo = `${FUNCTION_BASE}/callback?redirect_to=${encodeURIComponent(redirectTo)}`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": realm,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return redirect(`${STEAM_OPENID}?${params.toString()}`);
}

// --- GET /callback : verify + mint session -----------------------------------
async function handleCallback(url: URL): Promise<Response> {
  const redirectTo = safeRedirect(url.searchParams.get("redirect_to"));
  const fail = (code: string) =>
    redirect(`${redirectTo}${redirectTo.includes("?") ? "&" : "?"}auth_error=${code}`);

  // 1) Ask Steam to confirm the assertion it just handed the browser.
  const verify = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (k.startsWith("openid.")) verify.set(k, v);
  verify.set("openid.mode", "check_authentication");

  const resp = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: verify.toString(),
  });
  const body = await resp.text();
  if (!/is_valid\s*:\s*true/i.test(body)) return fail("steam_invalid");

  // 2) Pull the steamid out of the (now trusted) claimed_id.
  const claimed = url.searchParams.get("openid.claimed_id") ?? "";
  const m = claimed.match(/\/id\/(\d{17})$/) || claimed.match(/(\d{17})$/);
  if (!m) return fail("steam_no_id");
  const steamid = m[1];

  // 3) Optional: enrich with the public Steam profile name.
  let username = `steam_${steamid}`;
  let displayName = username;
  if (STEAM_WEB_API_KEY) {
    try {
      const p = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_WEB_API_KEY}&steamids=${steamid}`,
      );
      const j = await p.json();
      const persona = j?.response?.players?.[0]?.personaname;
      if (persona) displayName = String(persona).slice(0, 60);
    } catch { /* name is best-effort */ }
  }

  // 4) Find-or-create the Supabase user, then mint a session via magic link.
  const email = `steam_${steamid}@steam.local`;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { provider: "steam", steamid, username, display_name: displayName },
  });
  // A duplicate just means this Steam user has signed in before — that's fine.
  if (createErr && !/already|exists|registered|duplicate/i.test(createErr.message)) {
    return fail("user_failed");
  }

  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (error || !data?.properties?.action_link) return fail("session_failed");

  // The action link logs the browser in and bounces it to redirectTo.
  return redirect(data.properties.action_link);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/login")) return handleLogin(url);
  if (url.pathname.endsWith("/callback")) return await handleCallback(url);
  return new Response("Not found", { status: 404 });
});
