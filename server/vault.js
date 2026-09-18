const encoder=new TextEncoder();
export const randomSecret=()=>[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
export const sha256=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const base64=value=>btoa(String.fromCharCode(...value));
const bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export const challenge=async value=>base64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
async function key(env){
  if(!/^[a-f0-9]{64}$/i.test(env.INTEGRATION_ENCRYPTION_KEY||''))throw Object.assign(new Error('Project connections are not configured yet.'),{status:503});
  return crypto.subtle.importKey('raw',Uint8Array.from(env.INTEGRATION_ENCRYPTION_KEY.match(/../g),v=>parseInt(v,16)),{name:'AES-GCM'},false,['encrypt','decrypt']);
}
export async function encrypt(env,value,purpose){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(purpose)},await key(env),encoder.encode(JSON.stringify(value)));
  return base64(iv)+'.'+base64(new Uint8Array(ciphertext));
}
export async function decrypt(env,value,purpose){
  const [iv,ciphertext]=value.split('.');
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:encoder.encode(purpose)},await key(env),bytes(ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}
