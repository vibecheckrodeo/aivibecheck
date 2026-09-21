// Match Proton's complete share link, including the client-side room password.
// https://github.com/ProtonMail/WebClients/blob/main/packages/shared/lib/meet/parseMeetingLink.ts
// Format validation cannot prove the room exists: the operator must open it first.
export function validateMeetingUrl(value) {
  const invalid = () => { throw Object.assign(new Error('Paste the complete Proton Meet link, including #pwd-….'), {status:400}); };
  if (typeof value !== 'string' || value.length > 2048) invalid();
  let url;
  try { url = new URL(value.trim()); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'meet.proton.me' || url.port || url.username || url.password || url.search ||
      !/^\/join\/id-[A-Za-z0-9_-]{10}$/.test(url.pathname) || !/^#pwd-[A-Za-z0-9_-]{12}$/.test(url.hash)) invalid();
  return url.href;
}
