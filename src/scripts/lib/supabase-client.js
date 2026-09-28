/* ============================================================================
 * Runinback — the single supabase-js client for the page.
 *
 * supabase-js is bundled from npm at a pinned version (no CDN at runtime).
 * "Remember me" decides where the session persists: localStorage when on,
 * sessionStorage when off. Every query this client runs is gated by RLS.
 * ========================================================================== */
import { createClient } from "@supabase/supabase-js";
import { config, isBackendConfigured } from "./config.js";

const REMEMBER_KEY = "rib_remember";

export function readRememberPreference() {
  try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch (e) { return true; }
}

export function writeRememberPreference(remember) {
  try { localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0"); } catch (e) { /* storage blocked */ }
}

function buildClient(remember) {
  if (!isBackendConfigured()) return null;
  let storage;
  try { storage = remember ? window.localStorage : window.sessionStorage; } catch (e) { storage = undefined; }
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: storage },
  });
}

let client = buildClient(readRememberPreference());

/** The live client, or null when the backend is not configured. */
export function getClient() {
  return client;
}

/** Rebuild the client so the next session persists in the chosen storage. */
export function resetClient(remember) {
  client = buildClient(remember);
  return client;
}

export function getSession() {
  if (!client) return Promise.resolve(null);
  return client.auth.getSession().then(function (r) { return r.data ? r.data.session : null; });
}
