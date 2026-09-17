let tokens=JSON.parse(sessionStorage.getItem('kirana-session')||'null');
export const setTokens=v=>{tokens=v;if(v)sessionStorage.setItem('kirana-session',JSON.stringify(v));else sessionStorage.removeItem('kirana-session');};
export const signedIn=()=>!!tokens;
export async function api(path,options={},retry=true){
 const headers={...(options.body&&!(options.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...(tokens?{Authorization:'Bearer '+tokens.accessToken}:{}),...options.headers};
 const response=await fetch('/api/v1'+path,{...options,headers,body:options.body&&!(options.body instanceof FormData)&&typeof options.body!=='string'?JSON.stringify(options.body):options.body});
 if(response.status===401&&tokens&&retry&&!path.startsWith('/auth/')){const r=await fetch('/api/v1/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:tokens.refreshToken})});const j=await r.json();if(r.ok){setTokens({...tokens,accessToken:j.data.accessToken});return api(path,options,false);}setTokens(null);window.dispatchEvent(new Event('signed-out'));}
 if(options.blob){if(!response.ok){const e=await response.json();throw Error(e.message||'Export failed');}return response.blob();}
 const text=await response.text();let json;try{json=JSON.parse(text);}catch{throw Error('The server could not complete this request. Please try again.');}
 if(!response.ok)throw Error(json.message||json.error||'Request failed');return json.data;
}
export async function download(path,name){const blob=await api(path,{blob:true});saveBlob(blob,name);}
export function saveBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
