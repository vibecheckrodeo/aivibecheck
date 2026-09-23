import { deleteInstallation, listInstallations } from './github.js';

const GRACE_PERIOD = 7 * 24 * 60 * 60 * 1000;
const bound = (env, installationId) => env.DB.prepare("SELECT 1 AS present FROM connections WHERE provider='github' AND external_id=? AND state!='removed' LIMIT 1").bind(String(installationId)).first();

// The claim and the connection INSERT must both be guarded atomic statements.
// All GitHub connection inserts must reject IDs in github_installation_cleanup.
// Claims are permanent tombstones; installation IDs are never repurposed here.
export async function cleanupGitHubOrphans(env, config, { now = Date.now(), limit = 25 } = {}) {
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid GitHub cleanup limits.');
  // Finish and validate every inventory page before touching claims or providers.
  // An inventory failure fails closed, including retries of previous claims.
  const inventory = await listInstallations(env, config);
  const current = new Map(inventory.map(item => [String(item.installationId), item]));
  const cutoff = now - GRACE_PERIOD;
  const eligible = inventory.filter(item => item.createdAt < cutoff);
  // A pending claim is durable proof of a previously verified old installation.
  // Retry it even if GitHub's current inventory no longer includes that ID.
  const pendingWhere="removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM connections WHERE provider='github' AND external_id=installation_id AND state!='removed')";
  const pendingTotal=(await env.DB.prepare(`SELECT count(*) AS n FROM github_installation_cleanup WHERE ${pendingWhere}`).first()).n;
  const pendingLimit=Math.min(100,pendingTotal),pendingOffset=pendingTotal?(Math.floor(now/900000)*100)%pendingTotal:0;
  const pending=pendingLimit?(await env.DB.prepare(`SELECT installation_id,requested_at FROM github_installation_cleanup WHERE ${pendingWhere} ORDER BY requested_at,installation_id LIMIT ? OFFSET ?`).bind(pendingLimit,pendingOffset).all()).results:[];
  if(pending.length<pendingLimit){
    const wrap=(await env.DB.prepare(`SELECT installation_id,requested_at FROM github_installation_cleanup WHERE ${pendingWhere} ORDER BY requested_at,installation_id LIMIT ?`).bind(pendingLimit-pending.length).all()).results;
    const seen=new Set(pending.map(row=>row.installation_id));
    pending.push(...wrap.filter(row=>!seen.has(row.installation_id)));
  }
  const candidates = new Map(eligible.map(item => [String(item.installationId), item.createdAt]));
  for (const row of pending) candidates.set(row.installation_id, row.requested_at);
  const summary = { scanned: inventory.length, eligible: eligible.length, claimed: 0, removed: 0, failed: 0, skippedBound: 0, skippedRecent: inventory.length - eligible.length, skippedRemoved: 0, pending: 0, limited: false };
  const candidateIds = [...candidates.keys()], ready = [];
  // Keep the SQL parameter count below D1's limit and filter before budgeting.
  // Otherwise the same old active connections could starve every orphan forever.
  for (let start = 0; start < candidateIds.length; start += 90) {
    const batch = candidateIds.slice(start, start + 90);
    const checked = await env.DB.prepare(`WITH candidates(id) AS (VALUES ${batch.map(() => '(?)').join(',')}) SELECT candidates.id,cleanup.removed_at,cleanup.requested_at,EXISTS(SELECT 1 FROM connections WHERE provider='github' AND external_id=candidates.id AND state!='removed') AS bound FROM candidates LEFT JOIN github_installation_cleanup AS cleanup ON cleanup.installation_id=candidates.id`).bind(...batch).all();
    for (const item of checked.results) {
      if (item.bound) { summary.skippedBound++; continue; }
      if (item.removed_at !== null) { summary.skippedRemoved++; continue; }
      if (current.has(item.id) && current.get(item.id).createdAt >= cutoff) continue;
      ready.push({ id: item.id, priority: item.requested_at ?? candidates.get(item.id) });
    }
  }
  ready.sort((a, b) => a.priority - b.priority || Number(a.id) - Number(b.id));
  summary.limited = ready.length > limit;

  for (const { id: installationId } of ready.slice(0, limit)) {
    const result = await env.DB.prepare("INSERT INTO github_installation_cleanup(installation_id,requested_at) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM connections WHERE provider='github' AND external_id=? AND state!='removed') ON CONFLICT(installation_id) DO NOTHING").bind(installationId, now, installationId).run();
    summary.claimed += Number(result.meta?.changes || 0);
    const claim = await env.DB.prepare('SELECT removed_at FROM github_installation_cleanup WHERE installation_id=?').bind(installationId).first();
    if (!claim) { summary.skippedBound++; continue; }
    if (claim.removed_at !== null) { summary.skippedRemoved++; continue; }
    // Connection binding that wins before the atomic claim always wins cleanup.
    // The reciprocal connection INSERT guard prevents binding after the claim.
    if (await bound(env, installationId)) { summary.skippedBound++; continue; }
    // The field is an attempt timestamp, not proof of the installation's age.
    // Rotating it gives later pending claims a turn when a provider keeps failing.
    await env.DB.prepare('UPDATE github_installation_cleanup SET requested_at=? WHERE installation_id=? AND removed_at IS NULL').bind(now, installationId).run();
    try {
      await deleteInstallation(env, config, installationId);
    } catch {
      // Do not persist error bodies, tokens or exception messages from providers.
      await env.DB.prepare('UPDATE github_installation_cleanup SET last_error=? WHERE installation_id=? AND removed_at IS NULL').bind('GitHub removal is pending; cleanup will retry.', installationId).run();
      summary.failed++;
      continue;
    }
    await env.DB.prepare('UPDATE github_installation_cleanup SET removed_at=?,last_error=NULL WHERE installation_id=? AND removed_at IS NULL').bind(now, installationId).run();
    summary.removed++;
  }
  const remaining = await env.DB.prepare('SELECT count(*) AS count FROM github_installation_cleanup WHERE removed_at IS NULL').first();
  summary.pending = remaining.count;
  return summary;
}
