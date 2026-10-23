export type OfflineExpenseDraft = {
  expenseNumber: string;
  supplierId?: string;
  expenseAccountId: string;
  category: string;
  description: string;
  incurredOn?: string;
  amount: string;
};
export type QueuedMutation = {
  clientMutationId: string;
  type: 'expense.draft';
  payload: OfflineExpenseDraft;
  createdAt: string;
  state: 'queued' | 'conflict';
  conflictReason?: string;
};
const DB_NAME='shuleledger-offline';
const STORE='mutations';
const DB_VERSION=1;

function openDatabase():Promise<IDBDatabase>{
  if(typeof indexedDB==='undefined')return Promise.reject(new Error('This browser does not support offline storage.'));
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'clientMutationId'});};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error??new Error('Could not open offline storage.'));
  });
}
async function transact<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore,resolve:(v:T)=>void,reject:(e:unknown)=>void)=>void):Promise<T>{
  const db=await openDatabase();
  return new Promise<T>((resolve,reject)=>{
    const tx=db.transaction(STORE,mode);
    work(tx.objectStore(STORE),resolve,reject);
    tx.oncomplete=()=>db.close();
    tx.onerror=()=>{db.close();reject(tx.error??new Error('Offline storage transaction failed.'));};
    tx.onabort=()=>{db.close();reject(tx.error??new Error('Offline storage transaction aborted.'));};
  });
}
export async function queueExpenseDraft(payload:OfflineExpenseDraft):Promise<QueuedMutation>{
  const mutation:QueuedMutation={clientMutationId:crypto.randomUUID(),type:'expense.draft',payload,createdAt:new Date().toISOString(),state:'queued'};
  return transact('readwrite',(store,resolve,reject)=>{const r=store.add(mutation);r.onsuccess=()=>resolve(mutation);r.onerror=()=>reject(r.error);});
}
export async function listOfflineMutations():Promise<QueuedMutation[]>{
  return transact('readonly',(store,resolve,reject)=>{const r=store.getAll();r.onsuccess=()=>resolve(r.result as QueuedMutation[]);r.onerror=()=>reject(r.error);});
}
export async function removeOfflineMutation(id:string):Promise<void>{
  return transact('readwrite',(store,resolve,reject)=>{const r=store.delete(id);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);});
}
export async function markOfflineConflict(id:string,reason:string):Promise<void>{
  // Read and update in one IndexedDB read-write transaction so a concurrent
  // sync/list operation cannot overwrite a newer version of the queued draft.
  return transact('readwrite',(store,resolve,reject)=>{
    const read=store.get(id);
    read.onerror=()=>reject(read.error);
    read.onsuccess=()=>{
      const item=read.result as QueuedMutation|undefined;
      if(!item){resolve();return;}
      const write=store.put({...item,state:'conflict',conflictReason:reason});
      write.onsuccess=()=>resolve();
      write.onerror=()=>reject(write.error);
    };
  });
}
