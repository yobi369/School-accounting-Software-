import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authContext, requireAuth, requirePermission } from './auth.js';
import { withSchoolTransaction } from './db.js';
import { parseKesToMinorUnits, validateJournal } from './domain/ledger.js';

export const operationsRouter = Router();
operationsRouter.use(requireAuth);

function amountString(minor: bigint): string {
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  return sign + (absolute / 100n).toString() + '.' + (absolute % 100n).toString().padStart(2,'0');
}
function asMoney(value: string): string { return amountString(parseKesToMinorUnits(value)); }
function audit(client: {query: (sql:string, values?:unknown[])=>Promise<unknown>}, schoolId:string, userId:string, action:string, type:string, id:string, metadata:Record<string,unknown>={}) {
  return client.query(
    'INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [schoolId,userId,action,type,id,JSON.stringify(metadata)],
  );
}

type PostingLine = { accountId?: string; accountCode?: string; debit: string; credit: string; memo?: string };
async function postJournal(client: any, schoolId:string, userId:string, date:string, description:string, sourceType:string, sourceId:string, postingLines:PostingLine[]) {
  const period = await client.query(
    `SELECT y.id AS year_id,p.id AS period_id
     FROM financial_years y JOIN accounting_periods p
       ON p.school_id=y.school_id AND p.financial_year_id=y.id
     WHERE y.school_id=$1 AND y.status='open' AND p.status='open'
       AND y.starts_on <= $2::date AND y.ends_on >= $2::date
       AND p.starts_on <= $2::date AND p.ends_on >= $2::date
     LIMIT 1 FOR UPDATE OF y`,
    [schoolId,date],
  );
  if (!period.rowCount) throw Object.assign(new Error('No open financial year and accounting period covers this date.'),{statusCode:422});
  const yearId = String(period.rows[0].year_id);
  const periodId = String(period.rows[0].period_id);
  const lines: {accountId:string; debit:string; credit:string; memo?:string; debitMinor:bigint; creditMinor:bigint}[] = [];
  for (const line of postingLines) {
    let accountId = line.accountId;
    if (!accountId && line.accountCode) {
      const found = await client.query('SELECT id FROM accounts WHERE school_id=$1 AND code=$2 AND is_active=true',[schoolId,line.accountCode]);
      if (!found.rowCount) throw Object.assign(new Error(`Required ledger account ${line.accountCode} is missing or inactive.`),{statusCode:422});
      accountId = String(found.rows[0].id);
    }
    if (!accountId) throw Object.assign(new Error('A ledger account is required for every posting line.'),{statusCode:422});
    const debitMinor = parseKesToMinorUnits(line.debit);
    const creditMinor = parseKesToMinorUnits(line.credit);
    lines.push({accountId,debit:amountString(debitMinor),credit:amountString(creditMinor),memo:line.memo,debitMinor,creditMinor});
  }
  validateJournal({schoolId,currency:'KES',lines:lines.map(line=>({accountId:line.accountId,debitMinor:line.debitMinor,creditMinor:line.creditMinor,memo:line.memo}))});
  const ids = [...new Set(lines.map(line=>line.accountId))];
  const valid = await client.query('SELECT id FROM accounts WHERE school_id=$1 AND is_active=true AND id=ANY($2::uuid[])',[schoolId,ids]);
  if (valid.rowCount !== ids.length) throw Object.assign(new Error('A posting account is missing, inactive, or outside this school.'),{statusCode:422});
  const numberResult = await client.query('SELECT COALESCE(MAX(entry_number),0)+1 AS n FROM journal_entries WHERE school_id=$1 AND financial_year_id=$2',[schoolId,yearId]);
  const entryId = randomUUID();
  const entryNumber = String(numberResult.rows[0].n);
  await client.query(
    "INSERT INTO journal_entries (id,school_id,financial_year_id,period_id,entry_number,posting_date,description,status,source_type,source_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10)",
    [entryId,schoolId,yearId,periodId,entryNumber,date,description,sourceType,sourceId,userId],
  );
  for (const [i,line] of lines.entries()) {
    await client.query(
      'INSERT INTO journal_lines (school_id,journal_entry_id,account_id,line_number,debit,credit,memo) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [schoolId,entryId,line.accountId,i+1,line.debit,line.credit,line.memo ?? null],
    );
  }
  await client.query("UPDATE journal_entries SET status='posted' WHERE school_id=$1 AND id=$2",[schoolId,entryId]);
  return {id:entryId,entryNumber};
}
function handleError(res:Response,error:unknown) {
  const e=error as {statusCode?:number;code?:string;message?:string};
  if (e.statusCode) { res.status(e.statusCode).json({error:e.message}); return true; }
  if (e.code==='23505') { res.status(409).json({error:'A record with these unique details already exists.'}); return true; }
  if (e.code==='23503'||e.code==='23514'||e.code==='55000') { res.status(422).json({error:'The operation violates a database integrity rule.'}); return true; }
  return false;
}
function wrap(handler:(req:Request,res:Response,next:NextFunction)=>Promise<void>) {
  return (req:Request,res:Response,next:NextFunction) => { void handler(req,res,next).catch(next); };
}

const studentSchema=z.object({
  admissionNumber:z.string().trim().min(1).max(40),
  fullName:z.string().trim().min(2).max(160),
  className:z.string().trim().max(80).optional(),
  guardianName:z.string().trim().max(160).optional(),
  guardianPhone:z.string().trim().max(40).optional(),
});
operationsRouter.get('/students',requirePermission('students.read'),wrap(async(req,res)=>{
  const auth=authContext(req); const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,100):'';
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT id,admission_number,full_name,class_name,guardian_name,guardian_phone,status,created_at
     FROM students WHERE school_id=$1 AND ($2='' OR admission_number ILIKE '%'||$2||'%' OR full_name ILIKE '%'||$2||'%')
     ORDER BY full_name LIMIT 500`,[auth.schoolId,q]));
  res.json({students:result.rows});
}));
operationsRouter.post('/students',requirePermission('students.manage'),wrap(async(req,res)=>{
  const parsed=studentSchema.safeParse(req.body); if(!parsed.success){res.status(400).json({error:'Invalid student details.',details:parsed.error.flatten()});return;}
  const auth=authContext(req); const d=parsed.data;
  const student=await withSchoolTransaction(auth.schoolId,async c=>{
    const r=await c.query(
      'INSERT INTO students (school_id,admission_number,full_name,class_name,guardian_name,guardian_phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,admission_number,full_name,class_name,status,created_at',
      [auth.schoolId,d.admissionNumber,d.fullName,d.className??null,d.guardianName??null,d.guardianPhone??null]);
    await audit(c,auth.schoolId,auth.userId,'student.create','student',r.rows[0].id);
    return r.rows[0];
  });
  res.status(201).json({student});
}));

const invoiceSchema=z.object({
  studentId:z.string().uuid(), invoiceNumber:z.string().trim().min(1).max(60),
  academicYear:z.string().trim().min(2).max(30), description:z.string().trim().min(2).max(500),
  issuedOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount:z.string(),
});
operationsRouter.get('/fees/invoices',requirePermission('fees.read'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT i.id,i.invoice_number,i.student_id,s.admission_number,s.full_name AS student_name,
      i.academic_year,i.description,i.issued_on,i.due_on,i.amount::text,i.status,
      COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated
     FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
     WHERE i.school_id=$1 ORDER BY i.issued_on DESC,i.invoice_number DESC LIMIT 500`,[auth.schoolId]));
  res.json({invoices:result.rows});
}));
operationsRouter.post('/fees/invoices',requirePermission('fees.manage'),wrap(async(req,res)=>{
  const parsed=invoiceSchema.safeParse(req.body); if(!parsed.success){res.status(400).json({error:'Invalid invoice details.',details:parsed.error.flatten()});return;}
  const d=parsed.data; const auth=authContext(req); const issuedOn=d.issuedOn??new Date().toISOString().slice(0,10);
  const minor=parseKesToMinorUnits(d.amount); if(minor<=0n){res.status(422).json({error:'Invoice amount must be greater than zero.'});return;}
  if(d.dueOn<issuedOn){res.status(422).json({error:'Due date cannot be before issue date.'});return;}
  try {
    const invoice=await withSchoolTransaction(auth.schoolId,async c=>{
      const student=await c.query("SELECT id FROM students WHERE school_id=$1 AND id=$2 AND status='active'",[auth.schoolId,d.studentId]);
      if(!student.rowCount) throw Object.assign(new Error('Active student not found in this school.'),{statusCode:422});
      const id=randomUUID();
      await c.query(
        "INSERT INTO fee_invoices (id,school_id,student_id,invoice_number,academic_year,description,issued_on,due_on,amount,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',$10)",
        [id,auth.schoolId,d.studentId,d.invoiceNumber,d.academicYear,d.description,issuedOn,d.dueOn,amountString(minor),auth.userId]);
      const journal=await postJournal(c,auth.schoolId,auth.userId,issuedOn,`Fee invoice ${d.invoiceNumber}: ${d.description}`,'fee_invoice',id,[
        {accountCode:'1200',debit:amountString(minor),credit:'0.00'},
        {accountCode:'4000',debit:'0.00',credit:amountString(minor)},
      ]);
      await audit(c,auth.schoolId,auth.userId,'fee.invoice.issue','fee_invoice',id,{invoiceNumber:d.invoiceNumber,journalEntryId:journal.id,amount:amountString(minor)});
      return {id,invoiceNumber:d.invoiceNumber,studentId:d.studentId,issuedOn,dueOn:d.dueOn,amount:amountString(minor),status:'issued',journalEntryId:journal.id};
    });
    res.status(201).json({invoice});
  } catch(error){if(!handleError(res,error))throw error;}
}));

const receiptSchema=z.object({
  studentId:z.string().uuid(),receiptNumber:z.string().trim().min(1).max(60),
  receivedOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount:z.string(),paymentMethod:z.enum(['cash','bank','mpesa','cheque','other']),
  externalReference:z.string().trim().max(160).optional(),
  notes:z.string().trim().max(500).optional(),
  allocations:z.array(z.object({invoiceId:z.string().uuid(),amount:z.string()})).min(1).max(100),
});
operationsRouter.post('/fees/receipts',requirePermission('receipts.create'),wrap(async(req,res)=>{
  const parsed=receiptSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid receipt details.',details:parsed.error.flatten()});return;}
  const d=parsed.data;const auth=authContext(req);const receivedOn=d.receivedOn??new Date().toISOString().slice(0,10);
  const amount=parseKesToMinorUnits(d.amount);const allocationTotal=d.allocations.reduce((sum,a)=>sum+parseKesToMinorUnits(a.amount),0n);
  if(amount<=0n||allocationTotal!==amount){res.status(422).json({error:'Receipt amount must be positive and fully allocated to invoices.'});return;}
  try{
    const receipt=await withSchoolTransaction(auth.schoolId,async c=>{
      const student=await c.query("SELECT id FROM students WHERE school_id=$1 AND id=$2 AND status='active'",[auth.schoolId,d.studentId]);
      if(!student.rowCount)throw Object.assign(new Error('Active student not found in this school.'),{statusCode:422});
      const receiptId=randomUUID();
      await c.query(
        "INSERT INTO fee_receipts (id,school_id,receipt_number,student_id,received_on,amount,payment_method,external_reference,notes,received_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [receiptId,auth.schoolId,d.receiptNumber,d.studentId,receivedOn,amountString(amount),d.paymentMethod,d.externalReference??null,d.notes??null,auth.userId]);
      for(const allocation of d.allocations){
        const allocated=parseKesToMinorUnits(allocation.amount);
        if(allocated<=0n)throw Object.assign(new Error('Each allocation must be greater than zero.'),{statusCode:422});
        const inv=await c.query(
          `SELECT i.amount::text,i.student_id,i.status,
             COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated
           FROM fee_invoices i WHERE i.school_id=$1 AND i.id=$2 FOR UPDATE`,[auth.schoolId,allocation.invoiceId]);
        if(!inv.rowCount||inv.rows[0].student_id!==d.studentId||inv.rows[0].status==='void')throw Object.assign(new Error('An allocated invoice is missing, void, or belongs to another student.'),{statusCode:422});
        const outstanding=parseKesToMinorUnits(String(inv.rows[0].amount))-parseKesToMinorUnits(String(inv.rows[0].allocated));
        if(allocated>outstanding)throw Object.assign(new Error('Allocation exceeds the invoice outstanding balance.'),{statusCode:422});
        await c.query('INSERT INTO fee_receipt_allocations (school_id,receipt_id,invoice_id,amount) VALUES ($1,$2,$3,$4)',[auth.schoolId,receiptId,allocation.invoiceId,amountString(allocated)]);
      }
      const cashCode=d.paymentMethod==='cash'?'1000':'1100';
      const journal=await postJournal(c,auth.schoolId,auth.userId,receivedOn,`Fee receipt ${d.receiptNumber}`,'fee_receipt',receiptId,[
        {accountCode:cashCode,debit:amountString(amount),credit:'0.00'},
        {accountCode:'1200',debit:'0.00',credit:amountString(amount)},
      ]);
      await c.query('UPDATE fee_receipts SET journal_entry_id=$3 WHERE school_id=$1 AND id=$2',[auth.schoolId,receiptId,journal.id]);
      await c.query(
        `UPDATE fee_invoices i SET status=CASE
          WHEN COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)>=i.amount THEN 'paid'
          WHEN COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)>0 THEN 'part_paid'
          ELSE 'issued' END
         WHERE i.school_id=$1 AND i.id=ANY($2::uuid[])`,
        [auth.schoolId,d.allocations.map(a=>a.invoiceId)]);
      await audit(c,auth.schoolId,auth.userId,'fee.receipt.post','fee_receipt',receiptId,{receiptNumber:d.receiptNumber,journalEntryId:journal.id,amount:amountString(amount)});
      return {id:receiptId,receiptNumber:d.receiptNumber,studentId:d.studentId,receivedOn,amount:amountString(amount),paymentMethod:d.paymentMethod,status:'posted',journalEntryId:journal.id};
    });
    res.status(201).json({receipt});
  }catch(error){if(!handleError(res,error))throw error;}
}));

const expenseSchema=z.object({
  expenseNumber:z.string().trim().min(1).max(60),supplierId:z.string().uuid().optional(),
  expenseAccountId:z.string().uuid(),category:z.string().trim().min(2).max(100),
  description:z.string().trim().min(3).max(500),incurredOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount:z.string(),
});
operationsRouter.get('/expenses',requirePermission('expenses.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT e.id,e.expense_number,e.category,e.description,e.incurred_on,e.amount::text,e.status,
      e.supplier_id,s.name AS supplier_name,e.requested_by,e.approved_by,e.approved_at,e.paid_at,
      e.journal_entry_id,e.payment_journal_entry_id
     FROM expenses e LEFT JOIN suppliers s ON s.id=e.supplier_id AND s.school_id=e.school_id
     WHERE e.school_id=$1 ORDER BY e.created_at DESC LIMIT 500`,[auth.schoolId]));
  res.json({expenses:result.rows});
}));
operationsRouter.post('/expenses',requirePermission('expenses.create'),wrap(async(req,res)=>{
  const parsed=expenseSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid expense details.',details:parsed.error.flatten()});return;}
  const d=parsed.data;const auth=authContext(req);const amount=parseKesToMinorUnits(d.amount);if(amount<=0n){res.status(422).json({error:'Expense amount must be positive.'});return;}
  try{
    const expense=await withSchoolTransaction(auth.schoolId,async c=>{
      const account=await c.query("SELECT id FROM accounts WHERE school_id=$1 AND id=$2 AND account_type='expense' AND is_active=true",[auth.schoolId,d.expenseAccountId]);
      if(!account.rowCount)throw Object.assign(new Error('Choose an active expense ledger account in this school.'),{statusCode:422});
      const id=randomUUID();
      await c.query(
        "INSERT INTO expenses (id,school_id,expense_number,supplier_id,category,description,incurred_on,amount,status,requested_by,expense_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted',$9,$10)",
        [id,auth.schoolId,d.expenseNumber,d.supplierId??null,d.category,d.description,d.incurredOn??new Date().toISOString().slice(0,10),amountString(amount),auth.userId,d.expenseAccountId]);
      await audit(c,auth.schoolId,auth.userId,'expense.submit','expense',id,{expenseNumber:d.expenseNumber,amount:amountString(amount)});
      return {id,expenseNumber:d.expenseNumber,amount:amountString(amount),status:'submitted'};
    });
    res.status(201).json({expense});
  }catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.post('/expenses/:id/submit',requirePermission('expenses.create'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid expense ID.'});return;}
  const auth=authContext(req);
  try{
    const expense=await withSchoolTransaction(auth.schoolId,async c=>{
      const found=await c.query('SELECT id,status FROM expenses WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,id.data]);
      if(!found.rowCount||found.rows[0].status!=='draft')throw Object.assign(new Error('Only a synced draft can be submitted for approval.'),{statusCode:409});
      await c.query("UPDATE expenses SET status='submitted' WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data]);
      await audit(c,auth.schoolId,auth.userId,'expense.submit.synced_draft','expense',id.data);
      return {id:id.data,status:'submitted'};
    });
    res.json({expense});
  }catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.post('/expenses/:id/approve',requirePermission('expenses.approve'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid expense ID.'});return;}
  const auth=authContext(req);
  try{
    const expense=await withSchoolTransaction(auth.schoolId,async c=>{
      const found=await c.query("SELECT * FROM expenses WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);
      if(!found.rowCount||found.rows[0].status!=='submitted')throw Object.assign(new Error('Only a submitted expense can be approved.'),{statusCode:409});
      const e=found.rows[0];const amount=parseKesToMinorUnits(String(e.amount));
      const journal=await postJournal(c,auth.schoolId,auth.userId,String(e.incurred_on).slice(0,10),`Expense ${e.expense_number}: ${e.description}`,'expense_approval',id.data,[
        {accountId:e.expense_account_id,debit:amountString(amount),credit:'0.00'},
        {accountCode:'2000',debit:'0.00',credit:amountString(amount)},
      ]);
      await c.query("UPDATE expenses SET status='approved',approved_by=$3,approved_at=now(),journal_entry_id=$4 WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data,auth.userId,journal.id]);
      await audit(c,auth.schoolId,auth.userId,'expense.approve','expense',id.data,{journalEntryId:journal.id});
      return {id:id.data,status:'approved',journalEntryId:journal.id};
    });
    res.json({expense});
  }catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.post('/expenses/:id/pay',requirePermission('expenses.pay'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);const body=z.object({paymentAccountId:z.string().uuid(),paidOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).safeParse(req.body);
  if(!id.success||!body.success){res.status(400).json({error:'Invalid payment details.'});return;}
  const auth=authContext(req);const paidOn=body.data.paidOn??new Date().toISOString().slice(0,10);
  try{
    const expense=await withSchoolTransaction(auth.schoolId,async c=>{
      const found=await c.query("SELECT * FROM expenses WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);
      if(!found.rowCount||found.rows[0].status!=='approved')throw Object.assign(new Error('Only an approved expense can be paid.'),{statusCode:409});
      const e=found.rows[0];const account=await c.query("SELECT id,account_type FROM accounts WHERE school_id=$1 AND id=$2 AND is_active=true",[auth.schoolId,body.data.paymentAccountId]);
      if(!account.rowCount||!['asset'].includes(account.rows[0].account_type))throw Object.assign(new Error('Select an active cash or bank asset account.'),{statusCode:422});
      const amount=parseKesToMinorUnits(String(e.amount));
      const journal=await postJournal(c,auth.schoolId,auth.userId,paidOn,`Expense payment ${e.expense_number}`,'expense_payment',id.data,[
        {accountCode:'2000',debit:amountString(amount),credit:'0.00'},
        {accountId:body.data.paymentAccountId,debit:'0.00',credit:amountString(amount)},
      ]);
      await c.query("UPDATE expenses SET status='paid',paid_at=now(),payment_journal_entry_id=$3 WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data,journal.id]);
      await audit(c,auth.schoolId,auth.userId,'expense.pay','expense',id.data,{journalEntryId:journal.id,paymentAccountId:body.data.paymentAccountId});
      return {id:id.data,status:'paid',paymentJournalEntryId:journal.id};
    });
    res.json({expense});
  }catch(error){if(!handleError(res,error))throw error;}
}));

const bankAccountSchema=z.object({name:z.string().trim().min(2).max(120),bankName:z.string().trim().min(2).max(120),accountNumberMasked:z.string().trim().max(40).optional(),ledgerAccountId:z.string().uuid()});
operationsRouter.post('/bank/accounts',requirePermission('bank.manage'),wrap(async(req,res)=>{
  const p=bankAccountSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Invalid bank account details.',details:p.error.flatten()});return;}
  const auth=authContext(req);const d=p.data;
  const account=await withSchoolTransaction(auth.schoolId,async c=>{
    const ledger=await c.query("SELECT id,account_type FROM accounts WHERE school_id=$1 AND id=$2 AND is_active=true",[auth.schoolId,d.ledgerAccountId]);
    if(!ledger.rowCount||ledger.rows[0].account_type!=='asset')throw Object.assign(new Error('Bank account must map to an active asset ledger account.'),{statusCode:422});
    const r=await c.query('INSERT INTO bank_accounts (school_id,name,bank_name,account_number_masked,ledger_account_id) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,bank_name,account_number_masked,ledger_account_id,is_active',[auth.schoolId,d.name,d.bankName,d.accountNumberMasked??null,d.ledgerAccountId]);
    await audit(c,auth.schoolId,auth.userId,'bank.account.create','bank_account',r.rows[0].id);
    return r.rows[0];
  });
  res.status(201).json({account});
}));
operationsRouter.get('/bank/accounts',requirePermission('bank.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    'SELECT id,name,bank_name,account_number_masked,ledger_account_id,is_active FROM bank_accounts WHERE school_id=$1 ORDER BY name',[auth.schoolId]));
  res.json({accounts:result.rows});
}));

function parseCsvLine(line:string):string[]{
  const out:string[]=[];let field='';let quoted=false;
  for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'&&quoted&&line[i+1]==='"'){field+='"';i++;}else if(ch==='"'){quoted=!quoted;}else if(ch===','&&!quoted){out.push(field);field='';}else{field+=ch;}}
  if(quoted)throw Object.assign(new Error('CSV contains an unterminated quoted field.'),{statusCode:400});
  out.push(field);return out;
}
operationsRouter.post('/bank/accounts/:id/import',requirePermission('bank.reconcile'),wrap(async(req,res)=>{
  const params=z.string().uuid().safeParse(req.params.id);const body=z.object({csv:z.string().min(1).max(250_000)}).safeParse(req.body);
  if(!params.success||!body.success){res.status(400).json({error:'Provide a bank account ID and CSV content under 250 KB.'});return;}
  const rawLines=body.data.csv.replace(/^\uFEFF/,'').split(/\r?\n/).filter(l=>l.trim()!=='');
  if(rawLines.length<2||rawLines.length>2001){res.status(400).json({error:'CSV must contain a header and 1–2000 statement rows.'});return;}
  try{
    const headers=parseCsvLine(rawLines[0]).map(h=>h.trim().toLowerCase());
    const required=['date','description','amount'];if(required.some(h=>!headers.includes(h))){res.status(400).json({error:'CSV headers must include date, description, amount; reference is optional.'});return;}
    const idx={date:headers.indexOf('date'),description:headers.indexOf('description'),amount:headers.indexOf('amount'),reference:headers.indexOf('reference')};
    const rows=rawLines.slice(1).map((line,i)=>{
      const cells=parseCsvLine(line);const date=cells[idx.date]?.trim()??'';const description=(cells[idx.description]??'').trim();const amount=(cells[idx.amount]??'').trim();const reference=idx.reference>=0?(cells[idx.reference]??'').trim():null;
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!description||description.length>500||!amount)throw Object.assign(new Error(`Invalid CSV row ${i+2}.`),{statusCode:400});
      const signed=amount.startsWith('-')?-parseKesToMinorUnits(amount.slice(1)):parseKesToMinorUnits(amount.startsWith('+')?amount.slice(1):amount);
      if(signed===0n)throw Object.assign(new Error(`CSV row ${i+2} has a zero amount.`),{statusCode:400});
      return {date,description,amount:amountString(signed),reference,hash:createHash('sha256').update([date,description,reference??'',amountString(signed)].join('|')).digest('hex')};
    });
    const auth=authContext(req);const result=await withSchoolTransaction(auth.schoolId,async c=>{
      const bank=await c.query('SELECT id FROM bank_accounts WHERE school_id=$1 AND id=$2 AND is_active=true',[auth.schoolId,params.data]);
      if(!bank.rowCount)throw Object.assign(new Error('Active bank account not found.'),{statusCode:404});
      let imported=0,duplicates=0;
      for(const row of rows){const r=await c.query(
        'INSERT INTO bank_statement_lines (school_id,bank_account_id,transaction_date,description,reference,amount,imported_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (school_id,bank_account_id,imported_hash) DO NOTHING RETURNING id',
        [auth.schoolId,params.data,row.date,row.description,row.reference,row.amount,row.hash]);
        if(r.rowCount)imported++;else duplicates++;
      }
      await audit(c,auth.schoolId,auth.userId,'bank.statement.import','bank_account',params.data,{imported,duplicates});
      return {imported,duplicates,total:rows.length};
    });
    res.status(200).json(result);
  }catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.get('/bank/accounts/:id/statement-lines',requirePermission('bank.read'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid bank account ID.'});return;}
  const auth=authContext(req);const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    'SELECT id,transaction_date,description,reference,amount::text,matched_journal_line_id,matched_at FROM bank_statement_lines WHERE school_id=$1 AND bank_account_id=$2 ORDER BY transaction_date DESC LIMIT 2000',[auth.schoolId,id.data]));
  res.json({lines:result.rows});
}));
operationsRouter.post('/bank/reconcile',requirePermission('bank.reconcile'),wrap(async(req,res)=>{
  const p=z.object({statementLineId:z.string().uuid(),journalLineId:z.string().uuid()}).safeParse(req.body);
  if(!p.success){res.status(400).json({error:'Invalid reconciliation match.'});return;}
  const auth=authContext(req);
  try{
    const result=await withSchoolTransaction(auth.schoolId,async c=>{
      const stmt=await c.query('SELECT * FROM bank_statement_lines WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,p.data.statementLineId]);
      const jl=await c.query('SELECT l.*,j.posting_date,j.status FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.school_id=l.school_id WHERE l.school_id=$1 AND l.id=$2',[auth.schoolId,p.data.journalLineId]);
      if(!stmt.rowCount||!jl.rowCount)throw Object.assign(new Error('Statement line or ledger line was not found in this school.'),{statusCode:404});
      const s=stmt.rows[0],l=jl.rows[0];
      const bank=await c.query('SELECT ledger_account_id FROM bank_accounts WHERE school_id=$1 AND id=$2',[auth.schoolId,s.bank_account_id]);
      if(s.matched_at||l.status!=='posted'||l.account_id!==bank.rows[0]?.ledger_account_id)throw Object.assign(new Error('Only an unmatched statement line and a posted ledger line for the mapped bank account can be reconciled.'),{statusCode:409});
      const ledgerMinor=parseKesToMinorUnits(String(l.debit))-parseKesToMinorUnits(String(l.credit));
      const statementRaw=String(s.amount);const statementMinor=statementRaw.startsWith('-')?-parseKesToMinorUnits(statementRaw.slice(1)):parseKesToMinorUnits(statementRaw);
      if(ledgerMinor!==statementMinor)throw Object.assign(new Error('Statement amount does not equal the selected ledger line.'),{statusCode:422});
      await c.query('UPDATE bank_statement_lines SET matched_journal_line_id=$3,matched_at=now(),matched_by=$4 WHERE school_id=$1 AND id=$2',[auth.schoolId,s.id,l.id,auth.userId]);
      await audit(c,auth.schoolId,auth.userId,'bank.statement.match','bank_statement_line',s.id,{journalLineId:l.id});
      return {matched:true,statementLineId:s.id,journalLineId:l.id};
    });
    res.json(result);
  }catch(error){if(!handleError(res,error))throw error;}
}));


const syncSchema=z.object({mutations:z.array(z.object({
  clientMutationId:z.string().uuid(),
  type:z.literal('expense.draft'),
  payload:expenseSchema,
})).min(1).max(50)});
operationsRouter.post('/sync/push',requirePermission('expenses.create'),wrap(async(req,res)=>{
  const parsed=syncSchema.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:'Invalid offline sync batch.',details:parsed.error.flatten()});return;}
  const auth=authContext(req);
  const results=[];
  for(const mutation of parsed.data.mutations){
    const requestHash=createHash('sha256').update(JSON.stringify({type:mutation.type,payload:mutation.payload})).digest('hex');
    try{
      const outcome=await withSchoolTransaction(auth.schoolId,async c=>{
        const existing=await c.query('SELECT request_hash,response_body,resource_id FROM offline_sync_receipts WHERE school_id=$1 AND client_mutation_id=$2 FOR UPDATE',[auth.schoolId,mutation.clientMutationId]);
        if(existing.rowCount){
          const row=existing.rows[0];
          if(row.request_hash!==requestHash)return {status:'conflict',clientMutationId:mutation.clientMutationId,reason:'This mutation ID was already used for different content.'};
          return {...(row.response_body as Record<string,unknown>),duplicate:true,clientMutationId:mutation.clientMutationId};
        }
        const d=mutation.payload;const amount=parseKesToMinorUnits(d.amount);
        if(amount<=0n)return {status:'rejected',clientMutationId:mutation.clientMutationId,reason:'Expense amount must be greater than zero.'};
        const account=await c.query("SELECT id FROM accounts WHERE school_id=$1 AND id=$2 AND account_type='expense' AND is_active=true",[auth.schoolId,d.expenseAccountId]);
        if(!account.rowCount)return {status:'conflict',clientMutationId:mutation.clientMutationId,reason:'The selected expense account is no longer available.'};
        const id=randomUUID();
        await c.query(
          "INSERT INTO expenses (id,school_id,expense_number,supplier_id,category,description,incurred_on,amount,status,requested_by,expense_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10)",
          [id,auth.schoolId,d.expenseNumber,d.supplierId??null,d.category,d.description,d.incurredOn??new Date().toISOString().slice(0,10),amountString(amount),auth.userId,d.expenseAccountId]);
        const response={status:'accepted',clientMutationId:mutation.clientMutationId,serverId:id,resourceType:'expense',serverState:'draft'};
        await c.query(
          'INSERT INTO offline_sync_receipts (school_id,client_mutation_id,request_hash,resource_type,resource_id,response_body,created_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)',
          [auth.schoolId,mutation.clientMutationId,requestHash,'expense',id,JSON.stringify(response),auth.userId]);
        await audit(c,auth.schoolId,auth.userId,'offline.expense.draft.sync','expense',id,{clientMutationId:mutation.clientMutationId});
        return response;
      });
      results.push(outcome);
    }catch(error){
      const e=error as {code?:string};
      if(e.code==='23505')results.push({status:'conflict',clientMutationId:mutation.clientMutationId,reason:'An expense with this reference already exists. Review it before retrying.'});
      else throw error;
    }
  }
  res.json({results,serverAcceptedOnly:true,message:'Offline sync creates drafts only. No financial posting occurs until an authorized online user reviews and submits the expense.'});
}));


operationsRouter.get('/overview',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const data=await withSchoolTransaction(auth.schoolId,async c=>{
    const fees=await c.query(
      `SELECT COALESCE((SELECT sum(amount) FROM fee_receipts WHERE school_id=$1 AND status='posted'),0)::text AS collected,
       COALESCE((SELECT sum(i.amount-COALESCE(a.allocated,0)) FROM fee_invoices i LEFT JOIN
        (SELECT invoice_id,sum(a.amount) AS allocated FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=$1 AND r.status='posted' GROUP BY invoice_id) a ON a.invoice_id=i.id
        WHERE i.school_id=$1 AND i.status<>'void'),0)::text AS outstanding`,[auth.schoolId]);
    const expenses=await c.query(
      `SELECT count(*) FILTER (WHERE status='submitted')::int AS awaiting_approval,
       count(*) FILTER (WHERE status='approved')::int AS approved_unpaid,
       COALESCE(sum(amount) FILTER (WHERE status='paid'),0)::text AS paid_total FROM expenses WHERE school_id=$1`,[auth.schoolId]);
    const bank=await c.query("SELECT count(*)::int AS unmatched FROM bank_statement_lines WHERE school_id=$1 AND matched_at IS NULL",[auth.schoolId]);
    const journals=await c.query("SELECT count(*)::int AS posted_count FROM journal_entries WHERE school_id=$1 AND status='posted'",[auth.schoolId]);
    return {fees:fees.rows[0],expenses:expenses.rows[0],unmatchedBankLines:bank.rows[0].unmatched,postedJournals:journals.rows[0].posted_count};
  });
  res.json({schoolId:auth.schoolId,summary:data});
}));

operationsRouter.get('/accounting/periods',requirePermission('ledger.read'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT y.id AS financial_year_id,y.name AS financial_year_name,y.starts_on AS year_starts_on,y.ends_on AS year_ends_on,
      p.id AS period_id,p.starts_on,p.ends_on,p.status
     FROM financial_years y JOIN accounting_periods p ON p.school_id=y.school_id AND p.financial_year_id=y.id
     WHERE y.school_id=$1 ORDER BY p.starts_on DESC LIMIT 100`,[auth.schoolId]));
  res.json({periods:result.rows});
}));

operationsRouter.get('/audit-events',requirePermission('audit.read'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    'SELECT id,actor_user_id,action,entity_type,entity_id,request_id,metadata,created_at FROM audit_events WHERE school_id=$1 ORDER BY created_at DESC LIMIT 500',[auth.schoolId]));
  res.json({events:result.rows});
}));

operationsRouter.get('/users',requirePermission('users.manage'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT u.id,u.email,u.full_name,u.status,m.status AS membership_status,r.name AS role,m.created_at
     FROM school_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id AND r.school_id=m.school_id
     WHERE m.school_id=$1 ORDER BY u.full_name LIMIT 500`,[auth.schoolId]));
  res.json({users:result.rows});
}));
const userCreateSchema=z.object({fullName:z.string().trim().min(2).max(160),email:z.string().trim().email().max(254),role:z.enum(['school_admin','bursar','accountant','approver','auditor']),password:z.string().min(12).max(200)});
operationsRouter.post('/users',requirePermission('users.manage'),wrap(async(req,res)=>{
  const p=userCreateSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Invalid user details.',details:p.error.flatten()});return;}
  const auth=authContext(req);const d=p.data;const email=d.email.toLowerCase();
  try{
    const result=await withSchoolTransaction(auth.schoolId,async c=>{
      const role=await c.query('SELECT id FROM roles WHERE school_id=$1 AND name=$2',[auth.schoolId,d.role]);
      if(!role.rowCount)throw Object.assign(new Error('Requested role is not configured for this school.'),{statusCode:422});
      let user=await c.query('SELECT id FROM users WHERE lower(email)=lower($1)',[email]);
      let userId:string;
      if(user.rowCount){userId=String(user.rows[0].id);}
      else{
        const {hashPassword}=await import('./auth.js');
        userId=randomUUID();
        await c.query('INSERT INTO users (id,email,password_hash,full_name,must_change_password) VALUES ($1,$2,$3,$4,true)',[userId,email,await hashPassword(d.password),d.fullName]);
      }
      await c.query("INSERT INTO school_memberships (school_id,user_id,role_id,status) VALUES ($1,$2,$3,'active')",[auth.schoolId,userId,role.rows[0].id]);
      await audit(c,auth.schoolId,auth.userId,'user.membership.create','user',userId,{role:d.role,email});
      return {id:userId,email,role:d.role,membershipStatus:'active',credentialsCreated:!user.rowCount};
    });
    res.status(201).json({user:result,message:result.credentialsCreated?'Account created. Share the initial password securely out of band; change-password enforcement should be enabled before production.':'Existing account added to this school; the existing password remains unchanged.'});
  }catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.get('/reports/trial-balance',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const from=typeof req.query.from==='string'?req.query.from:null;const to=typeof req.query.to==='string'?req.query.to:null;
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT a.id,a.code,a.name,a.account_type,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.debit ELSE 0 END),0)::text AS debit,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.credit ELSE 0 END),0)::text AS credit,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.debit-l.credit ELSE 0 END),0)::text AS net
     FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
     LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
     WHERE a.school_id=$1 AND a.is_active=true
     GROUP BY a.id ORDER BY a.code`,[auth.schoolId,from,to]));
  const rows=result.rows.map(r=>({...r,debit:r.debit??'0.00',credit:r.credit??'0.00',net:r.net??'0.00'}));
  const totals=rows.reduce((acc,r)=>({debit:acc.debit+Number(r.debit),credit:acc.credit+Number(r.credit)}),{debit:0,credit:0});
  res.json({report:'trial-balance',currency:'KES',from,to,rows,totals:{debit:totals.debit.toFixed(2),credit:totals.credit.toFixed(2),balanced:Math.abs(totals.debit-totals.credit)<0.005}});
}));

operationsRouter.get('/reports/income-statement',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const from=typeof req.query.from==='string'?req.query.from:null;const to=typeof req.query.to==='string'?req.query.to:null;
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT a.code,a.name,a.account_type,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.credit-l.debit ELSE 0 END),0)::text AS balance
     FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
     LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
     WHERE a.school_id=$1 AND a.account_type IN ('income','expense')
     GROUP BY a.id ORDER BY a.account_type,a.code`,[auth.schoolId,from,to]));
  const rows=result.rows.map(r=>({...r,balance:r.account_type==='expense'?(-Number(r.balance)).toFixed(2):Number(r.balance).toFixed(2)}));
  const income=rows.filter(r=>r.account_type==='income').reduce((s,r)=>s+Number(r.balance),0);
  const expenses=rows.filter(r=>r.account_type==='expense').reduce((s,r)=>s+Number(r.balance),0);
  res.json({report:'income-statement',currency:'KES',from,to,rows,totals:{income:income.toFixed(2),expenses:expenses.toFixed(2),surplus:(income-expenses).toFixed(2)}});
}));

operationsRouter.get('/reports/fee-balances',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT s.admission_number,s.full_name,i.invoice_number,i.academic_year,i.due_on,i.amount::text,
      COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)::text AS allocated,
      (i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0))::numeric(14,2)::text AS outstanding
     FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
     LEFT JOIN fee_receipt_allocations a ON a.school_id=i.school_id AND a.invoice_id=i.id
     LEFT JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id AND r.status='posted'
     WHERE i.school_id=$1 AND i.status<>'void'
     GROUP BY i.id,s.id HAVING i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)>0
     ORDER BY i.due_on,s.full_name LIMIT 2000`,[auth.schoolId]));
  res.json({report:'fee-balances',currency:'KES',rows:result.rows});
}));

operationsRouter.get('/reports/:report.csv',requirePermission('reports.export'),wrap(async(req,res)=>{
  const name=String(req.params.report);
  if(!['trial-balance','income-statement','fee-balances'].includes(name)){res.status(404).json({error:'Report not found.'});return;}
  const auth=authContext(req);const from=typeof req.query.from==='string'?req.query.from:null;const to=typeof req.query.to==='string'?req.query.to:null;
  let rows:Record<string,unknown>[];
  if(name==='trial-balance'){
    const r=await withSchoolTransaction(auth.schoolId,c=>c.query(
      `SELECT a.code,a.name,a.account_type,COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.debit ELSE 0 END),0)::text AS debit,COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.credit ELSE 0 END),0)::text AS credit
       FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
       LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
        AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
       WHERE a.school_id=$1 GROUP BY a.id ORDER BY a.code`,[auth.schoolId,from,to]));rows=r.rows;
  }else if(name==='income-statement'){
    const r=await withSchoolTransaction(auth.schoolId,c=>c.query(
      `SELECT a.code,a.name,a.account_type,COALESCE(sum(l.credit-l.debit),0)::text AS balance
       FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
       LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
        AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
       WHERE a.school_id=$1 AND a.account_type IN ('income','expense') GROUP BY a.id ORDER BY a.account_type,a.code`,[auth.schoolId,from,to]));rows=r.rows;
  }else{
    const r=await withSchoolTransaction(auth.schoolId,c=>c.query(
      `SELECT s.admission_number,s.full_name,i.invoice_number,i.academic_year,i.due_on,i.amount::text,
       COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)::text AS allocated,
       (i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0))::numeric(14,2)::text AS outstanding
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       LEFT JOIN fee_receipt_allocations a ON a.school_id=i.school_id AND a.invoice_id=i.id
       LEFT JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id
       WHERE i.school_id=$1 AND i.status<>'void' GROUP BY i.id,s.id
       HAVING i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)>0 ORDER BY i.due_on`,[auth.schoolId]));rows=r.rows;
  }
  const keys=rows.length?Object.keys(rows[0]):['no_data'];
  const quote=(v:unknown)=>{const s=String(v??'');return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  const csv=[keys.map(quote).join(','),...rows.map(row=>keys.map(k=>quote(row[k])).join(','))].join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${name}-${new Date().toISOString().slice(0,10)}.csv"`);res.status(200).send(csv);
}));
