/* Entry: public marketing + auth pages (index, contact, login, signup).
 * Site interactions + landing (prize calculator, spotlight, timeline) +
 * account nav + auth forms. */
import { initAccountNav } from "../auth/account-nav.js";
import { initSiteInteractions } from "../site/interactions.js";
import { initLanding } from "../site/landing.js";

initAccountNav();
initSiteInteractions();
initLanding();

if (document.getElementById("login-form") || document.getElementById("signup-form")) {
  import("../auth/auth-forms.js")
    .then((module) => module.initAuthForms())
    .catch(() => {
      // Stale deploy or offline: say so instead of a dead form.
      const note = document.getElementById("login-error") || document.getElementById("signup-error");
      if (note) { note.textContent = "Couldn't load sign-in. Refresh the page and try again."; note.hidden = false; }
    });
}
