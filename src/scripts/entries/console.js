/* Entry: the signed-in console (games, compete, wallet, profile, dev portal). */
import { initAccountNav } from "../auth/account-nav.js";
import { initConsole } from "../console/console-app.js";
import { initTelemetry } from "../lib/telemetry.js";
import { getClient } from "../lib/supabase-client.js";

initTelemetry(getClient);

initAccountNav();
initConsole();
