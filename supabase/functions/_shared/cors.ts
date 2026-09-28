// Shared CORS headers for Runinback Edge Functions.
// ALLOWED_ORIGIN is read from the function's environment. It FAILS CLOSED: when
// it is unset no Access-Control-Allow-Origin header is sent, so browsers block
// every cross-origin call instead of falling back to a wildcard.
// Set it to the site origin (e.g. https://runinback.com).
const allowed = (Deno.env.get("ALLOWED_ORIGIN") ?? "").trim();
if (!allowed) console.error("ALLOWED_ORIGIN is not set: cross-origin requests will be rejected.");

export const corsHeaders: Record<string, string> = {
  ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
