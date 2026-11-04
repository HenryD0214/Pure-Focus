/* config.js — site configuration. */
const Config = Object.freeze({
  // Read-only Google Calendar and Tasks import. Account sign-in is separate and
  // uses the Supabase project below. Paste a Google "Web application" OAuth
  // client ID here to turn the import on.
  GOOGLE_WEB_CLIENT_ID: '',
  // Accounts and sync (required). Paste between the backticks EXACTLY what your
  // console shows:
  //  • Supabase: Project URL and the publishable key (Project Settings › API Keys), or
  //  • Firebase: the whole `const firebaseConfig = {…}` block (Project settings › Your apps).
  // Examples (one or the other):
  //   CLOUD: `https://abcdefghijklmnopqrst.supabase.co
  //           sb_publishable_AbC…`,
  //   CLOUD: `const firebaseConfig = { apiKey: "AIza…", authDomain: "…", projectId: "…", appId: "…" };`,
  // Never paste a secret key (sb_secret_… / service_role): it is refused.
  // This is a publishable key: it is meant to ship in the browser. All access is
  // enforced by the SQL policies in backend/supabase.sql (RLS + RPCs).
  CLOUD: `https://uuqgscrrmpzpiatlsctz.supabase.co
          sb_publishable_oJBf_s0RppuW-9BHRkH1RA_wQeS2Cvq`,
  // Courses are on and need no key (USER-HOTFIX-2 H14). An AI key is optional
  // (Settings › Calendar & Accounts › Planner & courses) and only reads syllabi.
  // planner: the Calendar's "Plan my week" button, its menu, Shift+P and the sidebar link (off for now).
  FEATURES: Object.freeze({ studyCoach: true, planner: false }),
});
