/* Entry: the signed-in console (Play, match rooms, wallet, ranking, profile). */
import { initAccountNav } from "../auth/account-nav.js";
import { initConsole } from "../console/console-app.js";
import { initTelemetry } from "../lib/telemetry.js";
import { getClient } from "../lib/supabase-client.js";

initTelemetry(getClient);

initAccountNav();
initConsole();
