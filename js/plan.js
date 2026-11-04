/* js/plan.js — Focus Pro plan store (Step 2) */
const Plan = (() => {
  let isPremium = false, planName = null, status = null, currentPeriodEnd = null, cancelAtPeriodEnd = false, loading = true;
  // lastGood lives in memory only, tied to a user id.
  let lastGood = null;          // { isPremium, planName, status, currentPeriodEnd, cancelAtPeriodEnd, userId }
  let lastGoodUserId = null;    // the user id the cached state belongs to
  let hooked = false;
  const listeners = new Set();
  const retryDelays = [3000, 10000, 30000];
  let retryAttempt = 0;
  let retryTimer = null;

  function currentUserId() {
    try {
      if (typeof Cloud !== 'undefined' && Cloud.user) return Cloud.user() ? (Cloud.user().uid || null) : null;
    } catch (_) {}
    return null;
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function notify() {
    for (const fn of Array.from(listeners)) { try { fn(); } catch (err) { console.error('Plan listener failed', err); } }
  }

  function reset() {
    isPremium = false; planName = null; status = null; currentPeriodEnd = null; cancelAtPeriodEnd = false; loading = false;
    lastGood = null;
    lastGoodUserId = null;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function scheduleRetry(uid) {
    retryAttempt += 1;
    if (retryAttempt <= retryDelays.length && uid !== null) {
      retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, retryDelays[retryAttempt - 1]);
    }
  }

  async function refresh() {
    const uid = currentUserId();
    // A different user must never inherit the previous user's state, even for a moment.
    if (lastGoodUserId !== null && lastGoodUserId !== uid && uid !== null) reset();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    loading = true;
    try {
      if (typeof Cloud === 'undefined' || !Cloud.plan) { loading = false; notify(); return; }
      const row = await Cloud.plan();
      loading = false;
      if (!row) {
        // No row: keep lastGood only if the same user is still signed in.
        const nowUid = currentUserId();
        if (lastGood && lastGoodUserId === nowUid) {
          isPremium = lastGood.isPremium; planName = lastGood.planName; status = lastGood.status;
          currentPeriodEnd = lastGood.currentPeriodEnd; cancelAtPeriodEnd = lastGood.cancelAtPeriodEnd;
        } else {
          reset();
          scheduleRetry(nowUid);
        }
        notify();
        return;
      }
      // A scheduled cancellation is not a revocation: the user keeps Pro for
      // the period they paid for (month or year). Supabase's is_premium is the
      // source of truth; the subscription status only blocks dead rows.
      cancelAtPeriodEnd = !!row.cancel_at_period_end;
      const deadStatus = ['canceled', 'unpaid', 'incomplete', 'incomplete_expired'].includes(String(row.status || '').toLowerCase());
      isPremium = !!row.is_premium && !deadStatus;
      planName = row.plan || null;
      status = row.status || null;
      currentPeriodEnd = row.current_period_end || null;
      const nowUid = currentUserId();
      lastGood = { isPremium, planName, status, currentPeriodEnd, cancelAtPeriodEnd, userId: nowUid };
      lastGoodUserId = nowUid;
      retryAttempt = 0;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    } catch (_) {
      loading = false;
      const nowUid = currentUserId();
      if (lastGood && lastGoodUserId === nowUid) {
        isPremium = lastGood.isPremium; planName = lastGood.planName; status = lastGood.status;
        currentPeriodEnd = lastGood.currentPeriodEnd; cancelAtPeriodEnd = lastGood.cancelAtPeriodEnd;
      } else {
        reset();
        // First-load failure (no lastGood): retry on 3s, 10s, then 30s, stop.
        scheduleRetry(nowUid);
      }
    }
    notify();
  }

  function hook() {
    if (hooked) return;
    if (typeof Cloud === 'undefined' || !Cloud.on) return;
    hooked = true;
    Cloud.on('user', (u) => { if (!u) { reset(); notify(); } else refresh(); });
    window.addEventListener('focus', () => refresh());
    refresh();
  }

  return {
    get isPremium() { return isPremium; },
    get plan() { return planName; },
    get status() { return status; },
    get currentPeriodEnd() { return currentPeriodEnd; },
    get cancelAtPeriodEnd() { return cancelAtPeriodEnd; },
    get loading() { return loading; },
    refresh, hook, reset, onChange
  };
})();

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Plan.hook());
  else Plan.hook();
}
