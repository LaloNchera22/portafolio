// Per-user fixed-window rate limits backed by public.rib_rate_limit_hit
// (migration 0013). Fails OPEN on a database error so an outage of the counter
// never blocks legitimate payments or moves; the error is logged.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

export const LIMITS = {
  checkout: { max: 10, windowSeconds: 3600 },
  apiKey: { max: 10, windowSeconds: 3600 },
  gameMove: { max: 120, windowSeconds: 60 },
} as const;

export async function withinRateLimit(
  admin: SupabaseClient,
  bucket: keyof typeof LIMITS,
  userId: string,
): Promise<boolean> {
  const { max, windowSeconds } = LIMITS[bucket];
  const { data, error } = await admin.rpc("rib_rate_limit_hit", {
    p_bucket: bucket,
    p_subject: userId,
    p_max: max,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error(`rate limit check failed (${bucket})`, error.message);
    return true;
  }
  return data === true;
}
