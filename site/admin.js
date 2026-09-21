const $ = id => document.getElementById(id);
let key = '', session = 0;
const date = value => value ? new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET' : '—';
const el = (tag, value, className) => { const element = document.createElement(tag); if (value) element.textContent = value; if (className) element.className = className; return element; };
function message(value) { $('admin-status').textContent = value; $('admin-status').hidden = false; }
async function api(path, method = 'GET', data) {
  const response = await fetch('/api/admin/' + path, { method, headers: { Authorization: `Bearer ${key}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'That request could not be completed.');
  return value;
}
async function action(fn) { try { await fn(); } catch (error) { message(error.message); } }
function button(label, fn, refresh = true) {
  const element = el('button', label); element.type = 'button';
  element.addEventListener('click', () => action(async () => {
    element.disabled = true;
    try { await fn(); if (refresh) await reload(); } finally { element.disabled = false; }
  }));
  return element;
}
function externalLink(href, label) {
  let url; try { url = new URL(href); } catch { return el('span', label || 'Invalid link'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return el('span', label || 'Invalid link');
  const link = el('a', label || href); link.href = url.href; link.target = '_blank'; link.rel = 'noreferrer'; return link;
}
function appendReply(card, row) {
  if (['expired','declined'].includes(row.status)) return;
  const section=el('section'), heading=el('h3','Your reply and time estimate');
  const replyLabel=el('label','Reply to the customer'), reply=el('textarea');
  reply.id=`reply-${row.id}`; replyLabel.htmlFor=reply.id; reply.rows=4; reply.maxLength=4000; reply.value=row.reply || '';
  const estimateLabel=el('label','Estimated time needed'), estimate=el('select');
  estimate.id=`estimate-${row.id}`; estimateLabel.htmlFor=estimate.id;
  for(const minutes of [15,30,60]){const option=el('option',`${minutes} minutes`);option.value=minutes;estimate.append(option);}
  estimate.value=row.estimated_minutes || 15;
  const followLabel=el('label',null,'check'), follow=el('input');follow.type='checkbox';follow.checked=Boolean(row.upsell_enabled);
  followLabel.append(follow,el('span','Extra time would help this customer. Enable optional follow-ups.'));
  const countLabel=el('label','Maximum upgrade messages'), count=el('select');count.id=`drips-${row.id}`;countLabel.htmlFor=count.id;
  for(const number of [3,4]){const option=el('option',String(number));option.value=number;count.append(option);}count.value=row.upsell_count || 3;
  section.append(heading,replyLabel,reply,estimateLabel,estimate,followLabel,countLabel,count,el('p','Only opted-in, email-confirmed customers receive upgrade messages. The sequence stops after an upgrade, when time is unavailable, or when the call is within 24 hours. Material requests are separate.','help'),button('Save reply and estimate',async()=>{await api(`requests/${row.id}/reply`,'POST',{reply:reply.value,estimatedMinutes:Number(estimate.value),upsellEnabled:follow.checked,upsellCount:Number(count.value)});message('Reply saved on the request page. Its email is queued, not yet delivered.');}));
  if(['draft','submitted'].includes(row.status)){
    const materialLabel=el('label','Materials still needed'), materials=el('textarea');materials.id=`materials-${row.id}`;materialLabel.htmlFor=materials.id;materials.rows=2;materials.maxLength=2000;
    section.append(materialLabel,materials,button('Queue material request',async()=>{await api(`requests/${row.id}/materials`,'POST',{message:materials.value});message('Material request queued separately from upgrade messages.');}));
  }
  const emails=el('div');
  section.append(button('Check email status',async()=>{const status=await api(`requests/${row.id}/email`);emails.replaceChildren(el('p',`${status.transactional?'Sender configured':'Email sender not configured'} · ${status.verified?'Address confirmed':'Address not confirmed'} · ${status.consent?'Optional reminders enabled':'Optional reminders off'}`));for(const item of status.messages)emails.append(el('p',`${item.category} · ${item.kind} · ${item.state}${item.last_error?` · ${item.last_error}`:''}`));},false),emails);
  card.append(section);
}
function showIntegrations(configuration) {
  $('github-configuration').textContent = configuration.github ? 'GitHub App is configured for customer authorization.' : 'Create the read-only GitHub App to let customers authorize a selected repository.';
  $('github-app-link').replaceChildren();
  if (configuration.githubAppUrl) $('github-app-link').append(externalLink(configuration.githubAppUrl, 'Open GitHub App'));
  $('github-setup').hidden = Boolean(configuration.github);
  $('figma-configuration').textContent = configuration.figma && configuration.figmaPublic ? 'Figma authorization is configured and marked approved for public use.' : configuration.figma ? 'Figma credentials are configured. Public authorization is waiting for Figma app approval.' : 'Figma credentials are not configured. Customers can share view-only file links.';
  $('figma-callback').textContent = `${location.origin}/api/connect/figma/callback`;
}
function showFigmaTree(document, parent) {
  let remaining = 500, truncated = false;
  function appendNode(value, target, depth = 0) {
    if (!value || typeof value !== 'object') return;
    if (remaining <= 0 || depth > 6) { truncated = true; return; }
    remaining--;
    const name = typeof value.name === 'string' ? value.name : 'Unnamed';
    const type = typeof value.type === 'string' ? value.type : 'Node';
    const children = Array.isArray(value.children) ? value.children : [];
    if (children.length) {
      const details = el('details'); details.open = depth < 1; details.append(el('summary', `${name} · ${type}`));
      const list = el('div', null, 'figma-tree');
      for (const child of children) { if (remaining <= 0) { truncated = true; break; } appendNode(child, list, depth + 1); }
      details.append(list); target.append(details);
    } else target.append(el('p', `${name} · ${type}`));
  }
  appendNode(document, parent);
  if (truncated) parent.append(el('p', 'This preview is limited to 500 nodes.', 'help'));
}
async function browseConnection(connection, viewer, path = '') {
  const activeSession = session;
  viewer.hidden = false; viewer.replaceChildren(el('p', 'Loading shared project…', 'help'));
  try {
    const result = await api(`connections/${encodeURIComponent(connection.id)}/read${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    if (!key || activeSession !== session) return;
    viewer.replaceChildren();
    viewer.append(button('Close project preview', () => { viewer.replaceChildren(); viewer.hidden = true; }, false));
    if (connection.provider === 'figma') {
      viewer.append(el('h4', typeof result.name === 'string' ? result.name : 'Figma file'), el('p', 'Pages and top-level objects from the shared file. The preview does not modify the design.', 'help'));
      showFigmaTree(result.document, viewer); return;
    }
    viewer.append(el('h4', path || connection.resource.repository || 'Repository'));
    if (path) {
      const up = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      viewer.append(button('Up one folder', () => browseConnection(connection, viewer, up), false));
    }
    if (Array.isArray(result)) {
      const list = el('ul', null, 'repository-list');
      for (const entry of result) {
        const item = el('li');
        if (['dir', 'file'].includes(entry.type) && typeof entry.path === 'string') {
          const open = button(`${entry.type === 'dir' ? 'Folder: ' : ''}${String(entry.name || entry.path)}`, () => browseConnection(connection, viewer, entry.path), false);
          open.className = 'text-button'; item.append(open);
        } else item.textContent = `${String(entry.name || 'Entry')} · ${String(entry.type || 'Unavailable')}`;
        list.append(item);
      }
      viewer.append(list); if (!result.length) viewer.append(el('p', 'This directory is empty.')); return;
    }
    if (result.type === 'file' && result.encoding === 'base64' && typeof result.content === 'string') {
      let source;
      try {
        const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, '')), char => char.charCodeAt(0));
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (source.includes('\0')) throw new Error('Binary content');
      } catch { viewer.append(el('p', 'This file is not UTF-8 text, so it cannot be displayed in this preview.')); return; }
      const maximum = 200000;
      if (source.length > maximum) viewer.append(el('p', 'Showing the first 200,000 characters of this file.', 'help'));
      const pre = el('pre'); pre.append(el('code', source.slice(0, maximum))); viewer.append(pre); return;
    }
    viewer.append(el('p', 'This file cannot be displayed in the project preview.'));
  } catch (error) {
    if (!key || activeSession !== session) return;
    viewer.replaceChildren(el('p', error.message, 'notice'));
  }
}
function appendConnections(card, row, connections) {
  const related = connections.filter(connection => connection.request_id === row.id);
  if (!related.length) return;
  const section = el('section', null, 'admin-connections'); section.append(el('h3', 'Authorized projects'));
  for (const connection of related) {
    const name = connection.provider === 'github' ? 'GitHub' : 'Figma';
    const state = connection.state === 'active' ? 'Connected' : connection.state === 'cleanup_due' ? 'Removal pending' : connection.provider === 'figma' ? 'Stored tokens removed' : 'Access removed';
    const item = el('div', null, 'connection-item'); item.append(el('p', `${name} · ${state}`));
    if (connection.resource?.url) item.append(externalLink(connection.resource.url, connection.resource.repository || connection.resource.url));
    if (connection.last_error) item.append(el('p', connection.last_error, 'help'));
    if (connection.state === 'active' && !['expired', 'declined'].includes(row.status)) {
      const viewer = el('div', null, 'project-viewer'); viewer.hidden = true;
      item.append(button('Browse shared project', () => browseConnection(connection, viewer), false), viewer);
    }
    if (connection.state !== 'removed') item.append(button(connection.state === 'cleanup_due' ? 'Retry access removal' : 'Remove connected access', async () => {
      const result = await api(`connections/${encodeURIComponent(connection.id)}/remove`, 'POST', {});
      message(result.removed ? `${name} ${connection.provider === 'figma' ? 'stored tokens were deleted. The customer can also revoke the app in Figma.' : 'access removal was confirmed.'}` : 'Removal is still pending. Check the connection and retry.');
    }));
    section.append(item);
  }
  card.append(section);
}
async function reload() {
  const activeSession = session;
  const [data, integrations, connected] = await Promise.all([api('requests'), api('integrations'), api('connections')]);
  if (!key || activeSession !== session) return;
  $('login').hidden = true; $('dashboard').hidden = false;
  $('configuration').textContent = data.payments ? 'Stripe is configured. Requests must be approved before checkout.' : 'Stripe is not configured. Registration and review work; checkout remains unavailable. Install the Stripe key and webhook secret before inviting a deposit.';
  showIntegrations(integrations); $('requests').replaceChildren();
  for (const row of data.requests) {
    const card = el('article', null, 'admin-card');
    card.append(el('h2', row.name), el('p', `${row.email} · ${row.status}`), el('p', `Registered ${date(row.created_at)} · Deadline ${date(row.expires_at)}`), el('p', row.description || 'Project details not completed yet.', 'preserve'));
    for (const href of row.links) { const paragraph = el('p'); paragraph.append(externalLink(href)); card.append(paragraph); }
    if (row.access_notes) card.append(el('p', row.access_notes, 'preserve'));
    if (row.status === 'submitted') {
      const label = el('label', 'Agreed review focus'), scope = el('textarea');
      scope.rows = 3; scope.id = `scope-${row.id}`; label.htmlFor = scope.id;
      card.append(label, scope, button('Approve request', () => api(`requests/${row.id}`, 'POST', { action: 'approve', scope: scope.value })), button('Decline request', () => api(`requests/${row.id}`, 'POST', { action: 'decline' })));
    }
    if (row.scope) card.append(el('p', `Review focus: ${row.scope}`));
    if (row.status === 'approved') card.append(el('p', 'Approval is visible on the customer’s private request page. Check email status to see whether the notification has been delivered.'));
    appendReply(card,row);
    if (row.booking) card.append(el('p', `Booked: ${date(row.booking.starts_at)} · ${(row.booking.ends_at-row.booking.starts_at)/60000} minutes`));
    if(row.pending_upgrade)card.append(el('p',`Upgrade awaiting confirmation: ${row.pending_upgrade.minutes} minutes · ${row.pending_upgrade.status} · checkout deadline ${date(row.pending_upgrade.expires_at)}. The time stays held until Stripe confirms payment or expiry. Use “Run due access cleanup” to reconcile it.`));
    appendConnections(card, row, connected.connections);
    if (!['expired', 'declined'].includes(row.status)) {
      const details = el('details'), summary = el('summary', 'Record a separate account invitation'); details.append(summary);
      const provider = el('input'), resource = el('input');
      provider.placeholder = 'Platform (github, figma, replit, …)'; resource.placeholder = 'Repository owner/name or access-removal reference'; provider.setAttribute('aria-label', 'Platform'); resource.setAttribute('aria-label', 'Access-removal reference');
      details.append(el('p', 'Record any separate account invitation you accept. App connections and links in the request are already tracked.'), provider, resource, button('Track access', () => api(`requests/${row.id}`, 'POST', { action: 'track-access', provider: provider.value, resource: resource.value })));
      card.append(details);
    }
    $('requests').append(card);
  }
  if (!data.requests.length) $('requests').append(el('p', 'No registrations yet.'));
  $('grants').replaceChildren();
  for (const grant of data.grants.filter(item => item.state === 'cleanup_due')) {
    const card = el('div', null, 'admin-card'); card.append(el('p', `${grant.provider}: ${grant.resource}`), el('p', grant.last_error || ''), button('I verified access has been removed', () => api(`grants/${grant.id}`, 'POST', { confirmRemoved: true }))); $('grants').append(card);
  }
  const pending = connected.connections.filter(connection => connection.state === 'cleanup_due');
  for (const connection of pending) {
    const card = el('div', null, 'admin-card');
    card.append(el('p', `${connection.provider}: ${connection.resource?.repository || connection.resource?.url || 'Connected project'}`), el('p', connection.last_error || 'App removal has not been confirmed.'), button('Retry app removal', async () => { const result = await api(`connections/${encodeURIComponent(connection.id)}/remove`, 'POST', {}); message(result.removed ? 'Stored connected access has been removed.' : 'Removal is still pending.'); }));
    $('grants').append(card);
  }
  if (!data.grants.some(grant => grant.state === 'cleanup_due') && !pending.length) $('grants').append(el('p', 'No external-access removals are due.'));
  $('published-slots').replaceChildren();
  for (const slot of data.slots) {
    const item = el('div', null, 'admin-card'); item.append(el('p', `${date(slot.starts_at)} · ${slot.request_id || slot.claim_state==='booked' ? 'Booked' : slot.claim_state==='held' ? 'Held during checkout' : slot.room_reserved ? 'Room reserved for an existing customer' : 'Available'}`));
    if (!slot.request_id&&!slot.claim_state) item.append(button('Remove this availability', () => api(`slots/${slot.id}`, 'DELETE')));
    $('published-slots').append(item);
  }
}
$('login').addEventListener('submit', event => { event.preventDefault(); session++; key = $('admin-key').value; $('admin-key').value = ''; $('admin-status').hidden = true; action(reload); });
$('reload').addEventListener('click', () => action(reload));
$('cleanup').addEventListener('click', () => action(async () => { const result = await api('cleanup', 'POST', {}); message(`Expired ${result.expired} unpaid requests. Review outstanding external access below.`); await reload(); }));
$('run-email').addEventListener('click',()=>action(async()=>{const result=await api('email','POST',{});message(result.configured?`${result.accepted} messages accepted by the sender. Acceptance is separate from delivery.`:'Email sending is not configured. No messages were sent.');}));
$('logout').addEventListener('click', () => { session++; key = ''; for (const id of ['requests', 'grants', 'published-slots', 'github-app-link', 'campaign-results']) $(id).replaceChildren(); $('dashboard').hidden = true; $('login').hidden = false; $('admin-status').hidden = true; });
$('slot-form').addEventListener('submit', event => { event.preventDefault(); action(async () => { if (!/(Z|[+-]\d\d:\d\d)$/.test($('slot-start').value)) throw new Error('Include the time-zone offset.'); await api('slots', 'POST', { startsAt: Date.parse($('slot-start').value), meetingUrl: $('slot-meeting').value }); message('Appointment published.'); await reload(); }); });
$('github-setup').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    const submit = event.submitter; submit.disabled = true;
    try {
      const result = await api('integrations/github', 'POST', { owner: $('github-owner').value.trim(), organization: $('github-organization').checked });
      const target = new URL(result.action);
      if (target.protocol !== 'https:' || target.hostname !== 'github.com' || target.username || target.password || !/^\/(?:organizations\/[A-Za-z0-9-]+\/)?settings\/apps\/new$/.test(target.pathname) || !/^[a-f0-9]{64}$/.test(result.state)) throw new Error('The GitHub setup page could not be verified.');
      target.searchParams.set('state', result.state);
      const form = el('form'); form.method = 'POST'; form.action = target.href; form.hidden = true;
      const manifest = el('input'); manifest.type = 'hidden'; manifest.name = 'manifest'; manifest.value = JSON.stringify(result.manifest); form.append(manifest); document.body.append(form); form.submit();
    } finally { submit.disabled = false; }
  });
});

$('load-campaigns').addEventListener('click',()=>action(async()=>{
  const activeSession=session,result=await api('campaigns');
  if(!key||activeSession!==session)return;
  const target=$('campaign-results');target.replaceChildren();
  for(const row of result.campaigns){
    const card=el('article',null,'admin-card');
    card.append(el('h3',row.source==='linkedin'?`LinkedIn · ${row.content||'unlabeled ad'}`:'No recognized launch ad'));
    card.append(el('p',`Theme shown: ${row.theme}`));
    card.append(el('p',`${row.registrations} registrations · ${row.submissions} submissions · ${row.approvals} approvals · ${row.deposits} deposits · ${row.bookings} bookings`));
    card.append(el('p',`Gross payments: ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(row.gross_cents/100)}`));
    target.append(card);
  }
  if(!result.campaigns.length)target.append(el('p','No registrations yet.'));
}));
