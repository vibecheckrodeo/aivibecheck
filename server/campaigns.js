const themes=new Set(['butter','geometric','ribbon','expressive-serif']);

// Only known launch labels; never store arbitrary URL values or credentials.
export function campaignAttribution(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  const result={};
  if(themes.has(value.theme))result.theme=value.theme;
  if(value.source==='linkedin'&&value.medium==='paid_social'&&value.campaign==='launch_theme_01'){
    Object.assign(result,{source:'linkedin',medium:'paid_social',campaign:'launch_theme_01'});
    if(themes.has(value.content))result.content=value.content;
  }
  return result;
}

export async function campaignResults(env){
  const {results}=await env.DB.prepare(`WITH upgrades AS (
    SELECT request_id,sum(amount_cents) AS cents FROM review_payments WHERE status='paid' GROUP BY request_id
  ) SELECT
    coalesce(json_extract(r.attribution,'$.source'),'unattributed') AS source,
    coalesce(json_extract(r.attribution,'$.campaign'),'') AS campaign,
    coalesce(json_extract(r.attribution,'$.content'),'') AS content,
    coalesce(json_extract(r.attribution,'$.theme'),'unknown') AS theme,
    count(*) AS registrations,
    sum(r.completed_at IS NOT NULL) AS submissions,
    sum(r.approved_at IS NOT NULL) AS approvals,
    sum(r.paid_at IS NOT NULL) AS deposits,
    sum(r.booked_slot_id IS NOT NULL) AS bookings,
    sum(CASE WHEN r.paid_at IS NOT NULL THEN r.deposit_cents ELSE 0 END+coalesce(u.cents,0)) AS gross_cents
  FROM requests r LEFT JOIN upgrades u ON u.request_id=r.id
  GROUP BY source,campaign,content,theme ORDER BY campaign,content,theme`).all();
  return {campaigns:results,currency:'usd'};
}
