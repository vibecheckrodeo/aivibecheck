import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {generateKeyPairSync,createHash,verify} from 'node:crypto';
import {handle,expireUnpaid} from '../server/api.js';
import {encrypt,decrypt} from '../server/vault.js';

function fixture(){
  const sql=new DatabaseSync(':memory:');
  for(const file of readdirSync('migrations').filter(v=>v.endsWith('.sql')).sort())sql.exec(readFileSync('migrations/'+file,'utf8'));
  const statement=(query,args=[])=>({bind(...values){return statement(query,values);},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return {meta:{changes:Number(sql.prepare(query).run(...args).changes)}};}});
  const env={DB:{prepare:statement},ADMIN_TOKEN:'admin-test',INTEGRATION_ENCRYPTION_KEY:'1'.repeat(64),FIGMA_CLIENT_ID:'figma-client',FIGMA_CLIENT_SECRET:['figma', 'secret', 'fixture'].join('-'),FIGMA_PUBLIC_APPROVED:'true'};
  const call=async(path,method='GET',data,token,cookie)=>{
    const response=await handle(new Request('https://vibecheck.test/api/'+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{})},body:data?JSON.stringify(data):undefined}),env);
    return {status:response.status,data:response.status===303?null:await response.json(),headers:response.headers};
  };
  const register=async()=>{const result=await call('register','POST',{name:'Connection QA',email:'connection@example.com'});assert.equal(result.status,201);return result.data;};
  const start=async user=>{const r=await call('requests/'+user.id+'/connect/figma','POST',{url:'https://www.figma.com/design/Abc123/Test'},user.token);assert.equal(r.status,200);return {state:new URL(r.data.url).searchParams.get('state'),cookie:r.headers.get('Set-Cookie').split(';')[0],url:r.data.url};};
  const provider=()=>{env.FETCH=async(url,options)=>url.endsWith('/oauth/token')?Response.json({access_token:'access-fixture',refresh_token:'refresh-fixture',token_type:'bearer',expires_in:3600,user_id_string:'9007199254740999'}):Response.json({name:'Shared file',document:{id:'0:0',type:'DOCUMENT'}});};
  const connect=async user=>{provider();const flow=await start(user);const result=await call('connect/figma/callback?code=fixture-code&state='+flow.state,'GET',null,null,flow.cookie);assert.equal(result.status,303);return sql.prepare('SELECT * FROM connections WHERE request_id=?').get(user.id);};
  return {sql,env,call,register,start,provider,connect};
}

test('vault binds encrypted credentials to their purpose and key',async()=>{
  const env={INTEGRATION_ENCRYPTION_KEY:'2'.repeat(64)},secret={access_token:'private-fixture'};
  const sealed=await encrypt(env,secret,'connection:first');assert.ok(!sealed.includes(secret.access_token));
  assert.deepEqual(await decrypt(env,sealed,'connection:first'),secret);
  await assert.rejects(decrypt(env,sealed,'connection:another'));
  await assert.rejects(decrypt({INTEGRATION_ENCRYPTION_KEY:'3'.repeat(64)},sealed,'connection:first'));
});
test('connection configuration requires admin authentication and never returns credentials',async()=>{
  const t=fixture();assert.equal((await t.call('admin/integrations')).status,401);
  const result=await t.call('admin/integrations','GET',null,'admin-test');assert.equal(result.status,200);
  assert.deepEqual(result.data,{github:false,githubAppUrl:null,figma:true,figmaPublic:true});
  const user=await t.register();assert.equal((await t.call('requests/'+user.id+'/connections')).status,401);
});
test('Figma authorization binds a single-use state to the originating browser and uses PKCE',async()=>{
  const t=fixture(),user=await t.register();let exchanges=0;
  t.provider();const transport=t.env.FETCH;t.env.FETCH=async(...args)=>{exchanges++;return transport(...args);};
  const flow=await t.start(user);assert.equal(new URL(flow.url).searchParams.get('code_challenge').length,43);
  const path='connect/figma/callback?code=fixture-code&state='+flow.state;
  assert.equal((await t.call(path)).status,400);assert.equal(exchanges,0);
  const connected=await t.call(path,'GET',null,null,flow.cookie);assert.equal(connected.status,303);
  assert.equal(connected.headers.get('Location'),'/?request='+user.id+'&connected=figma#request');
  assert.equal((await t.call(path,'GET',null,null,flow.cookie)).status,400);
  const row=t.sql.prepare('SELECT * FROM connections').get();assert.ok(!row.encrypted_credentials.includes('access-fixture'));
  const visible=await t.call('requests/'+user.id+'/connections','GET',null,user.token);
  assert.equal(visible.data.connections[0].encrypted_credentials,undefined);assert.equal(visible.data.connections[0].resource.fileKey,'Abc123');
});
test('closed or unapproved provider connections fail without provider calls',async()=>{
  const t=fixture(),user=await t.register();t.env.FIGMA_PUBLIC_APPROVED='false';
  assert.equal((await t.call('requests/'+user.id+'/connect/figma','POST',{url:'https://figma.com/design/Abc123/Test'},user.token)).status,503);
  assert.equal((await t.call('requests/'+user.id+'/connect/github','POST',{url:'https://github.com/example/project'},user.token)).status,503);
  t.sql.prepare("UPDATE requests SET status='expired'").run();t.env.FIGMA_PUBLIC_APPROVED='true';
  assert.equal((await t.call('requests/'+user.id+'/connect/figma','POST',{url:'https://figma.com/design/Abc123/Test'},user.token)).status,409);
});
test('one Figma account cannot be rebound to a different request',async()=>{
  const t=fixture(),first=await t.register(),second=await t.register();await t.connect(first);
  const flow=await t.start(second);const result=await t.call('connect/figma/callback?code=fixture&state='+flow.state,'GET',null,null,flow.cookie);
  assert.equal(result.status,409);assert.equal(t.sql.prepare('SELECT count(*) AS n FROM connections').get().n,1);
});
test('deadline cleanup destroys Figma access and refresh tokens and blocks subsequent reads',async()=>{
  const t=fixture(),user=await t.register(),connection=await t.connect(user);
  t.sql.prepare("UPDATE requests SET status='submitted',completed_at=?,expires_at=? WHERE id=?").run(Date.now()-8*86400000,Date.now()-1,user.id);
  assert.equal((await expireUnpaid(t.env)).expired,1);
  const removed=t.sql.prepare('SELECT * FROM connections').get();assert.equal(removed.state,'removed');assert.equal(removed.encrypted_credentials,'');assert.equal(removed.resource,'{}');
  assert.equal((await t.call('admin/connections/'+connection.id+'/read','GET',null,'admin-test')).status,403);
});
test('disconnect is owner-only and removes stored credentials',async()=>{
  const t=fixture(),user=await t.register(),other=await t.register(),connection=await t.connect(user);
  assert.equal((await t.call('requests/'+other.id+'/disconnect/'+connection.id,'POST',{},other.token)).status,404);
  assert.equal((await t.call('requests/'+user.id+'/disconnect/'+connection.id,'POST',{},user.token)).status,200);
  assert.equal(t.sql.prepare('SELECT encrypted_credentials FROM connections').get().encrypted_credentials,'');
});
test('Figma file reads refresh expired credentials once and retain the replacement securely',async()=>{
  const t=fixture(),user=await t.register(),connection=await t.connect(user);
  const credentials=await decrypt(t.env,connection.encrypted_credentials,'connection:'+connection.id);credentials.expiresAt=1;
  t.sql.prepare('UPDATE connections SET encrypted_credentials=? WHERE id=?').run(await encrypt(t.env,credentials,'connection:'+connection.id),connection.id);
  let refreshes=0;t.env.FETCH=async(url,options)=>{
    if(url.endsWith('/oauth/token')){refreshes++;assert.equal(new URLSearchParams(options.body).get('grant_type'),'refresh_token');return Response.json({access_token:'replacement-access',refresh_token:'replacement-refresh',token_type:'bearer',expires_in:3600});}
    assert.equal(options.headers.Authorization,'Bearer replacement-access');return Response.json({name:'Shared file',document:{type:'DOCUMENT'}});
  };
  for(let i=0;i<2;i++)assert.equal((await t.call('admin/connections/'+connection.id+'/read','GET',null,'admin-test')).status,200);
  assert.equal(refreshes,1);assert.equal(t.sql.prepare('SELECT refresh_lock FROM connections').get().refresh_lock,null);
});

// Runtime keys ensure these tests never depend on committed signing credentials.
const githubKeys=generateKeyPairSync('rsa',{modulusLength:2048});
const githubConfig={appId:42,clientId:'Iv1.route-fixture',clientSecret:'github-client-secret-fixture',privateKey:githubKeys.privateKey.export({type:'pkcs1',format:'pem'}),slug:'vibecheck-test',owner:{id:100,login:'vibecheckrodeo',type:'Organization'},permissions:{contents:'read',metadata:'read'}};
const cookieValue=result=>result.headers.get('Set-Cookie').split(';')[0];
async function configureGitHub(t){
  t.sql.prepare('INSERT INTO integration_config(name,encrypted_value,updated_at) VALUES(?,?,?)').run('github',await encrypt(t.env,githubConfig,'github_config'),Date.now());
}
function githubProvider(t,options={}){
  const calls=[],repository=options.repository||'person/project',installationId=options.installationId||7,accountId=options.accountId||10;
  const fullRepo={id:300,full_name:repository},permissions={metadata:'read',contents:'read'};
  let deletions=0;
  t.env.FETCH=async(raw,init)=>{
    const url=new URL(raw),body=init.body?JSON.parse(init.body):undefined;
    calls.push({url:raw,method:init.method,headers:init.headers,body});
    assert.equal(init.redirect,'manual');
    if(url.origin==='https://github.com'&&url.pathname==='/login/oauth/access_token'){
      assert.equal(init.method,'POST');assert.equal(body.client_secret,githubConfig.clientSecret);
      assert.equal(body.redirect_uri,'https://vibecheck.test/api/connect/github/callback');
      if(options.verifier)assert.equal(body.code_verifier,options.verifier);
      return Response.json({access_token:'github-user-fixture',token_type:'bearer',expires_in:28800});
    }
    assert.equal(url.origin,'https://api.github.com');
    if(url.pathname.startsWith('/app')){
      const jwt=init.headers.Authorization.slice(7),[header,payload,signature]=jwt.split('.');
      assert.equal(verify('RSA-SHA256',Buffer.from(header+'.'+payload),githubKeys.publicKey,Buffer.from(signature,'base64url')),true);
      assert.equal(JSON.parse(Buffer.from(payload,'base64url')).iss,githubConfig.clientId);
    }
    if(url.pathname===`/user/installations/${installationId}/repositories`){
      assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer github-user-fixture');
      return Response.json({total_count:1,repositories:[fullRepo]});
    }
    if(url.pathname===`/app/installations/${installationId}`&&init.method==='GET')return Response.json({id:installationId,app_id:42,repository_selection:options.selection||'selected',permissions,account:{id:accountId,login:repository.split('/')[0],type:'User'},suspended_at:null});
    if(url.pathname==='/user'){
      assert.equal(init.headers.Authorization,'Bearer github-user-fixture');
      return Response.json({id:accountId,login:repository.split('/')[0]});
    }
    if(url.pathname===`/app/installations/${installationId}/access_tokens`){
      assert.equal(init.method,'POST');
      const expectedPermissions=body.repositories?{contents:'read',metadata:'read'}:{metadata:'read'};
      assert.deepEqual(body,body.repositories?{permissions:expectedPermissions,repositories:[repository.split('/')[1]]}:{permissions:expectedPermissions});
      return Response.json({token:'github-installation-fixture',permissions:expectedPermissions},{status:201});
    }
    if(url.pathname==='/installation/repositories'){
      assert.equal(init.headers.Authorization,'Bearer ' + 'github-installation-fixture');
      if(options.beforeRepositoryResult)await options.beforeRepositoryResult();
      const actual=options.actualRepositories||[fullRepo];
      return Response.json({total_count:actual.length,repositories:actual});
    }
    if(url.pathname===`/app/installations/${installationId}`&&init.method==='DELETE'){
      deletions++;
      if(options.deleteFailure)throw new Error('Provider network fixture failed');
      return new Response(null,{status:204});
    }
    if(url.pathname===`/repos/${repository}/contents`){
      assert.equal(init.headers.Authorization,'Bearer ' + 'github-installation-fixture');
      if(options.beforeContentsResult)await options.beforeContentsResult();
      return Response.json({type:'file',encoding:'base64',content:'cHJpdmF0ZSBwcm9qZWN0'});
    }
    assert.fail('Unexpected mocked GitHub endpoint '+url.pathname);
  };
  return {calls,get deletions(){return deletions;}};
}
async function startGitHub(t,user,repository='person/project',installationId=7){
  const initial=await t.call('requests/'+user.id+'/connect/github','POST',{url:'https://github.com/'+repository},user.token);
  assert.equal(initial.status,200);
  const install=new URL(initial.data.url),installState=install.searchParams.get('state'),installCookie=cookieValue(initial);
  const installedPath='connect/github/installed?installation_id='+installationId+'&state='+installState;
  const installed=await t.call(installedPath,'GET',null,null,installCookie);assert.equal(installed.status,303);
  const oauth=new URL(installed.headers.get('Location')),state=oauth.searchParams.get('state');
  const stateRow=t.sql.prepare("SELECT encrypted_payload FROM oauth_states WHERE provider='github' AND request_id=? AND state_hash=?").get(user.id,createHash('sha256').update(state).digest('hex'));
  const payload=await decrypt(t.env,stateRow.encrypted_payload,'oauth_state');
  assert.equal(oauth.searchParams.get('code_challenge_method'),'S256');
  assert.equal(oauth.searchParams.get('code_challenge'),createHash('sha256').update(payload.verifier).digest('base64url'));
  assert.equal(oauth.searchParams.has('client_secret'),false);
  return {callback:'connect/github/callback?code=oauth-fixture&state='+state,cookie:cookieValue(installed),state,verifier:payload.verifier,installedPath,installCookie,initial};
}
async function connectGitHub(t,user,options={}){
  const flow=await startGitHub(t,user,options.repository,options.installationId);
  const provider=githubProvider(t,{...options,verifier:flow.verifier});
  const result=await t.call(flow.callback,'GET',null,null,flow.cookie);
  assert.equal(result.status,303);
  return {connection:t.sql.prepare('SELECT * FROM connections WHERE request_id=?').get(user.id),provider,flow};
}

test('GitHub manifest routes require admin-created browser state and encrypt normalized owner-checked configuration',async()=>{
  const t=fixture();
  assert.equal((await t.call('admin/integrations/github','POST',{owner:'vibecheckrodeo',organization:true})).status,401);
  const start=await t.call('admin/integrations/github','POST',{owner:'vibecheckrodeo',organization:true},'admin-test');
  assert.equal(start.status,200);assert.equal(start.data.action,'https://github.com/organizations/vibecheckrodeo/settings/apps/new');
  assert.deepEqual(start.data.manifest.default_permissions,{contents:'read',metadata:'read'});
  assert.equal(start.data.manifest.hook_attributes.active,false);
  assert.match(start.headers.get('Set-Cookie'),/HttpOnly; SameSite=Lax; Max-Age=900; Secure/);
  let conversions=0;t.env.FETCH=async(url,init)=>{
    conversions++;assert.equal(url,'https://api.github.com/app-manifests/manifest-fixture/conversions');assert.equal(init.method,'POST');
    return Response.json({id:githubConfig.appId,client_id:githubConfig.clientId,client_secret:githubConfig.clientSecret,pem:githubConfig.privateKey,slug:githubConfig.slug,owner:githubConfig.owner,permissions:githubConfig.permissions},{status:201});
  };
  const callback='connect/github/manifest?code=manifest-fixture&state='+start.data.state;
  assert.equal((await t.call(callback)).status,400);assert.equal(conversions,0);
  const result=await t.call(callback,'GET',null,null,cookieValue(start));assert.equal(result.status,303);assert.equal(result.headers.get('Location'),'/admin?connected=github');
  assert.equal((await t.call(callback,'GET',null,null,cookieValue(start))).status,400);assert.equal(conversions,1);
  const stored=t.sql.prepare("SELECT encrypted_value FROM integration_config WHERE name='github'").get().encrypted_value;
  assert.ok(!stored.includes(githubConfig.clientSecret));assert.ok(!stored.includes('PRIVATE KEY'));
  const decoded=await decrypt(t.env,stored,'github_config');
  for(const key of ['appId','clientId','clientSecret','privateKey','slug'])assert.equal(decoded[key],githubConfig[key]);
  const publicStatus=await t.call('admin/integrations','GET',null,'admin-test');
  assert.equal(publicStatus.data.github,true);assert.equal(publicStatus.data.githubAppUrl,'https://github.com/apps/vibecheck-test');
  assert.ok(!JSON.stringify(publicStatus.data).includes(githubConfig.clientSecret));assert.equal(publicStatus.data.privateKey,undefined);
});

test('GitHub manifest rejects a different app owner and leaves no persisted credentials',async()=>{
  const t=fixture(),start=await t.call('admin/integrations/github','POST',{owner:'vibecheckrodeo',organization:true},'admin-test');
  t.env.FETCH=async()=>Response.json({id:42,client_id:githubConfig.clientId,client_secret:githubConfig.clientSecret,pem:githubConfig.privateKey,slug:githubConfig.slug,owner:{...githubConfig.owner,login:'somebodyelse'},permissions:githubConfig.permissions},{status:201});
  const result=await t.call('connect/github/manifest?code=manifest-fixture&state='+start.data.state,'GET',null,null,cookieValue(start));
  assert.equal(result.status,400);assert.equal(t.sql.prepare('SELECT count(*) AS n FROM integration_config').get().n,0);
});

test('GitHub install and OAuth states are browser-bound and single-use and bind token.accessToken to the request',async()=>{
  const t=fixture(),user=await t.register();await configureGitHub(t);
  const flow=await startGitHub(t,user),provider=githubProvider(t,{verifier:flow.verifier});
  assert.equal((await t.call(flow.installedPath,'GET',null,null,flow.installCookie)).status,400);
  assert.equal((await t.call(flow.callback)).status,400);assert.equal(provider.calls.length,0);
  const result=await t.call(flow.callback,'GET',null,null,flow.cookie);assert.equal(result.status,303);
  assert.equal(result.headers.get('Location'),'/?request='+user.id+'&connected=github#request');
  const count=provider.calls.length;assert.equal((await t.call(flow.callback,'GET',null,null,flow.cookie)).status,400);assert.equal(provider.calls.length,count);
  const row=t.sql.prepare('SELECT * FROM connections').get();assert.equal(row.request_id,user.id);assert.equal(row.external_id,'7');assert.equal(row.encrypted_credentials,'');
  assert.deepEqual(JSON.parse(row.resource),{repository:'person/project',url:'https://github.com/person/project'});
  const visible=await t.call('requests/'+user.id+'/connections','GET',null,user.token);
  assert.equal(visible.data.connections[0].external_id,undefined);assert.equal(visible.data.connections[0].encrypted_credentials,undefined);
  const serialized=JSON.stringify(visible.data);for(const secret of ['github-user-fixture','github-installation-fixture',githubConfig.clientSecret,'PRIVATE KEY'])assert.ok(!serialized.includes(secret));
});

test('unpaid deadline removes a connected GitHub installation through a verified DELETE 204',async()=>{
  const t=fixture(),user=await t.register();await configureGitHub(t);const {connection,provider}=await connectGitHub(t,user);
  t.sql.prepare("UPDATE requests SET status='submitted',completed_at=?,expires_at=? WHERE id=?").run(Date.now()-8*86400000,Date.now()-1,user.id);
  assert.equal((await expireUnpaid(t.env)).expired,1);assert.equal(provider.deletions,1);
  const row=t.sql.prepare('SELECT * FROM connections WHERE id=?').get(connection.id);assert.equal(row.state,'removed');assert.equal(row.resource,'{}');assert.equal(row.external_id,'');assert.ok(row.removed_at);
  assert.equal((await t.call('admin/connections/'+connection.id+'/read','GET',null,'admin-test')).status,403);
});

test('failed GitHub removal remains cleanup_due and scheduled retry verifies removal',async()=>{
  const t=fixture(),user=await t.register();await configureGitHub(t);const {connection}=await connectGitHub(t,user);
  t.sql.prepare("UPDATE requests SET status='submitted',completed_at=?,expires_at=? WHERE id=?").run(Date.now()-8*86400000,Date.now()-1,user.id);
  const unavailable=githubProvider(t,{deleteFailure:true});await expireUnpaid(t.env);
  let row=t.sql.prepare('SELECT * FROM connections WHERE id=?').get(connection.id);assert.equal(row.state,'cleanup_due');assert.equal(row.external_id,'7');assert.equal(row.removed_at,null);assert.ok(unavailable.deletions>=1);
  const recovered=githubProvider(t);await expireUnpaid(t.env);row=t.sql.prepare('SELECT * FROM connections WHERE id=?').get(connection.id);
  assert.equal(row.state,'removed');assert.equal(recovered.deletions,1);assert.equal(row.last_error,null);
});

test('a verified new installation with excessive scope is uninstalled and never becomes an active connection',async()=>{
  const t=fixture(),user=await t.register();await configureGitHub(t);const flow=await startGitHub(t,user);
  const provider=githubProvider(t,{selection:'all',verifier:flow.verifier});
  const result=await t.call(flow.callback,'GET',null,null,flow.cookie);assert.equal(result.status,409);assert.equal(provider.deletions,1);
  const row=t.sql.prepare('SELECT * FROM connections').get();assert.equal(row.state,'removed');assert.equal(row.external_id,'');
});

test('failed scope validation on an installation already bound to another request never uninstalls it',async()=>{
  const t=fixture(),first=await t.register(),second=await t.register();await configureGitHub(t);const {connection}=await connectGitHub(t,first);
  const flow=await startGitHub(t,second),provider=githubProvider(t,{selection:'all',verifier:flow.verifier});
  const result=await t.call(flow.callback,'GET',null,null,flow.cookie);assert.equal(result.status,409);assert.equal(provider.deletions,0);
  assert.equal(t.sql.prepare('SELECT state FROM connections WHERE id=?').get(connection.id).state,'active');assert.equal(t.sql.prepare('SELECT count(*) AS n FROM connections').get().n,1);
});

test('successful provider verification cannot reassign an existing installation to another request',async()=>{
  const t=fixture(),first=await t.register(),second=await t.register();await configureGitHub(t);await connectGitHub(t,first);
  const flow=await startGitHub(t,second),provider=githubProvider(t,{verifier:flow.verifier});
  const result=await t.call(flow.callback,'GET',null,null,flow.cookie);assert.equal(result.status,409);assert.equal(provider.deletions,0);
  assert.equal(t.sql.prepare('SELECT request_id FROM connections').get().request_id,first.id);assert.equal(t.sql.prepare('SELECT count(*) AS n FROM connections').get().n,1);
});

test('a request closing during GitHub verification cannot gain lasting access after its cleanup passed',async()=>{
  const t=fixture(),user=await t.register();await configureGitHub(t);const flow=await startGitHub(t,user);
  const provider=githubProvider(t,{verifier:flow.verifier,beforeRepositoryResult:()=>t.sql.prepare("UPDATE requests SET status='expired',expires_at=? WHERE id=?").run(Date.now()-1,user.id)});
  const result=await t.call(flow.callback,'GET',null,null,flow.cookie);
  assert.equal(result.status,409);assert.equal(provider.deletions,1);
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM connections WHERE state='active'").get().n,0);
  assert.equal(t.sql.prepare('SELECT state FROM connections').get().state,'removed');
});

test('two pending flows for one request keep the accepted GitHub installation and clean up the later one',async()=>{
  const t=fixture(),user=await t.register();await configureGitHub(t);
  const first=await startGitHub(t,user,'person/project',7),second=await startGitHub(t,user,'another/project',8);
  const firstProvider=githubProvider(t,{verifier:first.verifier});
  assert.equal((await t.call(first.callback,'GET',null,null,first.cookie)).status,303);assert.equal(firstProvider.deletions,0);
  const secondProvider=githubProvider(t,{verifier:second.verifier,repository:'another/project',installationId:8,accountId:20});
  const result=await t.call(second.callback,'GET',null,null,second.cookie);
  assert.equal(result.status,409);assert.equal(secondProvider.deletions,1);
  const active=t.sql.prepare("SELECT * FROM connections WHERE state='active'").all();assert.equal(active.length,1);assert.equal(active[0].external_id,'7');
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM connections WHERE state='removed'").get().n,1);
});

test('overdue connection routes preserve GitHub installation while Stripe payment is uncertain',async()=>{
  const t=fixture(),user=await t.register();await configureGitHub(t);const {connection,provider}=await connectGitHub(t,user);
  t.sql.prepare("UPDATE requests SET status='approved',completed_at=?,expires_at=?,stripe_session_id='cs_pending' WHERE id=?").run(Date.now()-8*86400000,Date.now()-1,user.id);
  t.env.STRIPE_SECRET_KEY=['stripe', 'key', 'fixture'].join('-');const transport=t.env.FETCH;let stripeChecks=0;
  t.env.FETCH=async(url,init)=>{if(new URL(url).origin==='https://api.stripe.com'){stripeChecks++;throw new Error('Stripe reconciliation unavailable');}return transport(url,init);};
  const result=await t.call('requests/'+user.id+'/connections','GET',null,user.token);assert.equal(result.status,200);
  assert.equal(t.sql.prepare('SELECT status FROM requests').get().status,'approved');assert.equal(t.sql.prepare('SELECT state FROM connections WHERE id=?').get(connection.id).state,'active');assert.equal(provider.deletions,0);
  const read=await t.call('admin/connections/'+connection.id+'/read','GET',null,'admin-test');assert.ok(read.status>=400);assert.equal(provider.deletions,0);assert.ok(stripeChecks>=1);
});

test('a request closing during Figma verification does not persist fresh provider tokens',async()=>{
  const t=fixture(),user=await t.register(),flow=await t.start(user);t.provider();const transport=t.env.FETCH;
  t.env.FETCH=async(url,init)=>{if(new URL(url).pathname.startsWith('/v1/files/'))t.sql.prepare("UPDATE requests SET status='expired',expires_at=? WHERE id=?").run(Date.now()-1,user.id);return transport(url,init);};
  const result=await t.call('connect/figma/callback?code=fixture-code&state='+flow.state,'GET',null,null,flow.cookie);
  assert.equal(result.status,409);assert.equal(t.sql.prepare('SELECT count(*) AS n FROM connections').get().n,0);
});

test('disconnect during an in-flight GitHub read suppresses the pending project response',async()=>{
  const t=fixture(),user=await t.register();await configureGitHub(t);const {connection}=await connectGitHub(t,user);
  const provider=githubProvider(t,{beforeContentsResult:async()=>{
    assert.equal((await t.call('requests/'+user.id+'/disconnect/'+connection.id,'POST',{},user.token)).status,200);
  }});
  const result=await t.call('admin/connections/'+connection.id+'/read','GET',null,'admin-test');
  assert.equal(result.status,403);assert.equal(result.data.content,undefined);assert.equal(provider.deletions,1);
  assert.equal(t.sql.prepare('SELECT state FROM connections').get().state,'removed');
});

test('an installation claimed for orphan cleanup cannot become an active connection',async()=>{
  const t=fixture(),user=await t.register();await configureGitHub(t);const flow=await startGitHub(t,user);
  const provider=githubProvider(t,{verifier:flow.verifier,beforeRepositoryResult:()=>{
    t.sql.prepare('INSERT INTO github_installation_cleanup(installation_id,requested_at) VALUES(?,?)').run('7',Date.now());
  }});
  const result=await t.call(flow.callback,'GET',null,null,flow.cookie);
  assert.equal(result.status,409);assert.equal(provider.deletions,0);
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM connections WHERE state='active'").get().n,0);
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM connections').get().n,0);
  assert.equal(t.sql.prepare('SELECT removed_at FROM github_installation_cleanup').get().removed_at,null);
});
