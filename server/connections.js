import * as github from './github.js';
import * as figma from './figma.js';
import {cleanupGitHubOrphans} from './github-orphans.js';
import {randomSecret,sha256,challenge,encrypt,decrypt} from './vault.js';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer',...headers}});
const redirect=(url,headers={})=>new Response(null,{status:303,headers:{Location:url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer',...headers}});
const getRequest=(env,id)=>env.DB.prepare('SELECT * FROM requests WHERE id=?').bind(id).first();
const active=row=>row&&!['expired','declined'].includes(row.status)&&(!row.expires_at||row.paid_at||row.expires_at>Date.now());
const closed=row=>row&&['expired','declined'].includes(row.status);
const cookie=(request,value)=>`vc_oauth=${value}; Path=/api/connect; HttpOnly; SameSite=Lax; Max-Age=900${new URL(request.url).protocol==='https:'?'; Secure':''}`;
const browserCookie=request=>request.headers.get('Cookie')?.split('; ').find(v=>v.startsWith('vc_oauth='))?.slice(9)||'';
const record=(env,id,event)=>env.DB.prepare('INSERT INTO audit(request_id,event,created_at) VALUES(?,?,?)').bind(id,event,Date.now()).run();
async function githubConfig(env){const row=await env.DB.prepare("SELECT encrypted_value FROM integration_config WHERE name='github'").first();return row?decrypt(env,row.encrypted_value,'github_config'):null;}
export async function connectionConfiguration(env){
  const gh=await githubConfig(env);
  return {github:Boolean(gh),githubAppUrl:gh?`https://github.com/apps/${gh.slug}`:null,figma:Boolean(env.FIGMA_CLIENT_ID&&env.FIGMA_CLIENT_SECRET&&env.INTEGRATION_ENCRYPTION_KEY),figmaPublic:env.FIGMA_PUBLIC_APPROVED==='true'};
}
async function issueState(env,request,provider,requestId,payload){
  const state=randomSecret(),browser=randomSecret();
  await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO oauth_states(state_hash,browser_hash,provider,request_id,encrypted_payload,expires_at) VALUES(?,?,?,?,?,?)').bind(await sha256(state),await sha256(browser),provider,requestId,await encrypt(env,payload,'oauth_state'),Date.now()+900000).run();
  return {state,headers:{'Set-Cookie':cookie(request,browser)}};
}
async function consumeState(env,request,provider){
  const state=new URL(request.url).searchParams.get('state')||'',browser=browserCookie(request);
  if(!/^[a-f0-9]{64}$/.test(state)||!/^[a-f0-9]{64}$/.test(browser))fail(400,'This connection has expired. Return to your request and start again.');
  const row=await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=? AND browser_hash=? AND provider=? AND expires_at>? RETURNING *').bind(await sha256(state),await sha256(browser),provider,Date.now()).first();
  if(!row)fail(400,'This connection has expired or was already used. Start again from your request.');
  return {...row,payload:await decrypt(env,row.encrypted_payload,'oauth_state')};
}
function resourceFor(provider,value){
  let url;try{url=new URL(value);}catch{fail(400,'Enter the full project URL before connecting.');}
  if(url.protocol!=='https:'||url.username||url.password)fail(400,'Use an https:// project link without credentials.');
  if(provider==='github'){
    const match=url.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    if(url.hostname!=='github.com'||!match)fail(400,'Use the GitHub repository URL, such as https://github.com/owner/project.');
    return {repository:`${match[1]}/${match[2]}`,url:`https://github.com/${match[1]}/${match[2]}`};
  }
  const match=url.pathname.match(/^\/(?:design|file|board|proto)\/([A-Za-z0-9]+)(?:\/|$)/);
  if(!['figma.com','www.figma.com'].includes(url.hostname)||!match)fail(400,'Use a Figma design or FigJam file URL. For Figma Make, share the published app link instead.');
  return {fileKey:match[1],url:url.href};
}
async function storeConnection(env,row,provider,externalId,resource,credentials){
  const id=crypto.randomUUID();
  const encrypted=credentials?await encrypt(env,credentials,'connection:'+id):'';
  try{
    const result=await env.DB.prepare("INSERT INTO connections(id,request_id,provider,external_id,resource,encrypted_credentials,created_at) SELECT ?,id,?,?,?,?,? FROM requests WHERE id=? AND status NOT IN ('expired','declined') AND (expires_at IS NULL OR paid_at IS NOT NULL OR expires_at>?) AND (?!='github' OR NOT EXISTS (SELECT 1 FROM github_installation_cleanup WHERE installation_id=?))").bind(id,provider,String(externalId),JSON.stringify(resource),encrypted,Date.now(),row.id,Date.now(),provider,String(externalId)).run();
    if(!result.meta.changes)fail(409,'The request or installation closed during authorization. No connection was retained. Start a new connection if your request is still open.');
  }
  catch(error){if(/UNIQUE constraint/.test(String(error.message)))fail(409,'This account is already connected to a request. Disconnect it there before connecting another request.');throw error;}
  await record(env,row.id,provider+'_connected');
  return id;
}
async function queueVerifiedGitHub(env,row,installationId,resource){
  const id=crypto.randomUUID();
  try{
    const result=await env.DB.prepare("INSERT INTO connections(id,request_id,provider,external_id,resource,state,created_at) SELECT ?,?,'github',?,?,'cleanup_due',? WHERE NOT EXISTS (SELECT 1 FROM github_installation_cleanup WHERE installation_id=?)").bind(id,row.id,String(installationId),JSON.stringify(resource),Date.now(),String(installationId)).run();
    if(!result.meta.changes)return;
  }catch(error){if(/UNIQUE constraint/.test(String(error.message)))return;throw error;}
  await removeConnection(env,await env.DB.prepare('SELECT * FROM connections WHERE id=?').bind(id).first());
}
export async function removeConnection(env,connection){
  if(connection.state==='removed')return;
  await env.DB.prepare("UPDATE connections SET state='cleanup_due' WHERE id=? AND state!='removed'").bind(connection.id).run();
  try{
    if(connection.provider==='github'){
      const config=await githubConfig(env);if(!config)throw new Error('GitHub App configuration is missing.');
      await github.deleteInstallation(env,config,connection.external_id);
    }
    // Figma has no documented app-side OAuth revocation endpoint. Destroy both
    // tokens, so this service cannot refresh or read the connected file again.
    await env.DB.prepare("UPDATE connections SET state='removed',encrypted_credentials='',resource='{}',external_id='',removed_at=?,last_error=NULL,refresh_lock=NULL,refresh_lock_until=NULL WHERE id=?").bind(Date.now(),connection.id).run();
    await record(env,connection.request_id,connection.provider+'_access_removed');
  }catch{
    await env.DB.prepare("UPDATE connections SET last_error='Automatic removal could not be verified. Retry cleanup or remove the app in the provider account.' WHERE id=?").bind(connection.id).run();
  }
}
export async function removeRequestConnections(env,requestId){
  const rows=(await env.DB.prepare("SELECT * FROM connections WHERE request_id=? AND state!='removed'").bind(requestId).all()).results;
  for(const row of rows)await removeConnection(env,row);
}
export async function retryConnectionCleanup(env){
  const rows=(await env.DB.prepare("SELECT * FROM connections WHERE state='cleanup_due' LIMIT 100").all()).results;
  for(const row of rows)await removeConnection(env,row);
  await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(Date.now()).run();
}
export async function sweepAbandonedGitHubInstallations(env){
  const config=await githubConfig(env);
  return config?cleanupGitHubOrphans(env,config):{configured:false};
}
async function safeConnections(env,id){
  const rows=(await env.DB.prepare('SELECT id,provider,resource,state,created_at,removed_at,last_error FROM connections WHERE request_id=? ORDER BY created_at').bind(id).all()).results;
  return rows.map(row=>({...row,resource:JSON.parse(row.resource)}));
}
async function figmaCredentials(env,connection){
  let value=await decrypt(env,connection.encrypted_credentials,'connection:'+connection.id);
  if(value.expiresAt>Date.now()+60000)return value;
  const lock=randomSecret();
  const result=await env.DB.prepare("UPDATE connections SET refresh_lock=?,refresh_lock_until=? WHERE id=? AND state='active' AND (refresh_lock_until IS NULL OR refresh_lock_until<?)").bind(lock,Date.now()+60000,connection.id,Date.now()).run();
  if(!result.meta.changes)fail(409,'The Figma connection is refreshing. Try again in a moment.');
  try{
    const fresh=await env.DB.prepare('SELECT * FROM connections WHERE id=?').bind(connection.id).first();
    value=await decrypt(env,fresh.encrypted_credentials,'connection:'+connection.id);
    if(value.expiresAt<=Date.now()+60000){const token=await figma.refreshToken(env,value.refresh_token);value={...value,...token,expiresAt:Date.now()+token.expires_in*1000};}
    const saved=await env.DB.prepare("UPDATE connections SET encrypted_credentials=? WHERE id=? AND state='active' AND refresh_lock=?").bind(await encrypt(env,value,'connection:'+connection.id),connection.id,lock).run();
    if(!saved.meta.changes)fail(403,'Access to this project has ended.');
    return value;
  }finally{await env.DB.prepare('UPDATE connections SET refresh_lock=NULL,refresh_lock_until=NULL WHERE id=? AND refresh_lock=?').bind(connection.id,lock).run();}
}
export async function handleConnections(request,env,path,method,helpers){
  const url=new URL(request.url),origin=url.origin;
  if(path[0]==='admin'&&path[1]==='integrations'){
    await helpers.administrator(request,env);
    if(method==='GET')return json(await connectionConfiguration(env));
    if(method==='POST'&&path[2]==='github'){
      const data=await helpers.body(request),owner=String(data.owner||'');
      if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner))fail(400,'Enter the GitHub account or organization that will own the app.');
      if(await githubConfig(env))fail(409,'A GitHub App is already configured.');
      const flow=await issueState(env,request,'github_manifest',null,{owner});
      return json({action:data.organization?`https://github.com/organizations/${owner}/settings/apps/new`:'https://github.com/settings/apps/new',state:flow.state,manifest:github.manifest({origin,owner,name:'Vibe Check Rodeo'})},200,flow.headers);
    }
  }
  if(path[0]==='connect'&&path[1]==='github'&&path[2]==='manifest'&&method==='GET'){
    const flow=await consumeState(env,request,'github_manifest');
    if(await githubConfig(env))fail(409,'The GitHub App is already configured.');
    const app=await github.appFromManifest(env,url.searchParams.get('code'));
    if(app.owner?.login?.toLowerCase()!==flow.payload.owner.toLowerCase())fail(400,'The app owner did not match the requested GitHub account.');
    if(Object.entries(app.permissions||{}).some(([permission,level])=>!['contents','metadata'].includes(permission)||level!=='read'))fail(400,'The app must request only read access to contents and metadata.');
    const config={appId:app.appId,clientId:app.clientId,clientSecret:app.clientSecret,privateKey:app.privateKey,slug:app.slug};
    await env.DB.prepare('INSERT INTO integration_config(name,encrypted_value,updated_at) VALUES(?,?,?)').bind('github',await encrypt(env,config,'github_config'),Date.now()).run();
    return redirect('/admin?connected=github');
  }
  if(path[0]==='requests'&&path[1]&&['connections','connect','disconnect'].includes(path[2])){
    let row=await helpers.authenticate(request,env,path[1]);
    if(!active(row)&&!closed(row)){await helpers.expireUnpaid(env);row=await getRequest(env,row.id);}
    if(closed(row))await removeRequestConnections(env,row.id);
    if(method==='GET'&&path[2]==='connections')return json({configuration:await connectionConfiguration(env),connections:await safeConnections(env,row.id)});
    if(method==='POST'&&path[2]==='disconnect'){
      const connection=await env.DB.prepare('SELECT * FROM connections WHERE id=? AND request_id=?').bind(path[3]||'',row.id).first();
      if(!connection)fail(404,'Connection not found.');await removeConnection(env,connection);return json({connections:await safeConnections(env,row.id)});
    }
    if(method==='POST'&&path[2]==='connect'&&['github','figma'].includes(path[3])){
      if(!active(row))fail(409,'This request is closed.');
      const provider=path[3],data=await helpers.body(request),resource=resourceFor(provider,data.url);
      if(await env.DB.prepare("SELECT id FROM connections WHERE request_id=? AND provider=? AND state!='removed'").bind(row.id,provider).first())fail(409,'Disconnect the existing connection before connecting another.');
      const verifier=randomSecret();
      if(provider==='github'){
        const config=await githubConfig(env);if(!config)fail(503,'GitHub authorization is not connected yet. You can still share a public project link.');
        const flow=await issueState(env,request,'github_install',row.id,{resource,verifier});
        return json({url:`https://github.com/apps/${config.slug}/installations/new?state=${flow.state}`},200,flow.headers);
      }
      if(env.FIGMA_PUBLIC_APPROVED!=='true')fail(503,'Figma authorization is waiting for app approval. Share a view-only file link for now.');
      const flow=await issueState(env,request,'figma',row.id,{resource,verifier});
      return json({url:figma.authorizationUrl(env,{redirectUri:origin+'/api/connect/figma/callback',state:flow.state,challenge:await challenge(verifier)})},200,flow.headers);
    }
  }
  if(path[0]==='connect'&&path[1]==='github'&&path[2]==='installed'&&method==='GET'){
    const flow=await consumeState(env,request,'github_install'),row=await getRequest(env,flow.request_id);
    if(!active(row))fail(409,'This request is closed.');
    const installationId=url.searchParams.get('installation_id');
    if(!/^\d+$/.test(installationId||''))fail(400,'GitHub did not return an installation. Start again from your request.');
    const next=await issueState(env,request,'github',row.id,{...flow.payload,installationId});
    return redirect(github.authorizationUrl(await githubConfig(env),{origin,state:next.state,challenge:await challenge(flow.payload.verifier)}),next.headers);
  }
  if(path[0]==='connect'&&['github','figma'].includes(path[1])&&path[2]==='callback'&&method==='GET'){
    const provider=path[1],flow=await consumeState(env,request,provider),row=await getRequest(env,flow.request_id);
    if(!active(row))fail(409,'This request is closed.');
    const code=url.searchParams.get('code');if(!code)fail(400,'Authorization was not completed. Return to your request to try again.');
    if(provider==='github'){
      const config=await githubConfig(env),token=await github.exchangeCode(env,config,{origin,code,verifier:flow.payload.verifier});
      let verifiedInstallationId;
      try{
        const result=await github.validateInstallation(env,config,{installationId:flow.payload.installationId,userToken:token.accessToken,repository:flow.payload.resource.repository});
        verifiedInstallationId=result.installationId;
        await storeConnection(env,row,provider,result.installationId,flow.payload.resource,null);
      }catch(error){
        verifiedInstallationId=verifiedInstallationId||error.verifiedInstallationId;
        if(verifiedInstallationId)await queueVerifiedGitHub(env,row,verifiedInstallationId,flow.payload.resource);
        throw error;
      }
    }else{
      const token=await figma.exchangeCode(env,{code,redirectUri:origin+'/api/connect/figma/callback',verifier:flow.payload.verifier});
      await figma.readFile(env,token.access_token,flow.payload.resource.fileKey);
      await storeConnection(env,row,provider,token.user_id_string,flow.payload.resource,{...token,expiresAt:Date.now()+token.expires_in*1000});
    }
    return redirect(`/?request=${row.id}&connected=${provider}#request`);
  }
  if(path[0]==='admin'&&path[1]==='connections'){
    await helpers.administrator(request,env);
    if(method==='GET'&&!path[2]){
      const rows=(await env.DB.prepare('SELECT id,request_id,provider,resource,state,last_error FROM connections ORDER BY created_at DESC LIMIT 200').all()).results;
      return json({connections:rows.map(row=>({...row,resource:JSON.parse(row.resource)}))});
    }
    const connection=await env.DB.prepare('SELECT * FROM connections WHERE id=?').bind(path[2]||'').first();
    if(!connection)fail(404,'Connection not found.');
    if(method==='POST'&&path[3]==='remove'){await removeConnection(env,connection);return json({removed:(await env.DB.prepare('SELECT state FROM connections WHERE id=?').bind(connection.id).first()).state==='removed'});}
    if(method==='GET'&&path[3]==='read'){
      let row=await getRequest(env,connection.request_id);
      if(!active(row)&&!closed(row)){await helpers.expireUnpaid(env);row=await getRequest(env,row.id);}
      if(!active(row)||connection.state!=='active'){if(closed(row))await removeRequestConnections(env,row.id);fail(403,'Access to this project has ended.');}
      const resource=JSON.parse(connection.resource);
      const result=connection.provider==='github'?await github.readRepository(env,await githubConfig(env),connection.external_id,resource.repository,url.searchParams.get('path')||''):await figma.readFile(env,(await figmaCredentials(env,connection)).access_token,resource.fileKey);
      const latest=await env.DB.prepare('SELECT state FROM connections WHERE id=?').bind(connection.id).first();
      if(!active(await getRequest(env,row.id))||latest?.state!=='active')fail(403,'Access to this project has ended.');
      return json(result);
    }
  }
  return null;
}
