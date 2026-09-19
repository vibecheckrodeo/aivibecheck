const $ = id => document.getElementById(id);
const savedRequest = {
  get(){try{return localStorage.getItem('vc_request_id');}catch{return null;}},
  set(value){try{localStorage.setItem('vc_request_id',value);}catch{}},
  clear(){try{localStorage.removeItem('vc_request_id');}catch{}}
};
let id = new URLSearchParams(location.search).get('request') || savedRequest.get();
let access = new URLSearchParams(location.hash.slice(1)).get('access');
let current, chosenSlot, connectionConfiguration = {};
let returnedProvider = new URLSearchParams(location.search).get('connected');
const time = value => new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value));
function notice(message, error=false){ $('notice').textContent=message; $('notice').hidden=false; $('notice').setAttribute('role',error?'alert':'status'); }
async function api(path,method='GET',data){const response=await fetch(`/api/${path}`,{method,credentials:'same-origin',headers:{...(data?{'Content-Type':'application/json'}:{}),...(access?{Authorization:`Bearer ${access}`}:{})},body:data?JSON.stringify(data):undefined});const value=await response.json();if(!response.ok)throw new Error(value.error||'Please try again.');return value;}
async function busy(button,fn){const label=button.textContent;button.disabled=true;button.textContent='Saving…';try{await fn();}catch(error){notice(error.message,true);}finally{button.textContent=label;button.disabled=false;}}
function count(){const n=$('problem').value.trim().split(/\s+/u).filter(Boolean).length;$('word-count').textContent=`${n.toLocaleString()} / 1,000 words`;$('word-count').classList.toggle('over',n>1000);$('problem').setCustomValidity(n>1000?'Please shorten this to 1,000 words or less.':'');$('problem').setAttribute('aria-invalid',String(n>1000));}
function privateLink(){if(!access)return;$('private-link').value=`${location.origin}/?request=${id}#access=${access}`;$('private-link-box').hidden=false;}
async function render(row){current=row;$('registration-form').hidden=true;$('request-state').hidden=false;privateLink();
const states={draft:['Your registration is saved.','Add your project details below. You can save and come back before submitting for review.'],submitted:['Your request is waiting for review.','I’ll look through what you’ve shared. Return here to see my response. There is nothing to pay yet.'],approved:['Your request is approved.','Review the agreed focus below. The next step is your deposit, then choosing a time.'],paid:['Your deposit is confirmed.','Choose an available time below.'],booked:['Your appointment is confirmed.','The meeting details are saved below.'],declined:['This request has been declined.','No deposit is due. The shared links have been removed from your request.'],expired:['The deposit deadline has passed.','Your shared links have been removed from this request. Separate account invitations are queued for removal in the relevant service.']};
[$('status-title').textContent,$('status-copy').textContent]=states[row.status];$('project-form').hidden=row.status!=='draft';$('submitted-details').hidden=!['submitted','approved','paid','booked'].includes(row.status);$('approved').hidden=!['approved','paid'].includes(row.status);$('scheduling').hidden=row.status!=='paid';$('confirmation').hidden=row.status!=='booked';$('edit-project').hidden=row.status!=='submitted';
$('problem').value=row.description;$('links').value=row.links.join('\n');$('notes').value=row.access_notes;$('complete').checked=Boolean(row.completed_at);count();$('description-summary').textContent=row.description;$('shared-links').replaceChildren();
for(const href of row.links){const li=document.createElement('li'),a=document.createElement('a');a.href=href;a.textContent=href;a.rel='noreferrer';a.target='_blank';li.append(a);$('shared-links').append(li);}
$('deadline').textContent=row.expires_at&&!row.paid_at?`Deposit deadline: ${time(row.expires_at)}. Editing the request does not restart the seven days.`:'';$('agreed-scope').textContent=row.scope;$('pay').hidden=row.status!=='approved'||!row.payment_ready;$('payment-copy').textContent=row.paid_at?'Your $25 deposit has been verified by Stripe and covers the first 15 minutes of your review.':row.payment_ready?'The $25 deposit covers the first 15 minutes of your review. Payment is handled by Stripe.':'Your request is approved, but deposit payments aren’t connected yet. There is nothing to pay now.';
if(row.status==='paid')await loadSlots();if(row.booking){$('booking-time').textContent=`${time(row.booking.starts_at)} · 15 minutes`;$('zoom').href=row.booking.zoom_url;}await loadConnections();}
const node = (tag, text, className) => {const element=document.createElement(tag);if(text)element.textContent=text;if(className)element.className=className;return element;};
function projectUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}}
function showConnections(connections){
  $('connection-list').replaceChildren();
  for(const connection of connections){
    const title=connection.provider==='github'?'GitHub':'Figma';
    const state=connection.state==='active'?'Connected':connection.state==='cleanup_due'?'Removal pending':connection.provider==='figma'?'Stored access removed':'Access removed';
    const item=node('div',null,'connection-item');item.append(node('p',`${title} · ${state}`));
    const href=projectUrl(connection.resource?.url);
    if(href){const link=node('a',connection.resource.repository||href);link.href=href;link.target='_blank';link.rel='noreferrer';item.append(link);}
    if(connection.state==='cleanup_due')item.append(node('p','Removal has not been confirmed yet. We’ll retry it; you can also remove the app in your provider account.','help'));
    if(connection.provider==='figma'&&connection.state==='removed')item.append(node('p','The tokens held by Vibe Check have been deleted. You can also revoke the connected app in Figma’s account settings.','help'));
    if(connection.state!=='removed'){
      const disconnect=node('button',connection.state==='cleanup_due'?'Retry removal':`Disconnect ${title}`,'text-button');disconnect.type='button';
      disconnect.addEventListener('click',()=>busy(disconnect,async()=>{await api(`requests/${id}/disconnect/${encodeURIComponent(connection.id)}`,'POST',{});await loadConnections();}));item.append(disconnect);
    }
    $('connection-list').append(item);
  }
  const closed=['expired','declined'].includes(current.status);$('connect-options').hidden=closed;
  for(const provider of ['github','figma']){
    const existing=connections.some(item=>item.provider===provider&&item.state!=='removed');
    const available=provider==='github'?connectionConfiguration.github:connectionConfiguration.figma&&connectionConfiguration.figmaPublic;
    $(`connect-${provider}`).disabled=closed||existing||!available;$(`${provider}-url`).disabled=closed||existing||!available;
    $(`${provider}-help`).textContent=existing?'This request already has a connection. Disconnect it before choosing a different project.':!available?(provider==='github'?'GitHub authorization is being set up. Share a public repository link in your project details for now.':'Figma authorization is not available yet. Share a view-only file link in your project details for now.'):(provider==='github'?'On GitHub, choose “Only select repositories” and select just this repository. Vibe Check asks for read-only access.':'Figma asks for permission to read file content. Vibe Check opens only the file you share here.');
    if(!$(`${provider}-url`).value){const matching=current.links.find(href=>{try{const url=new URL(href);return provider==='github'?url.hostname==='github.com':['figma.com','www.figma.com'].includes(url.hostname);}catch{return false;}});if(matching)$(`${provider}-url`).value=matching;}
  }
  $('connections-status').textContent=connections.some(item=>item.state==='active')?'Your connected projects are listed below.':closed?'This request is closed.':'No project is connected yet. Shared links above are still saved with your request.';
  if(returnedProvider&&connections.some(item=>item.provider===returnedProvider&&item.state==='active')){notice(`${returnedProvider==='github'?'GitHub':'Figma'} access is connected. Your project details are saved.`);returnedProvider=null;}
}
async function loadConnections(){
  try{const result=await api(`requests/${id}/connections`);connectionConfiguration=result.configuration;showConnections(result.connections);}
  catch(error){$('connections-status').textContent=error.message;for(const provider of ['github','figma']){$(`connect-${provider}`).disabled=true;$(`${provider}-url`).disabled=true;$(`${provider}-help`).textContent='The connection status could not be loaded. You can still save project links above.';}}
}
async function saveBeforeConnecting(url){
  if(!['draft','submitted'].includes(current.status)||$('project-form').hidden)return;
  count();
  if(!$('problem').value.trim()){notice('Describe your project and the problem before connecting it, so I can save your request.',true);$('problem').focus();throw new Error('Add a project description before connecting.');}
  if(!$('problem').reportValidity())throw new Error('Keep the project description to 1,000 words or less.');
  const links=$('links').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
  if(!links.includes(url))links.push(url);
  current=await api(`requests/${id}`,'PUT',{description:$('problem').value,links,notes:$('notes').value,complete:false});
  $('links').value=current.links.join('\n');
}
for(const provider of ['github','figma'])$(`connect-${provider}-form`).addEventListener('submit',event=>{
  event.preventDefault();busy(event.submitter,async()=>{
    const url=$(`${provider}-url`).value.trim();await saveBeforeConnecting(url);
    const result=await api(`requests/${id}/connect/${provider}`,'POST',{url});
    let target;try{target=new URL(result.url);}catch{throw new Error('The authorization page is unavailable. Please try again.');}
    if(target.protocol!=='https:'||target.username||target.password||target.hostname!==(provider==='github'?'github.com':'www.figma.com'))throw new Error('The authorization page could not be verified.');
    location.assign(target.href);
  });
});
async function refresh(){if(id)await render(await api(`requests/${id}`));}
$('registration-form').addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,async()=>{const result=await api('register','POST',{name:$('name').value,email:$('email').value,website:$('website').value});id=result.id;access=result.token;savedRequest.set(id);const returnUrl=new URL(location.href);returnUrl.searchParams.set('request',id);const theme=returnUrl.searchParams.get('theme');if(theme){returnUrl.searchParams.delete('theme');returnUrl.searchParams.append('theme',theme);}returnUrl.hash=`access=${access}`;history.replaceState(history.state,'',returnUrl.href);await render(result.request);notice('Your registration is saved. Keep your private link, then add the project details.');$('problem').focus();});});
$('problem').addEventListener('input',count);$('complete').addEventListener('change',()=>{$('save-project').textContent=$('complete').checked?'Submit request for review':'Save project details';});
$('project-form').addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,async()=>{const row=await api(`requests/${id}`,'PUT',{description:$('problem').value,links:$('links').value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),notes:$('notes').value,complete:$('complete').checked});await render(row);notice(row.status==='submitted'?'Your request has been submitted for review.':'Your project details are saved.');});});
$('edit-project').addEventListener('click',()=>{$('project-form').hidden=false;$('submitted-details').hidden=true;$('save-project').textContent='Save changes';$('problem').focus();});$('refresh').addEventListener('click',()=>busy($('refresh'),refresh));
$('copy-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('private-link').value);notice('Private link copied.');}catch{$('private-link').select();notice('Select and copy the private link above.');}});
$('pay').addEventListener('click',()=>busy($('pay'),async()=>{const result=await api(`requests/${id}/checkout`,'POST',{});if(result.url)location.assign(result.url);else await refresh();}));
async function loadSlots(){const {slots}=await api(`requests/${id}/slots`);$('slots').replaceChildren();chosenSlot=null;$('book-slot').disabled=true;if(!slots.length){const p=document.createElement('p');p.textContent='There are no open times in the next seven days. Your deposit is recorded. Please check back here for availability.';$('slots').append(p);return;}for(const slot of slots){const b=document.createElement('button');b.type='button';b.textContent=time(slot.starts_at);b.setAttribute('aria-pressed','false');b.addEventListener('click',()=>{chosenSlot=slot.id;for(const btn of $('slots').querySelectorAll('button'))btn.setAttribute('aria-pressed',String(btn===b));$('book-slot').disabled=false;});$('slots').append(b);}}
$('book-slot').addEventListener('click',()=>busy($('book-slot'),async()=>{await render(await api(`requests/${id}/book`,'POST',{slotId:chosenSlot}));notice('Your appointment is booked. Your Zoom link is below.');}));
if(id){refresh().then(async()=>{if(new URLSearchParams(location.search).get('payment')==='returned')await render(await api(`requests/${id}/verify-payment`,'POST',{}));}).catch(error=>{if(!current){savedRequest.clear();$('registration-form').hidden=false;}notice(error.message,true);});}
