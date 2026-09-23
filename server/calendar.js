const fail = message => { throw Object.assign(new Error(message), { status: 503 }); };
const UNAVAILABLE = 'I cannot check Ashley’s calendar right now. Please try again shortly; no time has been reserved.';

export function calendarConfiguration(env) {
  const required = env.GOOGLE_CALENDAR_REQUIRED === 'true' || (env.GOOGLE_CALENDAR_REQUIRED !== 'false' && env.PUBLIC_ORIGIN === 'https://vibecheck.rodeo');
  const ids = (env.GOOGLE_CALENDAR_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  const configured = Boolean(env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET && env.GOOGLE_CALENDAR_REFRESH_TOKEN && ids.length);
  return { required, configured, provider: 'google', calendars: ids.length };
}

// Only time ranges leave Google. Event names, guests, and descriptions are not
// requested, stored, or returned to a customer.
export async function calendarBusy(env, start, end) {
  const { required, configured } = calendarConfiguration(env);
  if (!required && !configured) return [];
  if (!configured || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) fail(UNAVAILABLE);
  const network = env.CALENDAR_FETCH || fetch;
  try {
    const tokenResponse = await network('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CALENDAR_CLIENT_ID, client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET, refresh_token: env.GOOGLE_CALENDAR_REFRESH_TOKEN, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(12000)
    });
    if (!tokenResponse.ok) fail(UNAVAILABLE);
    const token = await tokenResponse.json();
    if (typeof token.access_token !== 'string' || !token.access_token) fail(UNAVAILABLE);
    const ids = (env.GOOGLE_CALENDAR_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
    const response = await network('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), items: ids.map(id => ({ id })) }),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) fail(UNAVAILABLE);
    const body = await response.json();
    if (!body.calendars || typeof body.calendars !== 'object') fail(UNAVAILABLE);
    const busy = [];
    for (const id of ids) {
      const calendar = body.calendars[id];
      if (!calendar || !Array.isArray(calendar.busy) || calendar.errors?.length) fail(UNAVAILABLE);
      for (const period of calendar.busy) {
        const from = Date.parse(period.start), to = Date.parse(period.end);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) fail(UNAVAILABLE);
        busy.push({ start: from, end: to });
      }
    }
    return busy;
  } catch { fail(UNAVAILABLE); }
}

export const overlapsBusy = (busy, start, end) => busy.some(period => period.start < end && start < period.end);
