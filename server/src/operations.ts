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
async function postJournal(client: any, schoolId:string, userId:string, date:string, description:string, sourceType:string, sourceId:string, postingLines:PostingLine[], reversalOfId?:string) {
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
    "INSERT INTO journal_entries (id,school_id,financial_year_id,period_id,entry_number,posting_date,description,status,source_type,source_id,created_by,reversal_of_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11)",
    [entryId,schoolId,yearId,periodId,entryNumber,date,description,sourceType,sourceId,userId,reversalOfId??null],
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
      COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated,
      (i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0))::numeric(14,2)::text AS outstanding
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

operationsRouter.get('/bank/accounts/:id/match-candidates',requirePermission('bank.read'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid bank account ID.'});return;}
  const auth=authContext(req);
  const data=await withSchoolTransaction(auth.schoolId,async c=>{
    const bank=await c.query('SELECT ledger_account_id FROM bank_accounts WHERE school_id=$1 AND id=$2',[auth.schoolId,id.data]);
    if(!bank.rowCount)throw Object.assign(new Error('Bank account not found.'),{statusCode:404});
    const statement=await c.query('SELECT id,transaction_date,description,reference,amount::text FROM bank_statement_lines WHERE school_id=$1 AND bank_account_id=$2 AND matched_at IS NULL ORDER BY transaction_date DESC LIMIT 500',[auth.schoolId,id.data]);
    const ledger=await c.query(
      `SELECT l.id,l.journal_entry_id,j.entry_number,j.posting_date,j.description,l.debit::text,l.credit::text,l.memo
       FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.school_id=l.school_id
       WHERE l.school_id=$1 AND l.account_id=$2 AND j.status='posted'
       AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.school_id=l.school_id AND b.matched_journal_line_id=l.id)
       ORDER BY j.posting_date DESC,j.entry_number DESC LIMIT 1000`,[auth.schoolId,bank.rows[0].ledger_account_id]);
    return {statementLines:statement.rows,journalLines:ledger.rows};
  });
  res.json(data);
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


operationsRouter.get('/suppliers',requirePermission('expenses.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const r=await withSchoolTransaction(auth.schoolId,c=>c.query('SELECT id,name,phone,email,tax_pin,status FROM suppliers WHERE school_id=$1 ORDER BY name',[auth.schoolId]));res.json({suppliers:r.rows});
}));
operationsRouter.post('/suppliers',requirePermission('expenses.create'),wrap(async(req,res)=>{
  const p=z.object({name:z.string().trim().min(2).max(160),phone:z.string().trim().max(40).optional(),email:z.string().trim().email().max(254).optional(),taxPin:z.string().trim().max(40).optional()}).safeParse(req.body);
  if(!p.success){res.status(400).json({error:'Invalid supplier details.',details:p.error.flatten()});return;}
  const auth=authContext(req);const d=p.data;
  const supplier=await withSchoolTransaction(auth.schoolId,async c=>{const r=await c.query('INSERT INTO suppliers (school_id,name,phone,email,tax_pin) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,phone,email,tax_pin,status',[auth.schoolId,d.name,d.phone??null,d.email??null,d.taxPin??null]);await audit(c,auth.schoolId,auth.userId,'supplier.create','supplier',r.rows[0].id);return r.rows[0];});
  res.status(201).json({supplier});
}));

const waiverSchema=z.object({invoiceId:z.string().uuid(),waiverNumber:z.string().trim().min(1).max(60),amount:z.string(),reason:z.string().trim().min(3).max(500),waivedOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()});
operationsRouter.get('/fees/waivers',requirePermission('fees.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const r=await withSchoolTransaction(auth.schoolId,c=>c.query(
    'SELECT w.id,w.waiver_number,w.invoice_id,i.invoice_number,w.amount::text,w.reason,w.waived_on,w.status,w.journal_entry_id FROM fee_waivers w JOIN fee_invoices i ON i.id=w.invoice_id AND i.school_id=w.school_id WHERE w.school_id=$1 ORDER BY w.created_at DESC LIMIT 500',[auth.schoolId]));
  res.json({waivers:r.rows});
}));
operationsRouter.post('/fees/waivers',requirePermission('fees.manage'),wrap(async(req,res)=>{
  const p=waiverSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Invalid fee waiver details.',details:p.error.flatten()});return;}
  const auth=authContext(req);const d=p.data;const amount=parseKesToMinorUnits(d.amount);const waivedOn=d.waivedOn??todayIso();
  if(amount<=0n){res.status(422).json({error:'Waiver amount must be positive.'});return;}
  try{
    const waiver=await withSchoolTransaction(auth.schoolId,async c=>{
      const inv=await c.query('SELECT id,amount::text,status FROM fee_invoices WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,d.invoiceId]);
      if(!inv.rowCount||inv.rows[0].status==='void')throw Object.assign(new Error('Invoice was not found or has been voided.'),{statusCode:422});
      const settled=await c.query(
        `SELECT COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=$1 AND a.invoice_id=$2 AND r.status='posted'),0)::text AS allocated,
         COALESCE((SELECT sum(amount) FROM fee_waivers WHERE school_id=$1 AND invoice_id=$2 AND status='posted'),0)::text AS waived`,[auth.schoolId,d.invoiceId]);
      const outstanding=parseKesToMinorUnits(String(inv.rows[0].amount))-parseKesToMinorUnits(String(settled.rows[0].allocated))-parseKesToMinorUnits(String(settled.rows[0].waived));
      if(amount>outstanding)throw Object.assign(new Error('Waiver exceeds the invoice outstanding balance.'),{statusCode:422});
      const id=randomUUID();
      await c.query('INSERT INTO fee_waivers (id,school_id,waiver_number,invoice_id,amount,reason,waived_on,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[id,auth.schoolId,d.waiverNumber,d.invoiceId,amountString(amount),d.reason,waivedOn,auth.userId]);
      const journal=await postJournal(c,auth.schoolId,auth.userId,waivedOn,`Fee waiver ${d.waiverNumber}`,'fee_waiver',id,[
        {accountCode:'4200',debit:amountString(amount),credit:'0.00'},
        {accountCode:'1200',debit:'0.00',credit:amountString(amount)},
      ]);
      await c.query('UPDATE fee_waivers SET journal_entry_id=$3 WHERE school_id=$1 AND id=$2',[auth.schoolId,id,journal.id]);
      const totalSettled=amount+parseKesToMinorUnits(String(settled.rows[0].allocated))+parseKesToMinorUnits(String(settled.rows[0].waived));
      await c.query("UPDATE fee_invoices SET status=CASE WHEN $3::numeric >= amount THEN 'paid' WHEN $4::numeric > 0 THEN 'part_paid' ELSE 'issued' END WHERE school_id=$1 AND id=$2",[auth.schoolId,d.invoiceId,amountString(totalSettled),String(settled.rows[0].allocated)]);
      await audit(c,auth.schoolId,auth.userId,'fee.waiver.post','fee_waiver',id,{invoiceId:d.invoiceId,journalEntryId:journal.id,amount:amountString(amount),reason:d.reason});
      return {id,waiverNumber:d.waiverNumber,invoiceId:d.invoiceId,amount:amountString(amount),reason:d.reason,status:'posted',journalEntryId:journal.id};
    });
    res.status(201).json({waiver});
  }catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.post('/ledger/journals/:id/reverse',requirePermission('ledger.post'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);
  const p=z.object({reason:z.string().trim().min(3).max(500),reversalDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).safeParse(req.body);
  if(!id.success||!p.success){res.status(400).json({error:'Provide a journal ID and a reversal reason.'});return;}
  const auth=authContext(req);const reversalDate=p.data.reversalDate??todayIso();
  try{
    const result=await withSchoolTransaction(auth.schoolId,async c=>{
      const original=await c.query('SELECT * FROM journal_entries WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,id.data]);
      if(!original.rowCount||original.rows[0].status!=='posted')throw Object.assign(new Error('Only a posted journal in this school can be reversed.'),{statusCode:422});
      const already=await c.query('SELECT id FROM journal_entries WHERE school_id=$1 AND reversal_of_id=$2',[auth.schoolId,id.data]);
      if(already.rowCount)throw Object.assign(new Error('This journal has already been reversed.'),{statusCode:409});
      const source=String(original.rows[0].source_type);const sourceId=original.rows[0].source_id?String(original.rows[0].source_id):null;
      if(source==='fee_invoice'&&sourceId){
        const settled=await c.query(
          `SELECT (SELECT count(*) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=$1 AND a.invoice_id=$2 AND r.status='posted') AS receipts,
           (SELECT count(*) FROM fee_waivers WHERE school_id=$1 AND invoice_id=$2 AND status='posted') AS waivers`,[auth.schoolId,sourceId]);
        if(Number(settled.rows[0].receipts)>0||Number(settled.rows[0].waivers)>0)throw Object.assign(new Error('Reverse posted receipts and waivers before voiding this invoice.'),{statusCode:409});
      }
      if(source==='expense_approval'&&sourceId){
        const exp=await c.query('SELECT status FROM expenses WHERE school_id=$1 AND id=$2',[auth.schoolId,sourceId]);
        if(exp.rowCount&&exp.rows[0].status==='paid')throw Object.assign(new Error('Reverse the expense payment journal before reversing its approval journal.'),{statusCode:409});
      }
      const originalLines=await c.query('SELECT account_id,debit::text,credit::text,memo FROM journal_lines WHERE school_id=$1 AND journal_entry_id=$2 ORDER BY line_number',[auth.schoolId,id.data]);
      const lines=originalLines.rows.map(l=>({accountId:String(l.account_id),debit:String(l.credit),credit:String(l.debit),memo:l.memo?String(l.memo):undefined}));
      const journal=await postJournal(c,auth.schoolId,auth.userId,reversalDate,`Reversal of ${original.rows[0].entry_number}: ${p.data.reason}`,'reversal',id.data,lines,id.data);
      if(source==='fee_invoice'&&sourceId)await c.query("UPDATE fee_invoices SET status='void' WHERE school_id=$1 AND id=$2",[auth.schoolId,sourceId]);
      if(source==='fee_receipt'&&sourceId){
        await c.query("UPDATE fee_receipts SET status='reversed' WHERE school_id=$1 AND id=$2",[auth.schoolId,sourceId]);
        const invoices=await c.query('SELECT DISTINCT invoice_id FROM fee_receipt_allocations WHERE school_id=$1 AND receipt_id=$2',[auth.schoolId,sourceId]);
        for(const row of invoices.rows){
          const settlement=await c.query(
            `SELECT i.amount::text,
             COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=$1 AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated,
             COALESCE((SELECT sum(amount) FROM fee_waivers WHERE school_id=$1 AND invoice_id=i.id AND status='posted'),0)::text AS waived
             FROM fee_invoices i WHERE i.school_id=$1 AND i.id=$2`,[auth.schoolId,row.invoice_id]);
          if(settlement.rowCount){
            const total=parseKesToMinorUnits(String(settlement.rows[0].allocated))+parseKesToMinorUnits(String(settlement.rows[0].waived));
            const amount=parseKesToMinorUnits(String(settlement.rows[0].amount));
            await c.query("UPDATE fee_invoices SET status=CASE WHEN $3::numeric>=amount THEN 'paid' WHEN $4::numeric>0 THEN 'part_paid' ELSE 'issued' END WHERE school_id=$1 AND id=$2",[auth.schoolId,row.invoice_id,amountString(total),String(settlement.rows[0].allocated)]);
          }
        }
      }
      if(source==='fee_waiver'&&sourceId){
        await c.query("UPDATE fee_waivers SET status='reversed' WHERE school_id=$1 AND id=$2",[auth.schoolId,sourceId]);
        const w=await c.query('SELECT invoice_id FROM fee_waivers WHERE school_id=$1 AND id=$2',[auth.schoolId,sourceId]);
        if(w.rowCount){
          const t=await c.query(
            `SELECT i.amount::text,
             COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=$1 AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated,
             COALESCE((SELECT sum(amount) FROM fee_waivers WHERE school_id=$1 AND invoice_id=i.id AND status='posted'),0)::text AS waived
             FROM fee_invoices i WHERE i.school_id=$1 AND i.id=$2`,[auth.schoolId,w.rows[0].invoice_id]);
          if(t.rowCount){const total=parseKesToMinorUnits(String(t.rows[0].allocated))+parseKesToMinorUnits(String(t.rows[0].waived));await c.query("UPDATE fee_invoices SET status=CASE WHEN $3::numeric>=amount THEN 'paid' WHEN $4::numeric>0 THEN 'part_paid' ELSE 'issued' END WHERE school_id=$1 AND id=$2",[auth.schoolId,w.rows[0].invoice_id,amountString(total),String(t.rows[0].allocated)]);}
        }
      }
      if(source==='expense_payment'&&sourceId)await c.query("UPDATE expenses SET status='approved',paid_at=NULL,payment_journal_entry_id=NULL WHERE school_id=$1 AND id=$2",[auth.schoolId,sourceId]);
      if(source==='expense_approval'&&sourceId)await c.query("UPDATE expenses SET status='rejected' WHERE school_id=$1 AND id=$2",[auth.schoolId,sourceId]);
      await audit(c,auth.schoolId,auth.userId,'ledger.journal.reverse','journal_entry',journal.id,{reversalOf:id.data,reason:p.data.reason});
      return {id:journal.id,entryNumber:journal.entryNumber,reversalOf:id.data,status:'posted',reason:p.data.reason};
    });
    res.status(201).json({reversal:result});
  }catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.post('/accounting/periods/:id/lock',requirePermission('periods.manage'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid accounting period ID.'});return;}
  const auth=authContext(req);
  try{
    const period=await withSchoolTransaction(auth.schoolId,async c=>{
      const r=await c.query("SELECT id,status FROM accounting_periods WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);
      if(!r.rowCount)throw Object.assign(new Error('Accounting period not found.'),{statusCode:404});
      if(r.rows[0].status==='locked')return {id:id.data,status:'locked'};
      const drafts=await c.query("SELECT count(*)::int AS n FROM journal_entries WHERE school_id=$1 AND period_id=$2 AND status='draft'",[auth.schoolId,id.data]);
      if(drafts.rows[0].n>0)throw Object.assign(new Error('Post or discard all draft journals before locking this period.'),{statusCode:409});
      await c.query("UPDATE accounting_periods SET status='locked' WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data]);
      await audit(c,auth.schoolId,auth.userId,'accounting.period.lock','accounting_period',id.data);
      return {id:id.data,status:'locked'};
    });
    res.json({period});
  }catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.post('/accounting/years/:id/close',requirePermission('periods.manage'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid financial year ID.'});return;}
  const auth=authContext(req);
  try{
    const year=await withSchoolTransaction(auth.schoolId,async c=>{
      const r=await c.query("SELECT id,status,name,starts_on,ends_on FROM financial_years WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);
      if(!r.rowCount)throw Object.assign(new Error('Financial year not found.'),{statusCode:404});
      if(r.rows[0].status==='closed')return {id:id.data,status:'closed',closingJournalId:null,openingJournalId:null};
      const periods=await c.query("SELECT id,status,ends_on FROM accounting_periods WHERE school_id=$1 AND financial_year_id=$2 ORDER BY ends_on",[auth.schoolId,id.data]);
      if(!periods.rowCount)throw Object.assign(new Error('The financial year has no accounting periods.'),{statusCode:409});
      const last=periods.rows[periods.rows.length-1];
      if(periods.rows.slice(0,-1).some(p=>p.status!=='locked')||!['open','locked'].includes(last.status))throw Object.assign(new Error('Lock all earlier periods before closing the year. The final period must be open or locked.'),{statusCode:409});
      const drafts=await c.query("SELECT count(*)::int AS n FROM journal_entries WHERE school_id=$1 AND financial_year_id=$2 AND status='draft'",[auth.schoolId,id.data]);
      if(drafts.rows[0].n>0)throw Object.assign(new Error('Post or discard every draft journal before year-end close.'),{statusCode:409});
      const totals=await c.query(
        "SELECT COALESCE(sum(l.debit),0)::text AS debit,COALESCE(sum(l.credit),0)::text AS credit FROM journal_entries j JOIN journal_lines l ON l.school_id=j.school_id AND l.journal_entry_id=j.id WHERE j.school_id=$1 AND j.financial_year_id=$2 AND j.status='posted'",
        [auth.schoolId,id.data]);
      if(parseKesToMinorUnits(String(totals.rows[0].debit))!==parseKesToMinorUnits(String(totals.rows[0].credit)))throw Object.assign(new Error('Trial balance is not balanced. Resolve the difference before closing the year.'),{statusCode:409});
      if(last.status==='locked')await c.query("UPDATE accounting_periods SET status='open' WHERE school_id=$1 AND id=$2",[auth.schoolId,last.id]);
      const balances=await c.query(
        `SELECT a.id,a.account_type,
          COALESCE(sum(l.debit) FILTER (WHERE j.id IS NOT NULL),0)::text AS debit,
          COALESCE(sum(l.credit) FILTER (WHERE j.id IS NOT NULL),0)::text AS credit
         FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
         LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted' AND j.financial_year_id=$2
         WHERE a.school_id=$1 AND a.account_type IN ('income','expense')
         GROUP BY a.id ORDER BY a.code`,[auth.schoolId,id.data]);
      const closingLines:PostingLine[]=[];let totalDebits=0n,totalCredits=0n;
      for(const row of balances.rows){
        const debit=parseKesToMinorUnits(String(row.debit));const credit=parseKesToMinorUnits(String(row.credit));
        if(row.account_type==='income'){
          const balance=credit-debit;
          if(balance>0n){closingLines.push({accountId:String(row.id),debit:amountString(balance),credit:'0.00'});totalDebits+=balance;}
          else if(balance<0n){closingLines.push({accountId:String(row.id),debit:'0.00',credit:amountString(-balance)});totalCredits+=-balance;}
        }else{
          const balance=debit-credit;
          if(balance>0n){closingLines.push({accountId:String(row.id),debit:'0.00',credit:amountString(balance)});totalCredits+=balance;}
          else if(balance<0n){closingLines.push({accountId:String(row.id),debit:amountString(-balance),credit:'0.00'});totalDebits+=-balance;}
        }
      }
      let closingJournalId:string|null=null;
      if(closingLines.length){
        const difference=totalDebits-totalCredits;
        if(difference>0n)closingLines.push({accountCode:'3000',debit:'0.00',credit:amountString(difference)});
        else if(difference<0n)closingLines.push({accountCode:'3000',debit:amountString(-difference),credit:'0.00'});
        const posted=await postJournal(c,auth.schoolId,auth.userId,String(r.rows[0].ends_on).slice(0,10),`Year-end close ${r.rows[0].name}`,'year_end_close',id.data,closingLines);
        closingJournalId=posted.id;
      }
      const nextDates=await c.query("SELECT (ends_on+1)::date::text AS starts_on,((ends_on+1)+interval '1 year'-interval '1 day')::date::text AS ends_on FROM financial_years WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data]);
      const nextStart=String(nextDates.rows[0].starts_on).slice(0,10);const nextEnd=String(nextDates.rows[0].ends_on).slice(0,10);
      let nextYear=await c.query("SELECT id,status,name FROM financial_years WHERE school_id=$1 AND starts_on=$2::date AND ends_on=$3::date FOR UPDATE",[auth.schoolId,nextStart,nextEnd]);
      let nextYearId:string;
      if(nextYear.rowCount){
        if(nextYear.rows[0].status!=='open')throw Object.assign(new Error('The following financial year already exists but is not open.'),{statusCode:409});
        nextYearId=String(nextYear.rows[0].id);
      }else{
        nextYearId=randomUUID();const name=nextStart.slice(0,4)===nextEnd.slice(0,4)?nextStart.slice(0,4):nextStart.slice(0,4)+'/'+nextEnd.slice(0,4);
        await c.query('INSERT INTO financial_years (id,school_id,name,starts_on,ends_on) VALUES ($1,$2,$3,$4,$5)',[nextYearId,auth.schoolId,name,nextStart,nextEnd]);
        await c.query(
          `INSERT INTO accounting_periods (school_id,financial_year_id,starts_on,ends_on)
           SELECT $1,$2,GREATEST($3::date,date_trunc('month',m)::date),LEAST($4::date,(date_trunc('month',m)+interval '1 month - 1 day')::date)
           FROM generate_series(date_trunc('month',$3::date),date_trunc('month',$4::date),interval '1 month') m`,
          [auth.schoolId,nextYearId,nextStart,nextEnd]);
      }
      const existingOpening=await c.query("SELECT id FROM journal_entries WHERE school_id=$1 AND financial_year_id=$2 AND source_type='year_opening' AND source_id=$3 AND status='posted'",[auth.schoolId,nextYearId,id.data]);
      let openingJournalId:string|null=existingOpening.rowCount?String(existingOpening.rows[0].id):null;
      if(!openingJournalId){
        const nextPosted=await c.query("SELECT count(*)::int AS n FROM journal_entries WHERE school_id=$1 AND financial_year_id=$2 AND status='posted'",[auth.schoolId,nextYearId]);
        if(nextPosted.rows[0].n>0)throw Object.assign(new Error('The next financial year already contains postings. Review its opening balances before closing this year.'),{statusCode:409});
        const balanceSheet=await c.query(
          `SELECT a.id,COALESCE(sum(l.debit-l.credit) FILTER (WHERE j.id IS NOT NULL),0)::text AS net
           FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
           LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted' AND j.financial_year_id=$2
           WHERE a.school_id=$1 AND a.account_type IN ('asset','liability','equity')
           GROUP BY a.id ORDER BY a.code`,[auth.schoolId,id.data]);
        const openingLines:PostingLine[]=[];
        for(const row of balanceSheet.rows){
          const rawNet=String(row.net);const net=rawNet.startsWith('-')?-parseKesToMinorUnits(rawNet.slice(1)):parseKesToMinorUnits(rawNet);
          if(net>0n)openingLines.push({accountId:String(row.id),debit:amountString(net),credit:'0.00'});
          else if(net<0n)openingLines.push({accountId:String(row.id),debit:'0.00',credit:amountString(-net)});
        }
        if(openingLines.length){
          const posted=await postJournal(c,auth.schoolId,auth.userId,nextStart,'Opening balances from financial year '+String(r.rows[0].name),'year_opening',id.data,openingLines);
          openingJournalId=posted.id;
        }
      }
      await c.query("UPDATE accounting_periods SET status='locked' WHERE school_id=$1 AND id=$2",[auth.schoolId,last.id]);
      await c.query("UPDATE financial_years SET status='closed' WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data]);
      await audit(c,auth.schoolId,auth.userId,'accounting.year.close','financial_year',id.data,{closingJournalId,openingJournalId,nextFinancialYearId:nextYearId});
      return {id:id.data,status:'closed',closingJournalId,openingJournalId,nextFinancialYearId:nextYearId};
    });
    res.json({financialYear:year});
  }catch(error){if(!handleError(res,error))throw error;}
}));

function todayIso(){return new Date().toISOString().slice(0,10);}


operationsRouter.get('/budgets',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const yearId=typeof req.query.financialYearId==='string'?req.query.financialYearId:null;
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT b.id,b.name,b.financial_year_id,y.name AS financial_year_name,b.account_id,a.code,a.name AS account_name,
      b.budget_amount::text,b.status,b.approved_at,
      COALESCE((SELECT sum(l.debit-l.credit) FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.school_id=l.school_id WHERE l.school_id=b.school_id AND l.account_id=b.account_id AND j.financial_year_id=b.financial_year_id AND j.status='posted'),0)::text AS actual
     FROM budgets b JOIN financial_years y ON y.id=b.financial_year_id AND y.school_id=b.school_id
     JOIN accounts a ON a.id=b.account_id AND a.school_id=b.school_id
     WHERE b.school_id=$1 AND ($2::uuid IS NULL OR b.financial_year_id=$2)
     ORDER BY y.starts_on DESC,a.code,b.name`,[auth.schoolId,yearId]));
  res.json({budgets:result.rows});
}));
operationsRouter.post('/budgets',requirePermission('periods.manage'),wrap(async(req,res)=>{
  const p=z.object({financialYearId:z.string().uuid(),accountId:z.string().uuid(),name:z.string().trim().min(2).max(120),budgetAmount:z.string()}).safeParse(req.body);
  if(!p.success){res.status(400).json({error:'Invalid budget details.',details:p.error.flatten()});return;}
  const auth=authContext(req);const d=p.data;const amount=parseKesToMinorUnits(d.budgetAmount);
  try{
    const budget=await withSchoolTransaction(auth.schoolId,async c=>{
      const year=await c.query("SELECT id FROM financial_years WHERE school_id=$1 AND id=$2 AND status='open'",[auth.schoolId,d.financialYearId]);
      const account=await c.query("SELECT id,account_type FROM accounts WHERE school_id=$1 AND id=$2 AND is_active=true",[auth.schoolId,d.accountId]);
      if(!year.rowCount||!account.rowCount||account.rows[0].account_type!=='expense')throw Object.assign(new Error('Select an open financial year and active expense account.'),{statusCode:422});
      const r=await c.query('INSERT INTO budgets (school_id,financial_year_id,account_id,name,budget_amount) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,financial_year_id,account_id,budget_amount::text,status',[auth.schoolId,d.financialYearId,d.accountId,d.name,amountString(amount)]);
      await audit(c,auth.schoolId,auth.userId,'budget.create','budget',r.rows[0].id);
      return r.rows[0];
    });
    res.status(201).json({budget});
  }catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.post('/budgets/:id/approve',requirePermission('periods.manage'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid budget ID.'});return;}
  const auth=authContext(req);
  try{
    const budget=await withSchoolTransaction(auth.schoolId,async c=>{
      const r=await c.query("SELECT id,status FROM budgets WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);
      if(!r.rowCount||r.rows[0].status!=='draft')throw Object.assign(new Error('Only a draft budget can be approved.'),{statusCode:409});
      await c.query("UPDATE budgets SET status='approved',approved_by=$3,approved_at=now() WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data,auth.userId]);
      await audit(c,auth.schoolId,auth.userId,'budget.approve','budget',id.data);
      return {id:id.data,status:'approved'};
    });
    res.json({budget});
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
      COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)::text AS waived,
      (i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0))::numeric(14,2)::text AS outstanding
     FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
     LEFT JOIN fee_receipt_allocations a ON a.school_id=i.school_id AND a.invoice_id=i.id
     LEFT JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id
     WHERE i.school_id=$1 AND i.status<>'void'
     GROUP BY i.id,s.id HAVING i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)>0
     ORDER BY i.due_on,s.full_name LIMIT 2000`,[auth.schoolId]));
  res.json({report:'fee-balances',currency:'KES',rows:result.rows});
}));


const reportNames=['trial-balance','income-statement','balance-sheet','general-ledger','cashbook','bankbook','receipts-register','invoice-register','fee-balances','fee-aging','expense-register','supplier-payables','bank-reconciliation','budget-variance','journal-register','collections-by-method','fees-by-class','audit-trail'];
async function buildReportRows(c:any,schoolId:string,name:string,from:string|null,to:string|null):Promise<Record<string,unknown>[]>{
  let sql='';
  let params:unknown[]=[schoolId,from,to];
  switch(name){
    case 'trial-balance':
      sql=`SELECT a.code,a.name,a.account_type,
       COALESCE(sum(l.debit) FILTER (WHERE j.id IS NOT NULL),0)::text AS debit,
       COALESCE(sum(l.credit) FILTER (WHERE j.id IS NOT NULL),0)::text AS credit,
       COALESCE(sum(l.debit-l.credit) FILTER (WHERE j.id IS NOT NULL),0)::text AS net
       FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
       LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
       WHERE a.school_id=$1 GROUP BY a.id ORDER BY a.code`;break;
    case 'income-statement':
      sql=`SELECT a.code,a.name,a.account_type,
       COALESCE(sum(CASE WHEN j.id IS NOT NULL AND a.account_type='income' THEN l.credit-l.debit WHEN j.id IS NOT NULL THEN l.debit-l.credit ELSE 0 END),0)::text AS balance
       FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
       LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
       WHERE a.school_id=$1 AND a.account_type IN ('income','expense') GROUP BY a.id ORDER BY a.account_type,a.code`;break;
    case 'balance-sheet':
      sql=`SELECT a.code,a.name,a.account_type,
       COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.debit-l.credit ELSE 0 END),0)::text AS debit_net,
       COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.credit-l.debit ELSE 0 END),0)::text AS credit_net
       FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
       LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
       AND ($2::date IS NULL OR j.posting_date <= $2::date)
       WHERE a.school_id=$1 AND a.account_type IN ('asset','liability','equity') GROUP BY a.id ORDER BY a.account_type,a.code`;break;
    case 'general-ledger':
      sql=`SELECT j.entry_number,j.posting_date,j.description AS journal_description,a.code,a.name AS account_name,l.debit::text,l.credit::text,l.memo
       FROM journal_entries j JOIN journal_lines l ON l.school_id=j.school_id AND l.journal_entry_id=j.id
       JOIN accounts a ON a.school_id=l.school_id AND a.id=l.account_id
       WHERE j.school_id=$1 AND j.status='posted' AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
       ORDER BY j.posting_date,j.entry_number,l.line_number LIMIT 10000`;break;
    case 'cashbook':
    case 'bankbook':
      sql=`SELECT j.posting_date,j.entry_number,j.description,a.code,a.name,l.debit::text,l.credit::text,l.memo
       FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.school_id=l.school_id
       JOIN journal_entries j ON j.id=l.journal_entry_id AND j.school_id=l.school_id
       WHERE l.school_id=$1 AND j.status='posted' AND a.code=${name==='cashbook'?"'1000'":"'1100'"}
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
       ORDER BY j.posting_date,j.entry_number LIMIT 10000`;break;
    case 'receipts-register':
      sql=`SELECT r.receipt_number,r.received_on,s.admission_number,s.full_name AS student,r.amount::text,r.payment_method,r.external_reference,r.status
       FROM fee_receipts r JOIN students s ON s.id=r.student_id AND s.school_id=r.school_id
       WHERE r.school_id=$1 AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)
       ORDER BY r.received_on DESC,r.receipt_number LIMIT 5000`;break;
    case 'invoice-register':
      sql=`SELECT i.invoice_number,i.issued_on,i.due_on,s.admission_number,s.full_name AS student,i.academic_year,i.amount::text,i.status
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date)
       ORDER BY i.issued_on DESC,i.invoice_number LIMIT 5000`;break;
    case 'fee-balances':
      sql=`SELECT s.admission_number,s.full_name,i.invoice_number,i.academic_year,i.issued_on,i.due_on,i.amount::text,
       COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated,
       COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)::text AS waived,
       (i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0))::numeric(14,2)::text AS outstanding
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date)
       ORDER BY i.due_on,s.full_name LIMIT 5000`;break;
    case 'fee-aging':
      sql=`SELECT s.admission_number,s.full_name,i.invoice_number,i.due_on,
       (CURRENT_DATE-i.due_on)::int AS days_overdue,
       (i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0))::numeric(14,2)::text AS outstanding
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND i.status<>'void' AND i.due_on<CURRENT_DATE
       ORDER BY i.due_on,s.full_name LIMIT 5000`;break;
    case 'expense-register':
      sql=`SELECT e.expense_number,e.incurred_on,e.category,e.description,e.amount::text,e.status,s.name AS supplier
       FROM expenses e LEFT JOIN suppliers s ON s.id=e.supplier_id AND s.school_id=e.school_id
       WHERE e.school_id=$1 AND ($2::date IS NULL OR e.incurred_on >= $2::date) AND ($3::date IS NULL OR e.incurred_on <= $3::date)
       ORDER BY e.incurred_on DESC,e.expense_number LIMIT 5000`;break;
    case 'supplier-payables':
      sql=`SELECT COALESCE(s.name,'Unspecified supplier') AS supplier,e.expense_number,e.description,e.incurred_on,e.amount::text,e.status
       FROM expenses e LEFT JOIN suppliers s ON s.id=e.supplier_id AND s.school_id=e.school_id
       WHERE e.school_id=$1 AND e.status='approved' ORDER BY e.incurred_on,e.expense_number LIMIT 5000`;break;
    case 'bank-reconciliation':
      sql=`SELECT b.name AS bank_account,l.transaction_date,l.description,l.reference,l.amount::text,l.matched_at,l.matched_journal_line_id
       FROM bank_statement_lines l JOIN bank_accounts b ON b.id=l.bank_account_id AND b.school_id=l.school_id
       WHERE l.school_id=$1 AND ($2::date IS NULL OR l.transaction_date >= $2::date) AND ($3::date IS NULL OR l.transaction_date <= $3::date)
       ORDER BY l.transaction_date DESC LIMIT 5000`;break;
    case 'budget-variance':
      sql=`SELECT y.name AS financial_year,a.code,a.name AS account,b.name AS budget_name,b.budget_amount::text,
       COALESCE((SELECT sum(l.debit-l.credit) FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.school_id=l.school_id WHERE l.school_id=b.school_id AND l.account_id=b.account_id AND j.financial_year_id=b.financial_year_id AND j.status='posted'),0)::text AS actual,
       (b.budget_amount-COALESCE((SELECT sum(l.debit-l.credit) FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.school_id=l.school_id WHERE l.school_id=b.school_id AND l.account_id=b.account_id AND j.financial_year_id=b.financial_year_id AND j.status='posted'),0))::numeric(14,2)::text AS remaining,b.status
       FROM budgets b JOIN financial_years y ON y.id=b.financial_year_id AND y.school_id=b.school_id JOIN accounts a ON a.id=b.account_id AND a.school_id=b.school_id
       WHERE b.school_id=$1 ORDER BY y.starts_on DESC,a.code`;break;
    case 'journal-register':
      sql=`SELECT j.entry_number,j.posting_date,j.description,j.source_type,j.source_id,j.status,j.posted_at,
       COALESCE(sum(l.debit),0)::text AS total_debit,COALESCE(sum(l.credit),0)::text AS total_credit
       FROM journal_entries j LEFT JOIN journal_lines l ON l.school_id=j.school_id AND l.journal_entry_id=j.id
       WHERE j.school_id=$1 AND j.status='posted' AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
       GROUP BY j.id ORDER BY j.posting_date DESC,j.entry_number DESC LIMIT 5000`;break;
    case 'collections-by-method':
      sql=`SELECT payment_method,count(*)::int AS receipt_count,sum(amount)::text AS collected
       FROM fee_receipts WHERE school_id=$1 AND status='posted' AND ($2::date IS NULL OR received_on >= $2::date) AND ($3::date IS NULL OR received_on <= $3::date)
       GROUP BY payment_method ORDER BY payment_method`;break;
    case 'fees-by-class':
      sql=`SELECT COALESCE(s.class_name,'Unassigned') AS class_name,count(DISTINCT s.id)::int AS students,
       COALESCE(sum(i.amount),0)::text AS invoiced
       FROM students s LEFT JOIN fee_invoices i ON i.school_id=s.school_id AND i.student_id=s.id AND i.status<>'void'
       WHERE s.school_id=$1 GROUP BY s.class_name ORDER BY s.class_name`;break;
    case 'audit-trail':
      sql=`SELECT created_at,actor_user_id,action,entity_type,entity_id,request_id,metadata
       FROM audit_events WHERE school_id=$1 AND ($2::date IS NULL OR created_at::date >= $2::date) AND ($3::date IS NULL OR created_at::date <= $3::date)
       ORDER BY created_at DESC LIMIT 5000`;break;
    default: throw Object.assign(new Error('Report not found.'),{statusCode:404});
  }
  const dateReports=['trial-balance','income-statement','general-ledger','cashbook','bankbook','receipts-register','invoice-register','fee-balances','expense-register','bank-reconciliation','journal-register','collections-by-method','audit-trail'];
  if(name==='balance-sheet')params=[schoolId,to];
  else if(dateReports.includes(name))params=[schoolId,from,to];
  else params=[schoolId];
  const result=await c.query(sql,params);
  return result.rows as Record<string,unknown>[];
}
function reportDateFilters(req:Request,res:Response):{from:string|null;to:string|null}|null{
  const from=typeof req.query.from==='string'?req.query.from:null;
  const to=typeof req.query.to==='string'?req.query.to:null;
  if((from&&!/^\d{4}-\d{2}-\d{2}$/.test(from))||(to&&!/^\d{4}-\d{2}-\d{2}$/.test(to))){res.status(400).json({error:'Report dates must use YYYY-MM-DD.'});return null;}
  if(from&&to&&from>to){res.status(400).json({error:'Report start date must not be after end date.'});return null;}
  return {from,to};
}
operationsRouter.get('/reports/:report.csv',requirePermission('reports.export'),wrap(async(req,res)=>{
  const name=String(req.params.report);if(!reportNames.includes(name)){res.status(404).json({error:'Report not found.'});return;}
  const dates=reportDateFilters(req,res);if(!dates)return;const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to));
  const keys=rows.length?Object.keys(rows[0]):['no_data'];
  const quote=(v:unknown)=>{let value=String(v??'');if(/^[=+@]/.test(value)||/^-[A-Za-z]/.test(value))value="'"+value;return /[",\r\n]/.test(value)?'"'+value.replace(/"/g,'""')+'"':value;};
  const csv=[keys.map(quote).join(','),...rows.map(row=>keys.map(k=>quote(row[k])).join(','))].join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${name}-${todayIso()}.csv"`);res.status(200).send(csv);
}));
operationsRouter.get('/reports/:report.xlsx',requirePermission('reports.export'),wrap(async(req,res)=>{
  const name=String(req.params.report);if(!reportNames.includes(name)){res.status(404).json({error:'Report not found.'});return;}
  const dates=reportDateFilters(req,res);if(!dates)return;const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to));
  const ExcelJS=await import('exceljs');const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet(name.slice(0,31));
  const keys=rows.length?Object.keys(rows[0]):['no_data'];
  sheet.columns=keys.map(key=>({header:labelsForReport(key),key,width:Math.min(32,Math.max(12,labelsForReport(key).length+4))}));
  for(const row of rows)sheet.addRow(row);
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF174C3D'}};
  sheet.views=[{state:'frozen',ySplit:1}];
  const buffer=await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${name}-${todayIso()}.xlsx"`);res.status(200).send(Buffer.from(buffer));
}));
operationsRouter.get('/reports/:report.pdf',requirePermission('reports.export'),wrap(async(req,res)=>{
  const name=String(req.params.report);if(!reportNames.includes(name)){res.status(404).json({error:'Report not found.'});return;}
  const dates=reportDateFilters(req,res);if(!dates)return;const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to));
  const PdfDocument=(await import('pdfkit')).default;const doc=new PdfDocument({size:'A4',layout:'landscape',margin:32,bufferPages:true});
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${name}-${todayIso()}.pdf"`);
  doc.pipe(res);doc.fontSize(18).fillColor('#174c3d').text('ShuleLedger — '+name.replaceAll('-',' '));doc.moveDown(.4);
  doc.fontSize(8).fillColor('#64766a').text('KES · Generated '+new Date().toISOString()+' · School '+auth.schoolName);doc.moveDown();
  const keys=rows.length?Object.keys(rows[0]):['no_data'];const widths=keys.map(()=>Math.max(50,(doc.page.width-64)/keys.length));
  const renderRow=(values:unknown[],header=false)=>{const y=doc.y;let x=32;values.forEach((v,i)=>{const w=widths[i];if(header)doc.rect(x,y,w,20).fill('#e7f0ea');doc.fillColor(header?'#174c3d':'#344d40').fontSize(header?7:6).text(String(v??'').slice(0,120),x+3,y+4,{width:w-6,height:18,ellipsis:true});x+=w;});doc.y=y+20;};
  renderRow(keys.map(labelsForReport),true);for(const row of rows){if(doc.y>doc.page.height-45){doc.addPage();renderRow(keys.map(labelsForReport),true);}renderRow(keys.map(k=>row[k]));}
  doc.end();
}));
function labelsForReport(key:string):string{return key.replaceAll('_',' ');}

operationsRouter.get('/reports/:report',requirePermission('reports.read'),wrap(async(req,res)=>{
  const name=String(req.params.report);
  if(!reportNames.includes(name)){res.status(404).json({error:'Report not found.'});return;}
  const dates=reportDateFilters(req,res);if(!dates)return;
  const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to));
  res.json({report:name,currency:'KES',from:dates.from,to:dates.to,rows});
}));
