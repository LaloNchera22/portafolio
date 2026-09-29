// Per-user fixed-window rate limits backed by public.rib_rate_limit_hit
// (migration 0013). On a counter error, game moves fail OPEN (a DB hiccup must
// not freeze live matches) while checkouts and API keys fail CLOSED (abuse
// there costs money or creates credentials). Errors are always logged.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

export const LIMITS = {
  checkout: { max: 10, windowSeconds: 3600, failOpen: false },
  apiKey: { max: 10, windowSeconds: 3600, failOpen: false },
  gameMove: { max: 120, windowSeconds: 60, failOpen: true },
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
