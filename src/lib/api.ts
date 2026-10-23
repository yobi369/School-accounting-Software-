export type SchoolSession = {
  token:string;
  expiresAt?:string;
  user:{id:string;email:string;fullName:string;mustChangePassword:boolean};
  school:{id:string;name:string};
  role?:string;
  permissions?:string[];
};
const KEY='shuleledger.session.v1';
export function readSession():SchoolSession|null{
  try{const raw=sessionStorage.getItem(KEY);return raw?JSON.parse(raw) as SchoolSession:null;}catch{return null;}
}
export function saveSession(session:SchoolSession):void{sessionStorage.setItem(KEY,JSON.stringify(session));}
export function clearSession():void{sessionStorage.removeItem(KEY);}
export async function apiRequest<T=Record<string,unknown>>(path:string,session:SchoolSession,init:RequestInit={}):Promise<T>{
  const headers=new Headers(init.headers);
  headers.set('Authorization','Bearer '+session.token);
  if(init.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  const response=await fetch('/api/v1'+path,{...init,headers});
  if(!response.ok){
    const body=await response.json().catch(()=>({}));
    throw new Error(typeof body.error==='string'?body.error:`Request failed (${response.status}).`);
  }
  if(response.status===204)return undefined as T;
  return response.json() as Promise<T>;
}
export async function downloadReport(path:string,session:SchoolSession):Promise<void>{
  const response=await fetch('/api/v1'+path,{headers:{Authorization:'Bearer '+session.token}});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error??'Report export failed.');}
  const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');
  a.href=url;a.download=path.split('/').pop()??'report.csv';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}
