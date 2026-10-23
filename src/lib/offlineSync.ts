import { listOfflineMutations, markOfflineConflict, removeOfflineMutation } from './offlineQueue.js';

type SyncResult={status:'accepted'|'conflict'|'rejected';clientMutationId:string;reason?:string;serverId?:string;duplicate?:boolean};
export async function syncOfflineExpenses(token:string):Promise<{synced:number;conflicts:number;pending:number}>{
  if(!navigator.onLine)throw new Error('You are offline. Queued expense drafts remain on this device.');
  const pending=await listOfflineMutations();
  const queued=pending.filter(item=>item.state==='queued');
  if(!queued.length)return {synced:0,conflicts:0,pending:pending.length};
  const response=await fetch('/api/v1/sync/push',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({mutations:queued.map(({clientMutationId,type,payload})=>({clientMutationId,type,payload}))}),
  });
  if(!response.ok)throw new Error(response.status===401?'Sign in again before syncing offline drafts.':'Sync request failed. Your drafts remain saved on this device.');
  const body=await response.json() as {results:SyncResult[]};
  let synced=0,conflicts=0;
  for(const result of body.results){
    if(result.status==='accepted'){await removeOfflineMutation(result.clientMutationId);synced++;}
    else {await markOfflineConflict(result.clientMutationId,result.reason??'Server rejected this mutation. Review it before retrying.');conflicts++;}
  }
  return {synced,conflicts,pending:(await listOfflineMutations()).length};
}
