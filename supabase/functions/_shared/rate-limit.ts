// Per-user fixed-window rate limits backed by public.rib_rate_limit_hit
// (migration 0013). On a counter error, game moves fail OPEN (a DB hiccup must
// not freeze live matches) while checkouts and API keys fail CLOSED (abuse
// there costs money or creates credentials). Errors are always logged.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

export const LIMITS = {
  checkout: { max: 10, windowSeconds: 3600, failOpen: false },
  apiKey: { max: 10, windowSeconds: 3600, failOpen: false },
  gameMove: { max: 120, windowSeconds: 60, failOpen: true },
  // Each check can call a paid vision model; each Riot lookup spends our
  // shared Riot API quota. Both fail CLOSED.
  resultCheck: { max: 30, windowSeconds: 3600, failOpen: false },
  riotAccount: { max: 10, windowSeconds: 3600, failOpen: false },
} as const;

export async function withinRateLimit(
  admin: SupabaseClient,
  bucket: keyof typeof LIMITS,
  userId: string,
): Promise<boolean> {
  const { max, windowSeconds, failOpen } = LIMITS[bucket];
  const { data, error } = await admin.rpc("rib_rate_limit_hit", {
    p_bucket: bucket,
    p_subject: userId,
    p_max: max,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error(`rate limit check failed (${bucket}); failing ${failOpen ? "open" : "closed"}`, error.message);
    return failOpen;
  }
  return data === true;
}

// rate_limits.subject is a uuid, so platform-wide budgets count against the
// nil uuid. Always fails CLOSED: these budgets cap spend.
export const GLOBAL_SUBJECT = "00000000-0000-0000-0000-000000000000";

export async function withinGlobalBudget(
  admin: SupabaseClient,
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await admin.rpc("rib_rate_limit_hit", {
    p_bucket: bucket,
    p_subject: GLOBAL_SUBJECT,
    p_max: max,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error(`global budget check failed (${bucket}); failing closed`, error.message);
    return false;
  }
  return data === true;
}
