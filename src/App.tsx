import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest, clearSession, downloadReport, readSession, saveSession, type SchoolSession } from './lib/api';
import { listOfflineMutations, queueExpenseDraft, type OfflineExpenseDraft, type QueuedMutation } from './lib/offlineQueue';
import { syncOfflineExpenses } from './lib/offlineSync';

type Row=Record<string,unknown>;
type Field={
  name:string;label:string;type?:'text'|'date'|'number'|'password'|'select'|'textarea'|'email';
  required?:boolean;placeholder?:string;options?:{label:string;value:string}[];defaultValue?:string;
};
const navigation=[
  {id:'overview',label:'Overview',icon:'⌂'},
  {id:'students',label:'Students',icon:'♙'},
  {id:'fees',label:'Fees & receipts',icon:'KSh'},
  {id:'expenses',label:'Expenses & approvals',icon:'↗'},
  {id:'ledger',label:'General ledger',icon:'≋'},
  {id:'bank',label:'Cash & bank',icon:'▤'},
  {id:'reports',label:'Financial reports',icon:'▥'},
  {id:'audit',label:'Audit trail',icon:'◷'},
  {id:'users',label:'People & access',icon:'♧'},
  {id:'settings',label:'School settings',icon:'⚙'},
] as const;
const labels:Record<string,string>={
  id:'ID',admission_number:'Admission no.',full_name:'Name',class_name:'Class',status:'Status',
  invoice_number:'Invoice',student_name:'Student',academic_year:'Academic year',issued_on:'Issued',
  due_on:'Due date',amount:'Amount (KES)',allocated:'Allocated (KES)',outstanding:'Outstanding (KES)',
  receipt_number:'Receipt',received_on:'Received',payment_method:'Method',expense_number:'Expense ref',
  category:'Category',description:'Description',incurred_on:'Date',approved_at:'Approved at',
  paid_at:'Paid at',entry_number:'Entry no.',posting_date:'Posting date',account_type:'Account type',
  code:'Code',name:'Name',debit:'Debit',credit:'Credit',total_debit:'Debit total',total_credit:'Credit total',
  role:'Role',email:'Email',membership_status:'Membership',action:'Action',entity_type:'Record type',
  entity_id:'Record ID',created_at:'Created at',bank_name:'Bank',account_number_masked:'Account',
  transaction_date:'Date',reference:'Reference',matched_at:'Matched at',starts_on:'Starts',ends_on:'Ends',
  financial_year_name:'Financial year',period_id:'Period ID',year_starts_on:'Year starts',year_ends_on:'Year ends',
  posted_count:'Posted journals',awaiting_approval:'Awaiting approval',approved_unpaid:'Approved unpaid',
  collected:'Fees collected',unmatched:'Unmatched lines',paid_total:'Expenses paid',
};
const human=(value:unknown):string=>{
  if(value===null||value===undefined)return '—';
  if(typeof value==='object')return JSON.stringify(value);
  return String(value);
};
const today=()=>new Date().toISOString().slice(0,10);
function DynamicForm({title,fields,submitLabel='Save',onSubmit}:{title:string;fields:Field[];submitLabel?:string;onSubmit:(values:Record<string,string>)=>Promise<void>}){
  const initial=useMemo(()=>Object.fromEntries(fields.map(f=>[f.name,f.defaultValue??''])),[fields]);
  const [values,setValues]=useState<Record<string,string>>(initial);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>setValues(initial),[initial]);
  return <form className="sl-form" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await onSubmit(values);setValues(initial);}catch(err){setError(err instanceof Error?err.message:'Could not save this record.');}finally{setBusy(false);}}}>
    <h3>{title}</h3>
    <div className="sl-form-grid">{fields.map(f=><label className={f.type==='textarea'?'sl-wide':''} key={f.name}>{f.label}
      {f.type==='select'?<select required={f.required!==false} value={values[f.name]??''} onChange={e=>setValues(v=>({...v,[f.name]:e.target.value}))}><option value="">Select…</option>{(f.options??[]).map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>
      :f.type==='textarea'?<textarea required={f.required!==false} placeholder={f.placeholder} value={values[f.name]??''} onChange={e=>setValues(v=>({...v,[f.name]:e.target.value}))} rows={4}/>
      :<input required={f.required!==false} type={f.type??'text'} min={f.type==='number'?'0':undefined} step={f.type==='number'?'0.01':undefined} placeholder={f.placeholder} value={values[f.name]??''} onChange={e=>setValues(v=>({...v,[f.name]:e.target.value}))}/>}
    </label>)}</div>
    {error&&<p className="sl-error">{error}</p>}<button className="sl-primary" disabled={busy}>{busy?'Saving…':submitLabel}</button>
  </form>;
}
function DataTable({rows,empty='No records yet.'}:{rows:Row[];empty?:string}){
  if(!rows.length)return <div className="sl-empty">{empty}</div>;
  const keys=Object.keys(rows[0]).filter(k=>!['password_hash','token_hash','metadata','response_body','request_hash'].includes(k));
  return <div className="sl-table-wrap"><table className="sl-table"><thead><tr>{keys.map(k=><th key={k}>{labels[k]??k.replaceAll('_',' ')}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={String(row.id??row.invoice_number??row.receipt_number??i)}>{keys.map(k=><td key={k}>{human(row[k])}</td>)}</tr>)}</tbody></table></div>;
}
function Login({onSuccess}:{onSuccess:(session:SchoolSession)=>void}){
  const [schoolId,setSchoolId]=useState('');const [email,setEmail]=useState('');const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  return <main className="sl-auth-shell"><section className="sl-auth-card">
    <div className="sl-brand-mark">S</div><p className="sl-eyebrow">KENYAN SCHOOL FINANCE</p><h1>Welcome to ShuleLedger</h1>
    <p className="sl-muted">Sign in to your school workspace. Each school’s records are isolated on the server.</p>
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{
      const response=await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({schoolId,email,password})});
      const body=await response.json();if(!response.ok)throw new Error(body.error??'Sign-in failed.');
      const session:SchoolSession={token:body.token,expiresAt:body.expiresAt,user:body.user,school:body.school};
      const me=await apiRequest<{user:SchoolSession['user'];school:SchoolSession['school'];role:string;permissions:string[]}>('/auth/me',session);
      const full={...session,user:me.user,school:me.school,role:me.role,permissions:me.permissions};saveSession(full);onSuccess(full);
    }catch(err){setError(err instanceof Error?err.message:'Could not sign in.');}finally{setBusy(false);}}}>
      <label>School workspace ID<input required value={schoolId} onChange={e=>setSchoolId(e.target.value.trim())} placeholder="UUID provided by your administrator"/></label>
      <label>Email address<input required type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@school.ac.ke"/></label>
      <label>Password<input required type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>
      {error&&<p className="sl-error">{error}</p>}
      <button className="sl-primary sl-full" disabled={busy}>{busy?'Signing in…':'Sign in securely'}</button>
    </form>
    <div className="sl-auth-foot"><span>🔒 Protected school workspace</span><span>Offline drafts stay pending until synced.</span></div>
  </section></main>;
}
function ChangePassword({session,onChanged,onLogout}:{session:SchoolSession;onChanged:(s:SchoolSession)=>void;onLogout:()=>void}){
  const [currentPassword,setCurrent]=useState('');const [newPassword,setNew]=useState('');const [confirm,setConfirm]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  return <main className="sl-auth-shell"><section className="sl-auth-card"><div className="sl-brand-mark">S</div><h1>Set your password</h1>
    <p className="sl-muted">Your administrator issued an initial password. Change it before opening school records.</p>
    <form onSubmit={async e=>{e.preventDefault();setError('');if(newPassword!==confirm){setError('The new passwords do not match.');return;}setBusy(true);try{
      await apiRequest('/auth/change-password',session,{method:'POST',body:JSON.stringify({currentPassword,newPassword})});
      const me=await apiRequest<{user:SchoolSession['user'];school:SchoolSession['school'];role:string;permissions:string[]}>('/auth/me',{...session,user:{...session.user,mustChangePassword:false}});
      const next={...session,user:me.user,school:me.school,role:me.role,permissions:me.permissions};saveSession(next);onChanged(next);
    }catch(err){setError(err instanceof Error?err.message:'Password update failed.');}finally{setBusy(false);}}}>
      <label>Current password<input required type="password" value={currentPassword} onChange={e=>setCurrent(e.target.value)}/></label>
      <label>New password (12 characters minimum)<input required minLength={12} type="password" value={newPassword} onChange={e=>setNew(e.target.value)}/></label>
      <label>Confirm new password<input required minLength={12} type="password" value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>
      {error&&<p className="sl-error">{error}</p>}<button className="sl-primary sl-full" disabled={busy}>{busy?'Updating…':'Update password'}</button>
    </form><button className="sl-link" onClick={onLogout}>Sign out</button>
  </section></main>;
}
function Workspace({session,onLogout}:{session:SchoolSession;onLogout:()=>void}){
  const [active,setActive]=useState('overview');const [data,setData]=useState<Record<string,unknown>>({});
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [online,setOnline]=useState(navigator.onLine);const [offlineItems,setOfflineItems]=useState<QueuedMutation[]>([]);
  const [csv,setCsv]=useState('date,description,reference,amount\n');
  const [selectedBank,setSelectedBank]=useState('');
  const [report,setReport]=useState<Row[]>([]);
  const load=useCallback(async(page:string)=>{
    setBusy(true);setError('');
    try{
      let next:Record<string,unknown>={};
      if(page==='overview')next=await apiRequest('/overview',session) as Record<string,unknown>;
      if(page==='students')next=await apiRequest('/students',session) as Record<string,unknown>;
      if(page==='fees'){const [invoices,students,waivers]=await Promise.all([apiRequest('/fees/invoices',session),apiRequest('/students',session),apiRequest('/fees/waivers',session)]);next={...(invoices as object),...(students as object),...(waivers as object)};}
      if(page==='expenses'){const [expenses,accounts,suppliers]=await Promise.all([apiRequest('/expenses',session),apiRequest('/ledger/accounts',session),apiRequest('/suppliers',session)]);next={...(expenses as object),...(accounts as object),...(suppliers as object)};}
      if(page==='ledger'){const [accounts,journals,periods]=await Promise.all([apiRequest('/ledger/accounts',session),apiRequest('/ledger/journals',session),apiRequest('/accounting/periods',session)]);next={...(accounts as object),...(journals as object),...(periods as object)};}
      if(page==='bank'){const [bankAccounts,ledgerAccounts]=await Promise.all([apiRequest('/bank/accounts',session),apiRequest('/ledger/accounts',session)]);next={...(bankAccounts as object),ledgerAccounts:(ledgerAccounts as Record<string,unknown>).accounts};}
      if(page==='audit')next=await apiRequest('/audit-events',session) as Record<string,unknown>;
      if(page==='users')next=await apiRequest('/users',session) as Record<string,unknown>;
      if(page==='settings'){const [periodData,budgetData]=await Promise.all([apiRequest('/accounting/periods',session),apiRequest('/budgets',session)]);next={...(periodData as object),...(budgetData as object)};}
      setData(next);
      const cachedAccounts=Array.isArray(next.ledgerAccounts)?next.ledgerAccounts:next.accounts;
      if(Array.isArray(cachedAccounts))sessionStorage.setItem('shuleledger.accounts.'+session.school.id,JSON.stringify(cachedAccounts));
    }catch(err){
      const cached=sessionStorage.getItem('shuleledger.accounts.'+session.school.id);
      if(!navigator.onLine&&cached){try{setData(prev=>({...prev,accounts:JSON.parse(cached)}));}catch{}}
      setError(!navigator.onLine?'Offline. Cached account codes are available for draft entry; server actions require a connection.':err instanceof Error?err.message:'Could not load this module.');
    }
    finally{setBusy(false);}
  },[session]);
  const refreshOffline=useCallback(async()=>{try{setOfflineItems(await listOfflineMutations());}catch{setOfflineItems([]);}},[]);
  useEffect(()=>{void load(active);},[active,load]);
  useEffect(()=>{const update=()=>setOnline(navigator.onLine);window.addEventListener('online',update);window.addEventListener('offline',update);void refreshOffline();return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[refreshOffline]);
  const rows=(key:string):Row[]=>Array.isArray(data[key])?data[key] as Row[]:[];
  const students=rows('students');const invoices=rows('invoices');const accounts=rows('accounts');const expenses=rows('expenses');const periods=rows('periods');const banks=rows('accounts');const users=rows('users');const journals=rows('journals');const events=rows('events');const waivers=rows('waivers');const suppliers=rows('suppliers');const budgets=rows('budgets');const statementLines=rows('statementLines');const journalLineRows=rows('journalLines');
  const accountOptions=(active==='bank'?rows('ledgerAccounts'):accounts).map(a=>({label:`${human(a.code)} — ${human(a.name)} (${human(a.account_type)})`,value:String(a.id)}));
  const studentOptions=students.map(s=>({label:`${human(s.admission_number)} — ${human(s.full_name)}`,value:String(s.id)}));
  const invoiceOptions=invoices.map(i=>({label:`${human(i.invoice_number)} — ${human(i.student_name)} — Outstanding KES ${human(i.outstanding??i.amount)}`,value:String(i.id)}));
  const statementOptions=statementLines.map(l=>({label:String(l.transaction_date)+' — '+String(l.description)+' — '+String(l.amount),value:String(l.id)}));
  const journalLineOptions=journalLineRows.map(l=>({label:'Entry '+String(l.entry_number)+' · '+String(l.posting_date)+' · Dr '+String(l.debit)+' / Cr '+String(l.credit)+' · '+String(l.description),value:String(l.id)}));
  const periodOptions=periods.filter(p=>p.status==='open').map(p=>({label:`${human(p.financial_year_name)} · ${human(p.starts_on)} to ${human(p.ends_on)}`,value:String(p.period_id)}));
  const yearOptions=[...new Map(periods.filter(p=>p.status==='open').map(p=>[String(p.financial_year_id),{label:String(p.financial_year_name),value:String(p.financial_year_id)}])).values()];
  const reportRequest=async(name:string)=>{setBusy(true);setError('');try{const r=await apiRequest<Record<string,unknown>>('/reports/'+name,session);const list=Object.entries(r).find(([k,v])=>k==='rows'&&Array.isArray(v))?.[1] as Row[]|undefined;setReport(list??[]);setNotice('Report refreshed from posted ledger data.');}catch(err){setError(err instanceof Error?err.message:'Report failed.');}finally{setBusy(false);}};
  const send=async(path:string,method:string,body:unknown)=>{await apiRequest(path,session,{method,body:JSON.stringify(body)});setNotice('Saved successfully.');await load(active);};
  const money=(value:unknown)=>new Intl.NumberFormat('en-KE',{style:'currency',currency:'KES',maximumFractionDigits:2}).format(Number(value??0));
  const title=navigation.find(n=>n.id===active)?.label??'Overview';

  return <div className="sl-shell">
    <aside className="sl-sidebar"><div className="sl-brand"><div className="sl-brand-mark">S</div><div><b>shuleledger</b><small>SCHOOL FINANCE, CLEARLY</small></div></div>
      <div className="sl-school"><span className="sl-school-avatar">{session.school.name.slice(0,1).toUpperCase()}</span><div><b>{session.school.name}</b><small>{session.role??'School workspace'}</small></div></div>
      <nav className="sl-nav">{navigation.map(n=><button key={n.id} className={active===n.id?'selected':''} onClick={()=>{setActive(n.id);setReport([]);setNotice('');}}><span>{n.icon}</span>{n.label}</button>)}</nav>
      <div className="sl-side-foot"><span className={online?'sl-online':'sl-offline'}></span>{online?'Online':'Offline'} · {offlineItems.length} local drafts</div>
    </aside>
    <main className="sl-main"><header className="sl-topbar"><div><small>School workspace /</small><b>{title}</b></div><div className="sl-top-actions"><span>{session.user.fullName}</span><button className="sl-outline" onClick={async()=>{try{await apiRequest('/auth/logout',session,{method:'POST'});}catch{}onLogout();}}>Sign out</button></div></header>
      <section className="sl-content"><div className="sl-page-head"><div><p className="sl-eyebrow">SHULELEDGER · KES · AFRICA/NAIROBI</p><h1>{title}</h1><p className="sl-muted">School records are loaded from the authenticated server workspace.</p></div><button className="sl-outline" onClick={()=>void load(active)} disabled={busy}>↻ Refresh</button></div>
        {!online&&<div className="sl-banner">Offline: financial postings are disabled. Only queued expense drafts can sync when you reconnect.</div>}
        {notice&&<div className="sl-success">{notice}<button onClick={()=>setNotice('')}>×</button></div>}
        {error&&<div className="sl-error-box">{error}</div>}
        {busy&&<div className="sl-loading">Loading school records…</div>}
        {active==='overview'&&<>{(data.summary&&typeof data.summary==='object')?<><div className="sl-stat-grid">{Object.entries((data.summary as Record<string,unknown>).fees as Record<string,unknown>).map(([k,v])=><article className="sl-stat" key={k}><span>{k==='collected'?'Fees collected':'Outstanding fees'}</span><strong>{money(v)}</strong><small>Live ledger-linked totals</small></article>)}{Object.entries((data.summary as Record<string,unknown>).expenses as Record<string,unknown>).map(([k,v])=><article className="sl-stat" key={k}><span>{labels[k]??k.replaceAll('_',' ')}</span><strong>{k.includes('total')?money(v):human(v)}</strong><small>Current school records</small></article>)}</div><div className="sl-panel"><h2>Operational checks</h2><p>Posted journals: {human((data.summary as Row).postedJournals)} · Unmatched bank statement lines: {human((data.summary as Row).unmatchedBankLines)}</p><p>Figures come from saved records; offline drafts are never included as posted transactions.</p></div></>:<div className="sl-panel">Your school dashboard will appear once the API and database are configured.</div>}
          <div className="sl-panel"><h2>Offline drafts</h2><p>{offlineItems.length} draft expense mutation(s) saved on this device. These are not accounting entries until a server confirms them.</p>{offlineItems.length>0&&<><DataTable rows={offlineItems.map(i=>({clientMutationId:i.clientMutationId,expenseNumber:i.payload.expenseNumber,description:i.payload.description,amount:i.payload.amount,state:i.state,conflictReason:i.conflictReason}))}/><button className="sl-primary" disabled={!online||busy} onClick={async()=>{setBusy(true);setError('');try{const r=await syncOfflineExpenses(session.token);setNotice(`Sync finished: ${r.synced} accepted, ${r.conflicts} need review, ${r.pending} still pending.`);await refreshOffline();}catch(e){setError(e instanceof Error?e.message:'Sync failed.');}finally{setBusy(false);}}}>Sync draft expenses</button></>}</div>
        </>}
        {active==='students'&&<><DynamicForm title="Register student" fields={[{name:'admissionNumber',label:'Admission number'},{name:'fullName',label:'Full name'},{name:'className',label:'Class / grade',required:false},{name:'guardianName',label:'Guardian name',required:false},{name:'guardianPhone',label:'Guardian phone',required:false}]} onSubmit={v=>send('/students','POST',v)}/><div className="sl-panel"><h2>Students</h2><DataTable rows={students}/></div></>}
        {active==='fees'&&<><DynamicForm title="Issue fee invoice" fields={[{name:'studentId',label:'Student',type:'select',options:studentOptions},{name:'invoiceNumber',label:'Invoice number'},{name:'academicYear',label:'Academic year',defaultValue:String(new Date().getFullYear())},{name:'description',label:'Description'},{name:'dueOn',label:'Due date',type:'date',defaultValue:today()},{name:'amount',label:'Amount (KES)',type:'number'}]} onSubmit={v=>send('/fees/invoices','POST',v)}/><DynamicForm title="Record fee receipt" fields={[{name:'studentId',label:'Student',type:'select',options:studentOptions},{name:'receiptNumber',label:'Receipt number'},{name:'invoiceId',label:'Invoice to allocate',type:'select',options:invoiceOptions},{name:'amount',label:'Amount (KES)',type:'number'},{name:'paymentMethod',label:'Payment method',type:'select',options:[{label:'Cash',value:'cash'},{label:'Bank',value:'bank'},{label:'M-Pesa',value:'mpesa'},{label:'Cheque',value:'cheque'},{label:'Other',value:'other'}]},{name:'externalReference',label:'Payment reference',required:false}]} onSubmit={v=>send('/fees/receipts','POST',{studentId:v.studentId,receiptNumber:v.receiptNumber,amount:v.amount,paymentMethod:v.paymentMethod,externalReference:v.externalReference,allocations:[{invoiceId:v.invoiceId,amount:v.amount}]})}/><div className="sl-panel"><h2>Fee invoices and balances</h2><DataTable rows={invoices}/></div></>}
        {active==='expenses'&&<><DynamicForm title="Submit expense for approval" fields={[{name:'expenseNumber',label:'Voucher / expense number'},{name:'expenseAccountId',label:'Expense account',type:'select',options:accountOptions.filter(a=>accounts.find(x=>String(x.id)===a.value)?.account_type==='expense')},{name:'category',label:'Category'},{name:'description',label:'Description'},{name:'incurredOn',label:'Date incurred',type:'date',defaultValue:today()},{name:'amount',label:'Amount (KES)',type:'number'}]} onSubmit={v=>send('/expenses','POST',{expenseNumber:v.expenseNumber,expenseAccountId:v.expenseAccountId,category:v.category,description:v.description,incurredOn:v.incurredOn,amount:v.amount})}/><DynamicForm title="Queue expense draft while offline" fields={[{name:'expenseNumber',label:'Draft reference'},{name:'expenseAccountId',label:'Expense account',type:'select',options:accountOptions.filter(a=>accounts.find(x=>String(x.id)===a.value)?.account_type==='expense')},{name:'category',label:'Category'},{name:'description',label:'Description'},{name:'incurredOn',label:'Date incurred',type:'date',defaultValue:today()},{name:'amount',label:'Amount (KES)',type:'number'}]} onSubmit={async v=>{const draft:OfflineExpenseDraft={expenseNumber:v.expenseNumber,expenseAccountId:v.expenseAccountId,category:v.category,description:v.description,incurredOn:v.incurredOn,amount:v.amount};await queueExpenseDraft(draft);await refreshOffline();setNotice('Saved locally as a draft. Not posted and not yet visible to other users.');}}/><div className="sl-panel"><h2>Expense workflow</h2><DataTable rows={expenses}/>{expenses.filter(e=>e.status==='draft').map(e=><button key={String(e.id)} className="sl-outline sl-action" onClick={async()=>{try{await send('/expenses/'+e.id+'/submit','POST',{});}catch(err){setError(err instanceof Error?err.message:'Submit failed.');}}}>Submit draft {String(e.expense_number)}</button>)}{expenses.filter(e=>e.status==='submitted').map(e=><button key={String(e.id)} className="sl-outline sl-action" onClick={async()=>{try{await send('/expenses/'+e.id+'/approve','POST',{});}catch(err){setError(err instanceof Error?err.message:'Approval failed.');}}}>Approve {String(e.expense_number)}</button>)}{expenses.filter(e=>e.status==='approved').map(e=><DynamicForm key={String(e.id)} title={'Pay '+String(e.expense_number)} fields={[{name:'paymentAccountId',label:'Cash / bank account',type:'select',options:accountOptions.filter(a=>accounts.find(x=>String(x.id)===a.value)?.account_type==='asset')},{name:'paidOn',label:'Payment date',type:'date',defaultValue:today()}]} onSubmit={v=>send('/expenses/'+e.id+'/pay','POST',v)}/>)}</div></>}
        {active==='ledger'&&<><div className="sl-panel"><h2>Accounts</h2><DataTable rows={accounts}/></div><DynamicForm title="Post balanced manual journal" fields={[{name:'financialYearId',label:'Financial year',type:'select',options:yearOptions},{name:'periodId',label:'Accounting period',type:'select',options:periodOptions},{name:'postingDate',label:'Posting date',type:'date',defaultValue:today()},{name:'description',label:'Description'},{name:'debitAccountId',label:'Debit account',type:'select',options:accountOptions},{name:'creditAccountId',label:'Credit account',type:'select',options:accountOptions},{name:'amount',label:'Amount (KES)',type:'number'}]} onSubmit={async v=>{await apiRequest('/ledger/journals',session,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({financialYearId:v.financialYearId,periodId:v.periodId,postingDate:v.postingDate,description:v.description,lines:[{accountId:v.debitAccountId,debit:v.amount,credit:'0'},{accountId:v.creditAccountId,debit:'0',credit:v.amount}]})});setNotice('Journal posted successfully.');await load('ledger');}}/><div className="sl-panel"><h2>Posted journals</h2><DataTable rows={journals}/></div></>}
        {active==='bank'&&<><DynamicForm title="Add bank / cash account" fields={[{name:'name',label:'Display name'},{name:'bankName',label:'Bank / provider'},{name:'accountNumberMasked',label:'Masked account number',required:false},{name:'ledgerAccountId',label:'Ledger asset account',type:'select',options:accountOptions.filter(a=>accounts.find(x=>String(x.id)===a.value)?.account_type==='asset')}]} onSubmit={v=>send('/bank/accounts','POST',v)}/><div className="sl-panel"><h2>Bank accounts</h2><DataTable rows={banks}/>{banks.length>0&&<label className="sl-field">Choose account<select value={selectedBank} onChange={e=>setSelectedBank(e.target.value)}><option value="">Select…</option>{banks.map(b=><option value={String(b.id)} key={String(b.id)}>{String(b.name)}</option>)}</select></label>}</div>{selectedBank&&<><div className="sl-panel"><h2>Import statement CSV</h2><p>Required columns: date, description, amount. Optional: reference. Date format: YYYY-MM-DD.</p><textarea className="sl-csv" value={csv} onChange={e=>setCsv(e.target.value)}/><button className="sl-primary" onClick={async()=>{try{const r=await apiRequest<{imported:number;duplicates:number}>('/bank/accounts/'+selectedBank+'/import',session,{method:'POST',body:JSON.stringify({csv})});setNotice(`Imported ${r.imported}; duplicates skipped ${r.duplicates}.`);}catch(e){setError(e instanceof Error?e.message:'Import failed.');}}}>Import statement</button></div><div className="sl-panel"><h2>Match statement to ledger</h2><DynamicForm title="Reconcile a line" fields={[{name:'statementLineId',label:'Statement line ID'},{name:'journalLineId',label:'Posted journal line ID'}]} onSubmit={v=>send('/bank/reconcile','POST',v)}/><p>Only exact amount matches against the configured bank ledger account are accepted.</p></div></>}</>}
        {active==='reports'&&<><div className="sl-report-actions">{['trial-balance','income-statement','balance-sheet','general-ledger','cashbook','bankbook','receipts-register','invoice-register','fee-balances','fee-aging','expense-register','supplier-payables','bank-reconciliation','budget-variance','journal-register','collections-by-method','fees-by-class','audit-trail'].map(name=><button className="sl-outline" key={name} onClick={()=>void reportRequest(name)}>{name.replaceAll('-',' ')}</button>)}</div><div className="sl-report-actions">{['trial-balance','income-statement','balance-sheet','general-ledger','cashbook','bankbook','receipts-register','invoice-register','fee-balances','fee-aging','expense-register','supplier-payables','bank-reconciliation','budget-variance','journal-register','collections-by-method','fees-by-class','audit-trail'].map(name=><span className="sl-export-set" key={name}><b>{name.replaceAll('-',' ')}</b>{['csv','xlsx','pdf'].map(format=><button className="sl-export-link" key={format} onClick={async()=>{try{await downloadReport('/reports/'+name+'.'+format,session);}catch(e){setError(e instanceof Error?e.message:'Export failed.');}}}>{format.toUpperCase()}</button>)}</span>)}</div><div className="sl-panel"><h2>Report results</h2><DataTable rows={report}/></div></>}
        {active==='audit'&&<div className="sl-panel"><h2>Immutable audit events</h2><DataTable rows={events}/></div>}
        {active==='users'&&<><DynamicForm title="Add user to this school" fields={[{name:'fullName',label:'Full name'},{name:'email',label:'Email',type:'email'},{name:'role',label:'Role',type:'select',options:[{label:'School administrator',value:'school_admin'},{label:'Bursar',value:'bursar'},{label:'Accountant',value:'accountant'},{label:'Approver',value:'approver'},{label:'Auditor',value:'auditor'}]},{name:'password',label:'Initial password (12+ characters)',type:'password'}]} onSubmit={v=>send('/users','POST',v)}/><div className="sl-panel"><h2>School members</h2><DataTable rows={users}/></div></>}
        {active==='settings'&&<div className="sl-panel"><h2>Financial years and periods</h2><DataTable rows={periods}/><p>Periods are created during school setup. Period locking and year-end close require authorized accounting review.</p></div>}
      </section>
    </main>
  </div>;
}
export default function App(){
  const [session,setSession]=useState<SchoolSession|null>(null);const [checked,setChecked]=useState(false);
  useEffect(()=>{
    const cached=readSession();
    if(!cached){setChecked(true);return;}
    if(!navigator.onLine){setSession(cached);setChecked(true);return;}
    apiRequest<{user:SchoolSession['user'];school:SchoolSession['school'];role:string;permissions:string[]}>('/auth/me',cached)
      .then(me=>{const next={...cached,user:me.user,school:me.school,role:me.role,permissions:me.permissions};saveSession(next);setSession(next);})
      .catch(()=>{clearSession();setSession(null);})
      .finally(()=>setChecked(true));
  },[]);
  const logout=()=>{clearSession();setSession(null);};
  if(!checked)return <main className="sl-auth-shell"><div className="sl-loading">Opening secure workspace…</div></main>;
  if(!session)return <Login onSuccess={setSession}/>;
  if(session.user.mustChangePassword)return <ChangePassword session={session} onChanged={setSession} onLogout={logout}/>;
  return <Workspace session={session} onLogout={logout}/>;
}
