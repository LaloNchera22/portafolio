/* Entry: public marketing + auth pages (index, how-it-works, contact,
 * developers, login, signup). Site interactions + account nav + auth forms. */
import { initAccountNav } from "../auth/account-nav.js";
import { initAuthForms } from "../auth/auth-forms.js";
import { initSiteInteractions } from "../site/interactions.js";

initAccountNav();
initAuthForms();
initSiteInteractions();
