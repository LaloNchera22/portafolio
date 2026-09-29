// ============================================================================
// close-account — permanently close the caller's account.
//
// rib_close_account (run as the user) refuses while money is in play, then
// anonymizes the profile, revokes API keys and removes rankings. This function
// then disables the login: the e-mail is replaced with an undeliverable
// placeholder and the user is banned. Financial records stay for audit.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: userErr } = await asUser.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  const { error: closeErr } = await asUser.rpc("rib_close_account");
  if (closeErr) return json({ error: closeErr.hint || "server_error" }, closeErr.hint ? 409 : 500);

  const { error: banErr } = await admin.auth.admin.updateUserById(user.id, {
    email: `closed-${user.id}@closed.runinback.invalid`,
    ban_duration: "876000h",
    user_metadata: { closed: true },
  });
  if (banErr) {
    // The profile is already anonymized; log so an operator can finish the ban.
    console.error("close-account: could not disable login", user.id, banErr.message);
    return json({ error: "server_error" }, 500);
  }
  return json({ closed: true });
});
