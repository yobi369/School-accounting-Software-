import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authContext, requireAuth, requirePermission } from './auth.js';
import { withSchoolTransaction } from './db.js';
import { parseKesToMinorUnits, validateJournal } from './domain/ledger.js';

export const operationsRouter = Router();
operationsRouter.use(requireAuth);

function sqlDate(value:unknown):string {
  if(value instanceof Date){
    // PostgreSQL DATE values may be parsed as UTC-midnight Date objects. Local
    // getters can shift the calendar day on hosts configured outside UTC.
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth()+1).padStart(2,'0')}-${String(value.getUTCDate()).padStart(2,'0')}`;
  }
  return String(value).slice(0,10);
}
export function amountString(minor: bigint): string {
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  return sign + (absolute / 100n).toString() + '.' + (absolute % 100n).toString().padStart(2,'0');
}
function asMoney(value: string): string { return amountString(parseKesToMinorUnits(value)); }
export function audit(client: PoolClient, schoolId:string, userId:string, action:string, type:string, id:string, metadata:Record<string,unknown>={}) {
  return client.query(
    'INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [schoolId,userId,action,type,id,JSON.stringify(metadata)],
  );
}

export type PostingLine = { accountId?: string; accountCode?: string; debit: string; credit: string; memo?: string };
export async function postJournal(client: PoolClient, schoolId:string, userId:string, date:string, description:string, sourceType:string, sourceId:string, postingLines:PostingLine[], reversalOfId?:string) {
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

export const studentSchema=z.object({
  admissionNumber:z.string().trim().min(1).max(40),
  fullName:z.string().trim().min(2).max(160),
  className:z.string().trim().max(80).optional(),
  sex:z.enum(['female','male','other','prefer_not_to_say']).optional().or(z.literal('')),
  dateOfBirth:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v&&v<=new Date().toISOString().slice(0,10),'Enter a valid date of birth that is not in the future.').optional().or(z.literal('')),
  guardianName:z.string().trim().max(160).optional(),
  guardianRelationship:z.string().trim().max(80).optional(),
  guardianPhone:z.string().trim().max(40).optional(),
  guardianAlternatePhone:z.string().trim().max(40).optional(),
  homeAddress:z.string().trim().max(300).optional(),
  emergencyContactName:z.string().trim().max(160).optional(),
  emergencyContactPhone:z.string().trim().max(40).optional(),
});
operationsRouter.get('/students',requirePermission('students.read'),wrap(async(req,res)=>{
  const auth=authContext(req); const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,100):'';
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT id,admission_number,full_name,class_name,sex,date_of_birth,guardian_name,guardian_relationship,guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone,status,created_at
     FROM students WHERE school_id=$1 AND ($2='' OR admission_number ILIKE '%'||$2||'%' OR full_name ILIKE '%'||$2||'%')
     ORDER BY full_name LIMIT 500`,[auth.schoolId,q]));
  res.json({students:result.rows});
}));
operationsRouter.get('/students/:studentId/financial-account',requirePermission('students.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const studentId=String(req.params.studentId);const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(studentId)){res.status(400).json({error:'Invalid student ID.'});return;}
  const result=await withSchoolTransaction(auth.schoolId,async c=>{
    const student=await c.query(
      'SELECT id,admission_number,full_name,class_name,sex,date_of_birth,guardian_name,guardian_relationship,guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone,status FROM students WHERE school_id=$1 AND id=$2',
      [auth.schoolId,studentId]);
    if(!student.rowCount)return null;
    const transactions=await c.query(
      `WITH events AS (
        SELECT i.id AS transaction_id,i.issued_on::date AS transaction_date,i.invoice_number AS reference,
          COALESCE(i.description,'School fees') AS description,'invoice'::text AS transaction_type,
          i.amount::numeric(14,2) AS debit,0::numeric(14,2) AS credit,1 AS sort_order
        FROM fee_invoices i WHERE i.school_id=$1 AND i.student_id=$2 AND i.status<>'void' AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$3::uuid))
        UNION ALL
        SELECT r.id,r.received_on::date,r.receipt_number,
          COALESCE(r.notes,'Fee payment · '||r.payment_method),'receipt'::text,
          0::numeric(14,2),CASE WHEN $3::uuid IS NULL THEN r.amount::numeric(14,2) ELSE COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND i.student_id=r.student_id AND fs.academic_term_id=$3::uuid),0)::numeric(14,2) END,2
        FROM fee_receipts r WHERE r.school_id=$1 AND r.student_id=$2 AND r.status='posted' AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND i.student_id=r.student_id AND fs.academic_term_id=$3::uuid))
        UNION ALL
        SELECT w.id,w.waived_on::date,w.waiver_number,w.reason,'waiver'::text,
          0::numeric(14,2),w.amount::numeric(14,2),3
        FROM fee_waivers w JOIN fee_invoices i ON i.id=w.invoice_id AND i.school_id=w.school_id
        WHERE w.school_id=$1 AND i.student_id=$2 AND w.status='posted' AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$3::uuid))
      ), balances AS (
        SELECT *,SUM(debit-credit) OVER(ORDER BY transaction_date,sort_order,reference,transaction_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
        FROM events
      )
      SELECT transaction_id,transaction_date,reference,description,transaction_type,
        debit::text,credit::text,running_balance::numeric(14,2)::text AS running_balance
      FROM balances ORDER BY transaction_date,sort_order,reference,transaction_id`,
      [auth.schoolId,studentId,academicTermId]);
    const totals=await c.query(
      `SELECT COALESCE(sum(debit),0)::numeric(14,2)::text AS billed,
        COALESCE(sum(credit),0)::numeric(14,2)::text AS credits,
        COALESCE(sum(debit-credit),0)::numeric(14,2)::text AS balance
       FROM (
         SELECT i.amount::numeric AS debit,0::numeric AS credit FROM fee_invoices i WHERE i.school_id=$1 AND i.student_id=$2 AND i.status<>'void' AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$3::uuid))
         UNION ALL SELECT 0::numeric,CASE WHEN $3::uuid IS NULL THEN r.amount::numeric ELSE COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND i.student_id=r.student_id AND fs.academic_term_id=$3::uuid),0)::numeric END FROM fee_receipts r WHERE r.school_id=$1 AND r.student_id=$2 AND r.status='posted' AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND i.student_id=r.student_id AND fs.academic_term_id=$3::uuid))
         UNION ALL SELECT 0::numeric,w.amount::numeric FROM fee_waivers w JOIN fee_invoices i ON i.id=w.invoice_id AND i.school_id=w.school_id WHERE w.school_id=$1 AND i.student_id=$2 AND w.status='posted' AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$3::uuid))
       ) t`,[auth.schoolId,studentId,academicTermId]);
    return {student:student.rows[0],transactions:transactions.rows,totals:totals.rows[0]};
  });
  if(!result){res.status(404).json({error:'Student not found in this school.'});return;}
  res.json(result);
}));

operationsRouter.post('/students',requirePermission('students.manage'),wrap(async(req,res)=>{
  const parsed=studentSchema.safeParse(req.body); if(!parsed.success){res.status(400).json({error:'Invalid student details.',details:parsed.error.flatten()});return;}
  const auth=authContext(req); const d=parsed.data;
  const student=await withSchoolTransaction(auth.schoolId,async c=>{
    const r=await c.query(
      'INSERT INTO students (school_id,admission_number,full_name,class_name,sex,date_of_birth,guardian_name,guardian_relationship,guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13) RETURNING id,admission_number,full_name,class_name,sex,date_of_birth,guardian_name,guardian_relationship,guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone,status,created_at',
      [auth.schoolId,d.admissionNumber,d.fullName,d.className||null,d.sex||null,d.dateOfBirth||null,d.guardianName||null,d.guardianRelationship||null,d.guardianPhone||null,d.guardianAlternatePhone||null,d.homeAddress||null,d.emergencyContactName||null,d.emergencyContactPhone||null]);
    await audit(c,auth.schoolId,auth.userId,'student.create','student',r.rows[0].id);
    return r.rows[0];
  });
  res.status(201).json({student});
}));

const feeStructureSchema=z.object({
  className:z.string().trim().min(1).max(80),
  academicYear:z.string().trim().min(2).max(30),
  termName:z.string().trim().min(1).max(40),
  academicTermId:z.string().uuid().optional(),
  dueOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items:z.array(z.object({itemName:z.string().trim().min(1).max(100),amount:z.string().regex(/^\d+(?:\.\d{1,2})?$/)})).min(1).max(100),
});
operationsRouter.get('/fees/structures',requirePermission('fees.read'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    "SELECT f.id,f.class_name,f.academic_year,f.term_name,f.academic_term_id,f.version,f.due_on,f.status,f.created_at,COALESCE(json_agg(json_build_object('id',i.id,'itemName',i.item_name,'amount',i.amount::text)) FILTER (WHERE i.id IS NOT NULL),'[]'::json) AS items,COALESCE((SELECT count(*)::int FROM fee_invoices inv WHERE inv.school_id=f.school_id AND inv.fee_structure_id=f.id),0) AS invoices_created,COALESCE((SELECT sum(fi.amount) FROM fee_structure_items fi WHERE fi.school_id=f.school_id AND fi.structure_id=f.id),0)::numeric(14,2)::text AS total_fees,(SELECT count(*)::int FROM students st WHERE st.school_id=f.school_id AND st.class_name=f.class_name AND st.status='active') AS eligible_students FROM fee_structures f LEFT JOIN fee_structure_items i ON i.school_id=f.school_id AND i.structure_id=f.id WHERE f.school_id=$1 GROUP BY f.id ORDER BY f.academic_year DESC,f.term_name,f.class_name",
    [auth.schoolId]));
  res.json({structures:result.rows});
}));
operationsRouter.post('/fees/structures',requirePermission('fees.manage'),wrap(async(req,res)=>{
  const parsed=feeStructureSchema.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:'Invalid fee structure details.',details:parsed.error.flatten()});return;}
  const d=parsed.data;const auth=authContext(req);
  const items=d.items.map(item=>({itemName:item.itemName,minor:parseKesToMinorUnits(item.amount)}));
  if(items.some(item=>item.minor<=0n)){res.status(422).json({error:'Each fee item amount must be greater than zero.'});return;}
  if(new Set(items.map(item=>item.itemName.toLowerCase())).size!==items.length){res.status(422).json({error:'Fee item names must be unique within a structure.'});return;}
  try{
    const structure=await withSchoolTransaction(auth.schoolId,async c=>{
      const configuredClass=await c.query('SELECT id FROM school_classes WHERE school_id=$1 AND name=$2 AND is_active=true',[auth.schoolId,d.className]);if(!configuredClass.rowCount)throw Object.assign(new Error('Choose a class or stream configured under School Settings.'),{statusCode:422});
      const id=randomUUID();
      let academicYear=d.academicYear;
      let termName=d.termName;
      if(d.academicTermId){
        const term=await c.query(
          "SELECT t.id,t.name AS term_name,t.starts_on,t.ends_on,t.status AS term_status,y.name AS year_name,y.status AS year_status FROM academic_terms t JOIN academic_years y ON y.school_id=t.school_id AND y.id=t.academic_year_id WHERE t.school_id=$1 AND t.id=$2",
          [auth.schoolId,d.academicTermId],
        );
        if(!term.rowCount)throw Object.assign(new Error('Academic term not found in this school.'),{statusCode:404});
        const t=term.rows[0];
        if(t.term_status!=='open'||t.year_status!=='open')throw Object.assign(new Error('Choose an open academic year and term.'),{statusCode:409});
        const start=String(t.starts_on).slice(0,10),end=String(t.ends_on).slice(0,10);
        if(d.dueOn<start||d.dueOn>end)throw Object.assign(new Error('The fee due date must fall within the selected academic term.'),{statusCode:422});
        academicYear=String(t.year_name);termName=String(t.term_name);
      }
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fee-structure-version:${auth.schoolId}:${d.className}:${d.academicTermId??'legacy'}`]);const versionResult=await c.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM fee_structures WHERE school_id=$1 AND class_name=$2 AND academic_term_id IS NOT DISTINCT FROM $3',[auth.schoolId,d.className,d.academicTermId??null]);const version=Number(versionResult.rows[0].version);
      await c.query("INSERT INTO fee_structures (id,school_id,class_name,academic_year,term_name,academic_term_id,version,due_on,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9)",[id,auth.schoolId,d.className,academicYear,termName,d.academicTermId??null,version,d.dueOn,auth.userId]);
      for(const item of items)await c.query("INSERT INTO fee_structure_items (id,school_id,structure_id,item_name,amount) VALUES ($1,$2,$3,$4,$5)",[randomUUID(),auth.schoolId,id,item.itemName,amountString(item.minor)]);
      await audit(c,auth.schoolId,auth.userId,'fee.structure.create','fee_structure',id,{className:d.className,academicYear,termName,academicTermId:d.academicTermId??null,itemCount:items.length});
      return {id,className:d.className,academicYear,termName,academicTermId:d.academicTermId??null,version,dueOn:d.dueOn,status:'draft',items:items.map(item=>({itemName:item.itemName,amount:amountString(item.minor)}))};
    });
    res.status(201).json({structure});
  }catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.put('/fees/structures/:id',requirePermission('fees.manage'),wrap(async(req,res)=>{
 const id=z.string().uuid().safeParse(req.params.id);const parsed=feeStructureSchema.safeParse(req.body);if(!id.success||!parsed.success){res.status(400).json({error:'Invalid fee structure update.'});return;}
 const auth=authContext(req);const d=parsed.data;const items=d.items.map(item=>({itemName:item.itemName,minor:parseKesToMinorUnits(item.amount)}));
 if(items.some(item=>item.minor<=0n)||new Set(items.map(item=>item.itemName.toLowerCase())).size!==items.length){res.status(422).json({error:'Fee items must have unique names and positive amounts.'});return;}
 try{const structure=await withSchoolTransaction(auth.schoolId,async client=>{
  const found=await client.query('SELECT id,status FROM fee_structures WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,id.data]);if(!found.rowCount)throw Object.assign(new Error('Fee structure not found.'),{statusCode:404});if(found.rows[0].status!=='draft')throw Object.assign(new Error('Only draft fee structures can be edited. Activated structures must be adjusted by creating a new version.'),{statusCode:409});
  const used=await client.query('SELECT count(*)::int AS count FROM fee_invoices WHERE school_id=$1 AND fee_structure_id=$2',[auth.schoolId,id.data]);if(Number(used.rows[0].count)>0)throw Object.assign(new Error('This fee structure has already generated invoices and cannot be edited.'),{statusCode:409});
  const configuredClass=await client.query('SELECT id FROM school_classes WHERE school_id=$1 AND name=$2 AND is_active=true',[auth.schoolId,d.className]);if(!configuredClass.rowCount)throw Object.assign(new Error('Choose a class configured under School Settings.'),{statusCode:422});
  let academicYear=d.academicYear;let termName=d.termName;
  if(d.academicTermId){const term=await client.query("SELECT t.name AS term_name,t.starts_on,t.ends_on,t.status AS term_status,y.name AS year_name,y.status AS year_status FROM academic_terms t JOIN academic_years y ON y.school_id=t.school_id AND y.id=t.academic_year_id WHERE t.school_id=$1 AND t.id=$2",[auth.schoolId,d.academicTermId]);if(!term.rowCount||term.rows[0].term_status!=='open'||term.rows[0].year_status!=='open')throw Object.assign(new Error('Choose an open academic year and term.'),{statusCode:409});const t=term.rows[0];if(d.dueOn<String(t.starts_on).slice(0,10)||d.dueOn>String(t.ends_on).slice(0,10))throw Object.assign(new Error('The due date must fall within the selected academic term.'),{statusCode:422});academicYear=String(t.year_name);termName=String(t.term_name);}
  await client.query('UPDATE fee_structures SET class_name=$3,academic_year=$4,term_name=$5,academic_term_id=$6,due_on=$7 WHERE school_id=$1 AND id=$2',[auth.schoolId,id.data,d.className,academicYear,termName,d.academicTermId??null,d.dueOn]);await client.query('DELETE FROM fee_structure_items WHERE school_id=$1 AND structure_id=$2',[auth.schoolId,id.data]);for(const item of items)await client.query('INSERT INTO fee_structure_items (id,school_id,structure_id,item_name,amount) VALUES ($1,$2,$3,$4,$5)',[randomUUID(),auth.schoolId,id.data,item.itemName,amountString(item.minor)]);await audit(client,auth.schoolId,auth.userId,'fee.structure.update','fee_structure',id.data,{className:d.className,academicYear,termName,itemCount:items.length});return {id:id.data,className:d.className,academicYear,termName,academicTermId:d.academicTermId??null,dueOn:d.dueOn,status:'draft',items:items.map(item=>({itemName:item.itemName,amount:amountString(item.minor)}))};
 });res.json({structure});}catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.post('/fees/structures/:id/activate',requirePermission('fees.manage'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid fee structure ID.'});return;}
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,async c=>{
    const row=await c.query("SELECT id,status FROM fee_structures WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);
    if(!row.rowCount)throw Object.assign(new Error('Fee structure not found in this school.'),{statusCode:404});
    if(row.rows[0].status==='archived')throw Object.assign(new Error('Archived fee structures cannot be activated.'),{statusCode:409});
    const totals=await c.query("SELECT COALESCE(sum(amount),0)::text AS total,count(*)::int AS item_count FROM fee_structure_items WHERE school_id=$1 AND structure_id=$2",[auth.schoolId,id.data]);
    if(Number(totals.rows[0].item_count)<1||parseKesToMinorUnits(String(totals.rows[0].total))<=0n)throw Object.assign(new Error('Add at least one positive fee item before activation.'),{statusCode:422});
    await c.query("UPDATE fee_structures SET status='active' WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data]);
    await audit(c,auth.schoolId,auth.userId,'fee.structure.activate','fee_structure',id.data,{itemCount:totals.rows[0].item_count,total:totals.rows[0].total});
    return {id:id.data,status:'active',total:totals.rows[0].total,itemCount:totals.rows[0].item_count};
  });
  res.json({structure:result});
}));
operationsRouter.post('/fees/structures/:id/invoice-class',requirePermission('fees.manage'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid fee structure ID.'});return;}
  const auth=authContext(req);const issuedOn=todayIso();
  try{
    const outcome=await withSchoolTransaction(auth.schoolId,async c=>{
      const structure=await c.query("SELECT * FROM fee_structures WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);
      if(!structure.rowCount)throw Object.assign(new Error('Fee structure not found in this school.'),{statusCode:404});
      const f=structure.rows[0];
      if(f.status!=='active')throw Object.assign(new Error('Activate the fee structure before bulk invoicing.'),{statusCode:409});
      if(f.academic_term_id){
        const term=await c.query("SELECT t.status AS term_status,y.status AS year_status FROM academic_terms t JOIN academic_years y ON y.school_id=t.school_id AND y.id=t.academic_year_id WHERE t.school_id=$1 AND t.id=$2",[auth.schoolId,f.academic_term_id]);
        if(!term.rowCount||term.rows[0].term_status!=='open'||term.rows[0].year_status!=='open')throw Object.assign(new Error('Cannot bulk invoice against a closed or missing academic term.'),{statusCode:409});
      }
      if(String(f.due_on)<issuedOn)throw Object.assign(new Error('The structure due date is before today; update the structure or use a valid due date.'),{statusCode:422});
      const items=await c.query("SELECT item_name,amount::text FROM fee_structure_items WHERE school_id=$1 AND structure_id=$2 ORDER BY item_name",[auth.schoolId,id.data]);
      if(!items.rowCount)throw Object.assign(new Error('This fee structure has no items.'),{statusCode:422});
      const total=items.rows.reduce((sum,item)=>sum+parseKesToMinorUnits(String(item.amount)),0n);
      if(total<=0n)throw Object.assign(new Error('Fee structure total must be greater than zero.'),{statusCode:422});
      const students=await c.query("SELECT id,admission_number FROM students WHERE school_id=$1 AND class_name=$2 AND status='active' ORDER BY admission_number",[auth.schoolId,f.class_name]);
      if(!students.rowCount)throw Object.assign(new Error('No active students found in the selected class.'),{statusCode:422});
      const created=[];const skipped=[];
      for(const student of students.rows){
        const existing=await c.query("SELECT i.id,i.invoice_number FROM fee_invoices i WHERE i.school_id=$1 AND i.student_id=$2 AND (i.fee_structure_id=$3 OR ($5::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM fee_structures prior WHERE prior.school_id=i.school_id AND prior.id=i.fee_structure_id AND prior.class_name=$4 AND prior.academic_term_id=$5)))",[auth.schoolId,student.id,id.data,f.class_name,f.academic_term_id]);
        if(existing.rowCount){skipped.push({studentId:student.id,invoiceNumber:existing.rows[0].invoice_number});continue;}
        const invoiceId=randomUUID();
        const invoiceNumber=await nextFeeDocumentNumber(c,auth.schoolId,'INV',issuedOn);
        const description=items.rows.map(item=>String(item.item_name)).join(', ');
        await c.query("INSERT INTO fee_invoices (id,school_id,student_id,invoice_number,academic_year,description,issued_on,due_on,amount,status,created_by,fee_structure_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',$10,$11)",[invoiceId,auth.schoolId,student.id,invoiceNumber,f.academic_year,description,issuedOn,f.due_on,amountString(total),auth.userId,id.data]);
        for(let itemIndex=0;itemIndex<items.rows.length;itemIndex++){const item=items.rows[itemIndex];await c.query('INSERT INTO fee_invoice_items (id,school_id,invoice_id,line_number,item_name,description,amount) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),auth.schoolId,invoiceId,itemIndex+1,String(item.item_name),'',String(item.amount)]);}
        const journal=await postJournal(c,auth.schoolId,auth.userId,issuedOn,'Bulk fee invoice '+invoiceNumber+': '+description,'fee_invoice',invoiceId,[
          {accountCode:'1200',debit:amountString(total),credit:'0.00'},
          {accountCode:'4000',debit:'0.00',credit:amountString(total)},
        ]);
        await audit(c,auth.schoolId,auth.userId,'fee.invoice.bulk_issue','fee_invoice',invoiceId,{invoiceNumber,structureId:id.data,studentId:student.id,amount:amountString(total),itemCount:items.rows.length,journalEntryId:journal.id});
        created.push({studentId:student.id,invoiceNumber,amount:amountString(total),journalEntryId:journal.id});
      }
      await audit(c,auth.schoolId,auth.userId,'fee.structure.bulk_invoice','fee_structure',id.data,{createdCount:created.length,skippedCount:skipped.length,academicYear:f.academic_year,termName:f.term_name});
      return {structureId:id.data,created,skipped,createdCount:created.length,skippedCount:skipped.length,eligibleStudentCount:students.rowCount,totalPerInvoice:amountString(total),expectedTotal:amountString(total*BigInt(students.rowCount))};
    });
    res.status(200).json(outcome);
  }catch(error){if(!handleError(res,error))throw error;}
}));

const invoiceSchema=z.object({
  studentId:z.string().uuid(), invoiceNumber:z.string().trim().min(1).max(60).optional(),
  academicYear:z.string().trim().min(2).max(30), description:z.string().trim().min(2).max(500).optional(),
  issuedOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount:z.string().optional(),
  items:z.array(z.object({itemName:z.string().trim().min(1).max(120),description:z.string().trim().max(500).optional(),amount:z.string().regex(/^\d+(?:\.\d{1,2})?$/)})).min(1).max(100).optional(),
});
operationsRouter.get('/fees/invoices',requirePermission('fees.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT i.id,i.invoice_number,i.student_id,s.admission_number,s.full_name AS student_name,s.class_name,
      i.academic_year,i.description,i.issued_on,i.due_on,i.amount::text,i.status,fs.academic_term_id,COALESCE(fs.term_name,i.academic_year) AS term_name,
      COALESCE((SELECT json_agg(json_build_object('itemName',ii.item_name,'description',ii.description,'amount',ii.amount::text) ORDER BY ii.line_number) FROM fee_invoice_items ii WHERE ii.school_id=i.school_id AND ii.invoice_id=i.id),'[]'::json) AS items,
      COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated,
      COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)::text AS waived,
      COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)::text AS credited,
      (i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0))::numeric(14,2)::text AS outstanding
     FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id LEFT JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id
     WHERE i.school_id=$1 AND ($2::uuid IS NULL OR fs.academic_term_id=$2::uuid) ORDER BY i.issued_on DESC,i.invoice_number DESC LIMIT 500`,[auth.schoolId,academicTermId]));
  res.json({invoices:result.rows});
}));
operationsRouter.post('/fees/invoices',requirePermission('fees.manage'),wrap(async(req,res)=>{
  const parsed=invoiceSchema.safeParse(req.body); if(!parsed.success){res.status(400).json({error:'Invalid invoice details.',details:parsed.error.flatten()});return;}
  const d=parsed.data; const auth=authContext(req); const issuedOn=d.issuedOn??todayIso();
  const lineItems=(d.items??(d.amount&&d.description?[{itemName:d.description,description:d.description,amount:d.amount}]:[])).map(item=>({itemName:item.itemName,description:item.description??'',minor:parseKesToMinorUnits(item.amount)}));
  if(!lineItems.length||lineItems.some(item=>item.minor<=0n)){res.status(422).json({error:'Provide at least one invoice line item with a positive amount.'});return;}
  const minor=lineItems.reduce((sum,item)=>sum+item.minor,0n);const description=(d.description??lineItems.map(item=>item.itemName).join(', ')).trim();
  if(d.dueOn<issuedOn){res.status(422).json({error:'Due date cannot be before issue date.'});return;}
  try {
    const invoice=await withSchoolTransaction(auth.schoolId,async c=>{
      const student=await c.query("SELECT id,admission_number,full_name,class_name FROM students WHERE school_id=$1 AND id=$2 AND status='active'",[auth.schoolId,d.studentId]);
      if(!student.rowCount) throw Object.assign(new Error('Active student not found in this school.'),{statusCode:422});
      const id=randomUUID();const invoiceNumber=d.invoiceNumber??await nextFeeDocumentNumber(c,auth.schoolId,'INV',issuedOn);
      await c.query(
        "INSERT INTO fee_invoices (id,school_id,student_id,invoice_number,academic_year,description,issued_on,due_on,amount,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',$10)",
        [id,auth.schoolId,d.studentId,invoiceNumber,d.academicYear,description,issuedOn,d.dueOn,amountString(minor),auth.userId]);
      for(let index=0;index<lineItems.length;index++){const item=lineItems[index];await c.query('INSERT INTO fee_invoice_items (id,school_id,invoice_id,line_number,item_name,description,amount) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),auth.schoolId,id,index+1,item.itemName,item.description,amountString(item.minor)]);}
      const journal=await postJournal(c,auth.schoolId,auth.userId,issuedOn,`Fee invoice ${invoiceNumber}: ${description}`,'fee_invoice',id,[
        {accountCode:'1200',debit:amountString(minor),credit:'0.00'},
        {accountCode:'4000',debit:'0.00',credit:amountString(minor)},
      ]);
      await audit(c,auth.schoolId,auth.userId,'fee.invoice.issue','fee_invoice',id,{invoiceNumber,journalEntryId:journal.id,amount:amountString(minor),itemCount:lineItems.length});
      return {id,invoiceNumber,studentId:d.studentId,issuedOn,dueOn:d.dueOn,amount:amountString(minor),items:lineItems.map(item=>({itemName:item.itemName,description:item.description,amount:amountString(item.minor)})),status:'issued',journalEntryId:journal.id};
    });
    res.status(201).json({invoice});
  } catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.get('/fees/receipts',requirePermission('fees.read'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT r.id,r.receipt_number,r.student_id,s.admission_number,s.full_name AS student_name,s.class_name,
      r.received_on,r.amount::text,r.previous_balance::text,r.new_balance::text,COALESCE((SELECT cr.amount::text FROM student_fee_credits cr WHERE cr.school_id=r.school_id AND cr.receipt_id=r.id),'0.00') AS student_credit_amount,r.payment_method,r.external_reference,r.notes,r.status,
      r.journal_entry_id,r.received_by,u.full_name AS received_by_name,r.created_at,$2::text AS school_name,
      COALESCE(json_agg(json_build_object('invoiceNumber',i.invoice_number,'academicYear',i.academic_year,'termName',COALESCE(fs.term_name,i.academic_year),'amount',a.amount::text))
        FILTER (WHERE i.id IS NOT NULL),'[]'::json) AS allocations
     FROM fee_receipts r
     JOIN students s ON s.id=r.student_id AND s.school_id=r.school_id
     LEFT JOIN users u ON u.id=r.received_by
     LEFT JOIN fee_receipt_allocations a ON a.school_id=r.school_id AND a.receipt_id=r.id
     LEFT JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id
     LEFT JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id
     WHERE r.school_id=$1
     GROUP BY r.id,s.admission_number,s.full_name,s.class_name,u.full_name
     ORDER BY r.received_on DESC,r.created_at DESC LIMIT 500`,[auth.schoolId,auth.schoolName]));
  res.json({receipts:result.rows});
}));

const receiptSchema=z.object({
  studentId:z.string().uuid(),receiptNumber:z.string().trim().min(1).max(60).optional(),
  receivedOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount:z.string().regex(/^\d+(?:\.\d{1,2})?$/),paymentAccountId:z.string().uuid(),paymentMethod:z.enum(['cash','bank','mpesa','cheque','other']),
  externalReference:z.string().trim().max(160).optional(),
  notes:z.string().trim().max(500).optional(),
  allocations:z.array(z.object({invoiceId:z.string().uuid(),amount:z.string().regex(/^\d+(?:\.\d{1,2})?$/)})).max(100).default([]),
  allowStudentCredit:z.boolean().optional().default(false),
}).superRefine((data,ctx)=>{if((data.paymentMethod==='bank'||data.paymentMethod==='mpesa')&&!data.externalReference?.trim())ctx.addIssue({code:'custom',path:['externalReference'],message:'Payment reference is required for Bank and M-Pesa receipts.'});});
operationsRouter.post('/fees/receipts',requirePermission('receipts.create'),wrap(async(req,res)=>{
  const parsed=receiptSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid receipt details.',details:parsed.error.flatten()});return;}
  const d=parsed.data;const auth=authContext(req);const receivedOn=d.receivedOn??new Date().toISOString().slice(0,10);
  const idempotencyKey=req.header('Idempotency-Key');if(!idempotencyKey||idempotencyKey.length<8||idempotencyKey.length>200){res.status(400).json({error:'An Idempotency-Key header between 8 and 200 characters is required.'});return;}
  const requestHash=createHash('sha256').update(JSON.stringify(d)).digest('hex');
  const amount=parseKesToMinorUnits(d.amount);const allocationTotal=d.allocations.reduce((sum,a)=>sum+parseKesToMinorUnits(a.amount),0n);
  if(amount<=0n||allocationTotal>amount){res.status(422).json({error:'Receipt amount must be positive and invoice allocations cannot exceed the receipt amount.'});return;}
  if(amount>allocationTotal&&!d.allowStudentCredit){res.status(422).json({error:'The unallocated amount must be explicitly recorded as a Student Credit Balance.'});return;}
  try{
    const outcome=await withSchoolTransaction(auth.schoolId,async c=>{
      const existing=await c.query('SELECT request_hash,response_body FROM idempotency_records WHERE school_id=$1 AND idempotency_key=$2 FOR UPDATE',[auth.schoolId,idempotencyKey]);
      if(existing.rowCount){
        if(existing.rows[0].request_hash!==requestHash)throw Object.assign(new Error('Idempotency key was already used for a different receipt request.'),{statusCode:409});
        const saved=existing.rows[0].response_body as {receipt:Record<string,unknown>};
        return {receipt:saved.receipt,duplicate:true};
      }
      const student=await c.query("SELECT id,full_name,admission_number,class_name FROM students WHERE school_id=$1 AND id=$2 AND status='active'",[auth.schoolId,d.studentId]);
      if(!student.rowCount)throw Object.assign(new Error('Active student not found in this school.'),{statusCode:422});
      const cashAccount=await c.query("SELECT id,code,name,account_type,is_active FROM accounts WHERE school_id=$1 AND id=$2",[auth.schoolId,d.paymentAccountId]);
      if(!cashAccount.rowCount||cashAccount.rows[0].account_type!=='asset'||!cashAccount.rows[0].is_active)throw Object.assign(new Error('Select an active cash, bank, or M-Pesa asset account.'),{statusCode:422});
      const accountName=String(cashAccount.rows[0].name).toLowerCase();const accountCode=String(cashAccount.rows[0].code).toLowerCase();
      if(d.paymentMethod==='cash'&&!(accountCode==='1000'||accountName.includes('cash')))throw Object.assign(new Error('Cash payments must be posted to a Cash ledger account.'),{statusCode:422});
      if(d.paymentMethod==='mpesa'&&!(accountName.includes('mpesa')||accountName.includes('m-pesa')||accountName.includes('mobile money')||accountCode.includes('mpesa')))throw Object.assign(new Error('M-Pesa payments must be posted to an M-Pesa / mobile-money ledger account.'),{statusCode:422});
      if(d.paymentMethod==='bank'){const mapped=await c.query('SELECT id FROM bank_accounts WHERE school_id=$1 AND ledger_account_id=$2 AND is_active=true LIMIT 1',[auth.schoolId,d.paymentAccountId]);if(!mapped.rowCount)throw Object.assign(new Error('Bank payments must use a ledger account mapped to an active Bank Account under Cash & Bank settings.'),{statusCode:422});}
      if(d.paymentMethod==='mpesa'&&d.externalReference?.trim()){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`mpesa-reference:${auth.schoolId}:${d.externalReference.trim().toLowerCase()}`]);const duplicate=await c.query("SELECT id FROM fee_receipts WHERE school_id=$1 AND payment_method='mpesa' AND lower(external_reference)=lower($2) AND status='posted' LIMIT 1",[auth.schoolId,d.externalReference.trim()]);if(duplicate.rowCount)throw Object.assign(new Error('This M-Pesa transaction reference has already been recorded.'),{statusCode:409});}
      await c.query("SELECT id FROM fee_invoices WHERE school_id=$1 AND student_id=$2 AND status NOT IN ('void','reversed') ORDER BY id FOR UPDATE",[auth.schoolId,d.studentId]);
      const previous=await c.query(`SELECT (COALESCE(sum(i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)),0)-COALESCE((SELECT sum(cr.remaining_amount) FROM student_fee_credits cr WHERE cr.school_id=$1 AND cr.student_id=$2 AND cr.status='posted'),0))::numeric(14,2)::text AS balance FROM fee_invoices i WHERE i.school_id=$1 AND i.student_id=$2 AND i.status NOT IN ('void','reversed')`,[auth.schoolId,d.studentId]);const previousBalance=String(previous.rows[0].balance??'0.00');
      const receiptId=randomUUID();const receiptNumber=d.receiptNumber??await nextFeeDocumentNumber(c,auth.schoolId,'RCT',receivedOn);const studentCredit=amount-allocationTotal;
      await c.query(
        "INSERT INTO fee_receipts (id,school_id,receipt_number,student_id,received_on,amount,payment_method,external_reference,notes,received_by,previous_balance,new_balance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)",
        [receiptId,auth.schoolId,receiptNumber,d.studentId,receivedOn,amountString(amount),d.paymentMethod,d.externalReference??null,d.notes??null,auth.userId,previousBalance]);
      for(const allocation of d.allocations){
        const allocated=parseKesToMinorUnits(allocation.amount);
        if(allocated<=0n)throw Object.assign(new Error('Each allocation must be greater than zero.'),{statusCode:422});
        const inv=await c.query(
          `SELECT i.amount::text,i.student_id,i.status,
             COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated,
             COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)::text AS waived,
             COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)::text AS credited
           FROM fee_invoices i WHERE i.school_id=$1 AND i.id=$2 FOR UPDATE`,[auth.schoolId,allocation.invoiceId]);
        if(!inv.rowCount||inv.rows[0].student_id!==d.studentId||inv.rows[0].status==='void')throw Object.assign(new Error('An allocated invoice is missing, void, or belongs to another student.'),{statusCode:422});
        const outstanding=parseKesToMinorUnits(String(inv.rows[0].amount))-parseKesToMinorUnits(String(inv.rows[0].allocated))-parseKesToMinorUnits(String(inv.rows[0].waived))-parseKesToMinorUnits(String(inv.rows[0].credited));
        if(allocated>outstanding)throw Object.assign(new Error('Allocation exceeds the invoice outstanding balance.'),{statusCode:422});
        await c.query('INSERT INTO fee_receipt_allocations (school_id,receipt_id,invoice_id,amount) VALUES ($1,$2,$3,$4)',[auth.schoolId,receiptId,allocation.invoiceId,amountString(allocated)]);
      }
      let studentCreditId:string|null=null;if(studentCredit>0n){studentCreditId=randomUUID();await c.query("INSERT INTO student_fee_credits (id,school_id,student_id,receipt_id,amount,remaining_amount,status) VALUES ($1,$2,$3,$4,$5,$5,'posted')",[studentCreditId,auth.schoolId,d.studentId,receiptId,amountString(studentCredit)]);await audit(c,auth.schoolId,auth.userId,'student.fee_credit.create','student_fee_credit',studentCreditId,{receiptId,receiptNumber,amount:amountString(studentCredit)});}
      const journal=await postJournal(c,auth.schoolId,auth.userId,receivedOn,`Fee receipt ${receiptNumber}`,'fee_receipt',receiptId,[
        {accountId:d.paymentAccountId,debit:amountString(amount),credit:'0.00'},
        {accountCode:'1200',debit:'0.00',credit:amountString(amount)},
      ]);
      await c.query('UPDATE fee_receipts SET journal_entry_id=$3 WHERE school_id=$1 AND id=$2',[auth.schoolId,receiptId,journal.id]);
      await c.query(
        `UPDATE fee_invoices i SET status=CASE
          WHEN COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)+COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)+COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)>=i.amount THEN 'paid'
          WHEN COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)+COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)+COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)>0 THEN 'part_paid'
          ELSE 'issued' END
         WHERE i.school_id=$1 AND i.id=ANY($2::uuid[])`,
        [auth.schoolId,d.allocations.map(a=>a.invoiceId)]);
      const newBalanceResult=await c.query(`SELECT (COALESCE(sum(i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)),0)-COALESCE((SELECT sum(cr.remaining_amount) FROM student_fee_credits cr WHERE cr.school_id=$1 AND cr.student_id=$2 AND cr.status='posted'),0))::numeric(14,2)::text AS balance FROM fee_invoices i WHERE i.school_id=$1 AND i.student_id=$2 AND i.status NOT IN ('void','reversed')`,[auth.schoolId,d.studentId]);const newBalance=String(newBalanceResult.rows[0].balance??'0.00');await c.query('UPDATE fee_receipts SET new_balance=$3 WHERE school_id=$1 AND id=$2',[auth.schoolId,receiptId,newBalance]);
      await audit(c,auth.schoolId,auth.userId,'fee.receipt.post','fee_receipt',receiptId,{receiptNumber,journalEntryId:journal.id,amount:amountString(amount),previousBalance,newBalance});
      const receipt={id:receiptId,receiptNumber,studentId:d.studentId,studentName:student.rows[0].full_name,admissionNumber:student.rows[0].admission_number,className:student.rows[0].class_name,schoolName:auth.schoolName,receivedOn,amount:amountString(amount),previousBalance,newBalance,studentCreditAmount:amountString(studentCredit),studentCreditId,paymentMethod:d.paymentMethod,externalReference:d.externalReference??null,status:'posted',journalEntryId:journal.id};
      await c.query('INSERT INTO idempotency_records (school_id,idempotency_key,request_hash,response_status,response_body,resource_type,resource_id) VALUES ($1,$2,$3,201,$4::jsonb,\'fee_receipt\',$5)',[auth.schoolId,idempotencyKey,requestHash,JSON.stringify({receipt}),receiptId]);
      return {receipt,duplicate:false};
    });
    res.status(outcome.duplicate?200:201).json({receipt:outcome.receipt,duplicate:outcome.duplicate});
  }catch(error){if(!handleError(res,error))throw error;}
}));

const expenseSchema=z.object({
  expenseNumber:z.string().trim().min(1).max(60),supplierId:z.string().uuid().optional(),
  expenseAccountId:z.string().uuid(),academicTermId:z.string().uuid().optional(),
  category:z.string().trim().min(2).max(100),
  description:z.string().trim().min(3).max(500),incurredOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount:z.string(),
});
operationsRouter.get('/expenses',requirePermission('expenses.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT e.id,e.expense_number,e.category,e.description,e.incurred_on,e.amount::text,e.status,
      e.supplier_id,s.name AS supplier_name,e.requested_by,e.approved_by,e.approved_at,e.paid_at,
      e.journal_entry_id,e.payment_journal_entry_id,e.academic_term_id
     FROM expenses e LEFT JOIN suppliers s ON s.id=e.supplier_id AND s.school_id=e.school_id
     WHERE e.school_id=$1 ORDER BY e.created_at DESC LIMIT 500`,[auth.schoolId]));
  res.json({expenses:result.rows});
}));
operationsRouter.post('/expenses',requirePermission('expenses.create'),wrap(async(req,res)=>{
  const parsed=expenseSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid expense details.',details:parsed.error.flatten()});return;}
  const d=parsed.data;const auth=authContext(req);const amount=parseKesToMinorUnits(d.amount);if(amount<=0n){res.status(422).json({error:'Expense amount must be positive.'});return;}
  try{
    const expense=await withSchoolTransaction(auth.schoolId,async c=>{
      const incurredOn=d.incurredOn??new Date().toISOString().slice(0,10);
      if(d.academicTermId){
        const term=await c.query("SELECT t.id FROM academic_terms t JOIN academic_years y ON y.school_id=t.school_id AND y.id=t.academic_year_id WHERE t.school_id=$1 AND t.id=$2 AND t.status='open' AND y.status='open' AND t.starts_on <= $3::date AND t.ends_on >= $3::date",[auth.schoolId,d.academicTermId,incurredOn]);
        if(!term.rowCount)throw Object.assign(new Error('Choose an open academic term in this school that contains the expense date.'),{statusCode:422});
      }
      const account=await c.query("SELECT id FROM accounts WHERE school_id=$1 AND id=$2 AND account_type='expense' AND is_active=true",[auth.schoolId,d.expenseAccountId]);
      if(!account.rowCount)throw Object.assign(new Error('Choose an active expense ledger account in this school.'),{statusCode:422});
      const id=randomUUID();
      await c.query(
        "INSERT INTO expenses (id,school_id,expense_number,supplier_id,category,description,incurred_on,amount,status,requested_by,expense_account_id,academic_term_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted',$9,$10,$11)",
        [id,auth.schoolId,d.expenseNumber,d.supplierId??null,d.category,d.description,incurredOn,amountString(amount),auth.userId,d.expenseAccountId,d.academicTermId??null]);
      await audit(c,auth.schoolId,auth.userId,'expense.submit','expense',id,{expenseNumber:d.expenseNumber,amount:amountString(amount),academicTermId:d.academicTermId??null});
      return {id,expenseNumber:d.expenseNumber,amount:amountString(amount),status:'submitted',academicTermId:d.academicTermId??null};
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
      const e=found.rows[0];if(String(e.requested_by)===auth.userId)throw Object.assign(new Error('The requester cannot approve their own expense.'),{statusCode:403});const amount=parseKesToMinorUnits(String(e.amount));
      const journal=await postJournal(c,auth.schoolId,auth.userId,sqlDate(e.incurred_on),`Expense ${e.expense_number}: ${e.description}`,'expense_approval',id.data,[
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
      const e=found.rows[0];if(String(e.approved_by)===auth.userId)throw Object.assign(new Error('The approver cannot pay the same expense.'),{statusCode:403});const account=await c.query("SELECT id,account_type FROM accounts WHERE school_id=$1 AND id=$2 AND is_active=true",[auth.schoolId,body.data.paymentAccountId]);
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
      const jl=await c.query('SELECT l.*,j.posting_date,j.status FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.school_id=l.school_id WHERE l.school_id=$1 AND l.id=$2 FOR UPDATE OF l',[auth.schoolId,p.data.journalLineId]);
      if(!stmt.rowCount||!jl.rowCount)throw Object.assign(new Error('Statement line or ledger line was not found in this school.'),{statusCode:404});
      const s=stmt.rows[0],l=jl.rows[0];
      const bank=await c.query('SELECT ledger_account_id FROM bank_accounts WHERE school_id=$1 AND id=$2',[auth.schoolId,s.bank_account_id]);
      if(s.matched_at||l.status!=='posted'||l.account_id!==bank.rows[0]?.ledger_account_id)throw Object.assign(new Error('Only an unmatched statement line and a posted ledger line for the mapped bank account can be reconciled.'),{statusCode:409});
      const existingMatch=await c.query('SELECT id FROM bank_statement_lines WHERE school_id=$1 AND matched_journal_line_id=$2 LIMIT 1',[auth.schoolId,l.id]);
      if(existingMatch.rowCount)throw Object.assign(new Error('This ledger line has already been reconciled to another statement line.'),{statusCode:409});
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
        // Lock the idempotency key even when no receipt row exists yet. A row-level
        // FOR UPDATE cannot serialize two concurrent first-time submissions.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[mutation.clientMutationId]);
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
          "INSERT INTO expenses (id,school_id,expense_number,supplier_id,category,description,incurred_on,amount,status,requested_by,expense_account_id,academic_term_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11)",
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
  const dates=reportDateFilters(req,res);if(!dates)return;
  const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;
  const data=await withSchoolTransaction(auth.schoolId,async c=>{
    const fees=await c.query(
      `SELECT
       COALESCE((SELECT sum(i.amount) FROM fee_invoices i WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))),0)::text AS billed,
       COALESCE(CASE WHEN $4::uuid IS NULL THEN (SELECT sum(r.amount) FROM fee_receipts r WHERE r.school_id=$1 AND r.status='posted' AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)) ELSE (SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=$1 AND r.status='posted' AND fs.academic_term_id=$4::uuid AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)) END,0)::text AS collected,
       COALESCE((SELECT sum(i.amount-COALESCE(a.allocated,0)-COALESCE(w.waived,0)-COALESCE(ca.credited,0)) FROM fee_invoices i LEFT JOIN
        (SELECT a.invoice_id,sum(a.amount) AS allocated FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=$1 AND r.status='posted' GROUP BY a.invoice_id) a ON a.invoice_id=i.id LEFT JOIN
        (SELECT invoice_id,sum(amount) AS waived FROM fee_waivers WHERE school_id=$1 AND status='posted' GROUP BY invoice_id) w ON w.invoice_id=i.id LEFT JOIN
        (SELECT invoice_id,sum(amount) AS credited FROM student_fee_credit_allocations WHERE school_id=$1 AND status='posted' GROUP BY invoice_id) ca ON ca.invoice_id=i.id
        WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))),0)::text AS outstanding,
       CASE WHEN COALESCE((SELECT sum(i.amount) FROM fee_invoices i WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))),0)=0 THEN '0'
       ELSE round(100.0*COALESCE(CASE WHEN $4::uuid IS NULL THEN (SELECT sum(r.amount) FROM fee_receipts r WHERE r.school_id=$1 AND r.status='posted' AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)) ELSE (SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=$1 AND r.status='posted' AND fs.academic_term_id=$4::uuid AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)) END,0)/
       (SELECT sum(i.amount) FROM fee_invoices i WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))),2)::text END AS collection_percent`,
      [auth.schoolId,dates.from,dates.to,academicTermId]);
    const expenses=await c.query(
      `SELECT count(*) FILTER (WHERE status='submitted' AND ($4::uuid IS NULL OR academic_term_id=$4::uuid))::int AS awaiting_approval,
       count(*) FILTER (WHERE status='approved' AND ($4::uuid IS NULL OR academic_term_id=$4::uuid))::int AS approved_unpaid,
       COALESCE(sum(amount) FILTER (WHERE status='paid' AND ($2::date IS NULL OR paid_at::date >= $2::date) AND ($3::date IS NULL OR paid_at::date <= $3::date) AND ($4::uuid IS NULL OR academic_term_id=$4::uuid)),0)::text AS paid_total
       FROM expenses WHERE school_id=$1`,[auth.schoolId,dates.from,dates.to,academicTermId]);
    const recentPayments=await c.query(
      `SELECT r.id,r.receipt_number,r.received_on,s.admission_number,s.full_name AS student_name,r.amount::text,r.payment_method,r.external_reference
       FROM fee_receipts r JOIN students s ON s.id=r.student_id AND s.school_id=r.school_id
       WHERE r.school_id=$1 AND r.status='posted' AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)
         AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid))
       ORDER BY r.received_on DESC,r.receipt_number DESC LIMIT 5`,[auth.schoolId,dates.from,dates.to,academicTermId]);
    const pendingApprovals=await c.query(
      `SELECT expense_number,category,description,amount::text,incurred_on,status
       FROM expenses WHERE school_id=$1 AND status='submitted' AND ($2::uuid IS NULL OR academic_term_id=$2::uuid) ORDER BY incurred_on DESC,expense_number DESC LIMIT 5`,[auth.schoolId,academicTermId]);
    const topOutstanding=await c.query(
      `SELECT s.id AS student_id,s.admission_number,s.full_name AS student_name,s.class_name,
        sum(i.amount-COALESCE(a.allocated,0)-COALESCE(w.waived,0))::numeric(14,2)::text AS outstanding,
        GREATEST(0,COALESCE(max(current_date-i.due_on) FILTER (WHERE i.due_on<current_date AND i.amount-COALESCE(a.allocated,0)-COALESCE(w.waived,0)>0),0))::int AS overdue_days,
        (SELECT max(r2.received_on) FROM fee_receipts r2 WHERE r2.school_id=s.school_id AND r2.student_id=s.id AND r2.status='posted') AS last_payment_date
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       LEFT JOIN (SELECT a.invoice_id,sum(a.amount) AS allocated FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=$1 AND r.status='posted' GROUP BY a.invoice_id) a ON a.invoice_id=i.id
       LEFT JOIN (SELECT invoice_id,sum(amount) AS waived FROM fee_waivers WHERE school_id=$1 AND status='posted' GROUP BY invoice_id) w ON w.invoice_id=i.id
       WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date)
         AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
       GROUP BY s.id HAVING sum(i.amount-COALESCE(a.allocated,0)-COALESCE(w.waived,0))>0
       ORDER BY sum(i.amount-COALESCE(a.allocated,0)-COALESCE(w.waived,0)) DESC LIMIT 5`,[auth.schoolId,dates.from,dates.to,academicTermId]);
    const feeCollectionTrend=await c.query(
        `WITH collections AS (
           SELECT r.received_on::date AS collected_on,r.amount
           FROM fee_receipts r
           WHERE r.school_id=$1 AND r.status='posted' AND $4::uuid IS NULL
             AND ($2::date IS NULL OR r.received_on >= $2::date)
             AND ($3::date IS NULL OR r.received_on <= $3::date)
           UNION ALL
           SELECT r.received_on::date AS collected_on,a.amount
           FROM fee_receipt_allocations a
           JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id
           JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id
           JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id
           WHERE a.school_id=$1 AND r.status='posted' AND $4::uuid IS NOT NULL AND fs.academic_term_id=$4::uuid
             AND ($2::date IS NULL OR r.received_on >= $2::date)
             AND ($3::date IS NULL OR r.received_on <= $3::date)
         ), months AS (
           SELECT generate_series(
             date_trunc('month',COALESCE($2::date,current_date-interval '11 months')),
             date_trunc('month',COALESCE($3::date,current_date)),
             interval '1 month')::date AS month_start
         )
         SELECT to_char(m.month_start,'YYYY-MM') AS month,
           COALESCE(sum(c.amount),0)::numeric(14,2)::text AS collected
         FROM months m LEFT JOIN collections c ON date_trunc('month',c.collected_on)=m.month_start
         GROUP BY m.month_start ORDER BY m.month_start`,[auth.schoolId,dates.from,dates.to,academicTermId]);
      const incomeExpenseTrend=await c.query(
        `WITH monthly_income AS (
           SELECT date_trunc('month',r.received_on)::date AS month_start,
             sum(CASE WHEN $4::uuid IS NULL THEN r.amount ELSE COALESCE((
               SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id
               JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id
               WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid
             ),0) END)::numeric(14,2) AS income
           FROM fee_receipts r WHERE r.school_id=$1 AND r.status='posted'
             AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)
             AND ($4::uuid IS NULL OR EXISTS (
               SELECT 1 FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id
               JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id
               WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid))
           GROUP BY date_trunc('month',r.received_on)
         ), monthly_expenses AS (
           SELECT date_trunc('month',e.paid_at)::date AS month_start,sum(e.amount)::numeric(14,2) AS expenses
           FROM expenses e WHERE e.school_id=$1 AND e.status='paid'
             AND ($2::date IS NULL OR e.paid_at::date >= $2::date) AND ($3::date IS NULL OR e.paid_at::date <= $3::date)
             AND ($4::uuid IS NULL OR e.academic_term_id=$4::uuid)
           GROUP BY date_trunc('month',e.paid_at)
         ), monthly_payroll AS (
           SELECT date_trunc('month',r.paid_at)::date AS month_start,sum(r.net_total)::numeric(14,2) AS payroll
           FROM payroll_runs r WHERE r.school_id=$1 AND r.status='paid'
             AND ($2::date IS NULL OR r.paid_at::date >= $2::date) AND ($3::date IS NULL OR r.paid_at::date <= $3::date)
           GROUP BY date_trunc('month',r.paid_at)
         ), months AS (
           SELECT generate_series(
             date_trunc('month',COALESCE($2::date,current_date-interval '11 months')),
             date_trunc('month',COALESCE($3::date,current_date)), interval '1 month')::date AS month_start
         )
         SELECT to_char(m.month_start,'YYYY-MM') AS month,
           COALESCE(i.income,0)::numeric(14,2)::text AS income,
           COALESCE(e.expenses,0)::numeric(14,2)::text AS expenses,
           COALESCE(p.payroll,0)::numeric(14,2)::text AS payroll,
           (COALESCE(e.expenses,0)+COALESCE(p.payroll,0))::numeric(14,2)::text AS total_outflow
         FROM months m LEFT JOIN monthly_income i USING(month_start)
         LEFT JOIN monthly_expenses e USING(month_start) LEFT JOIN monthly_payroll p USING(month_start)
         ORDER BY m.month_start`,[auth.schoolId,dates.from,dates.to,academicTermId]);
     const payroll=await c.query(
       `SELECT COALESCE(sum(net_total) FILTER (WHERE status='paid' AND ($2::date IS NULL OR paid_at::date >= $2::date) AND ($3::date IS NULL OR paid_at::date <= $3::date)),0)::numeric(14,2)::text AS paid_total,
         COALESCE(sum(net_total) FILTER (WHERE status<>'paid'),0)::numeric(14,2)::text AS pending_total,
         count(*) FILTER (WHERE status<>'paid')::int AS pending_runs
        FROM payroll_runs WHERE school_id=$1`,[auth.schoolId,dates.from,dates.to]);
     const cashPosition=await c.query(
       `WITH balances AS (
          SELECT a.id,a.code,a.name,COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.debit-l.credit ELSE 0 END),0) AS balance
          FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
          LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
            AND ($2::date IS NULL OR j.posting_date <= $2::date)
          WHERE a.school_id=$1 AND a.account_type='asset'
          GROUP BY a.id,a.code,a.name
        ), classified AS (
          SELECT b.*,
            (b.code='1000' OR lower(b.name) LIKE '%cash%') AS is_cash,
            EXISTS(SELECT 1 FROM bank_accounts ba WHERE ba.school_id=$1 AND ba.ledger_account_id=b.id AND ba.is_active=true)
              AND b.code<>'1000' AND lower(b.name) NOT LIKE '%mpesa%' AND lower(b.name) NOT LIKE '%m-pesa%' AS is_bank,
            (lower(b.name) LIKE '%mpesa%' OR lower(b.name) LIKE '%m-pesa%' OR lower(b.name) LIKE '%mobile money%' OR lower(b.code) LIKE '%mpesa%') AS is_mpesa
          FROM balances b
        )
        SELECT COALESCE(sum(balance) FILTER (WHERE is_cash AND NOT is_mpesa),0)::numeric(14,2)::text AS cash_balance,
          COALESCE(sum(balance) FILTER (WHERE is_bank AND NOT is_cash),0)::numeric(14,2)::text AS bank_balance,
          COALESCE(sum(balance) FILTER (WHERE is_mpesa),0)::numeric(14,2)::text AS mpesa_balance,
          COALESCE(sum(balance) FILTER (WHERE is_cash OR is_bank OR is_mpesa),0)::numeric(14,2)::text AS total_available_funds
        FROM classified`,[auth.schoolId,dates.to]);
     const overdue=await c.query(
       `SELECT count(DISTINCT i.student_id)::int AS overdue_fee_accounts
        FROM fee_invoices i
        WHERE i.school_id=$1 AND i.status<>'void' AND i.due_on<current_date
          AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date)
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
          AND i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)
            -COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)>0`,
       [auth.schoolId,dates.from,dates.to,academicTermId]);
     const unmatchedMpesa=await c.query(
       `SELECT count(*)::int AS unmatched_mpesa_payments
        FROM fee_receipts r WHERE r.school_id=$1 AND r.status='posted' AND r.payment_method='mpesa'
          AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id
            JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid))
          AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.school_id=r.school_id
            AND trim(COALESCE(b.reference,''))<>'' AND trim(COALESCE(b.reference,''))=trim(COALESCE(r.external_reference,'')))`,
       [auth.schoolId,dates.from,dates.to,academicTermId]);
     const periodsAwaitingClosure=await c.query(
       "SELECT count(*)::int AS periods_awaiting_closure FROM accounting_periods WHERE school_id=$1 AND status='open' AND ends_on<current_date",
       [auth.schoolId]);
     const bank=await c.query("SELECT count(*)::int AS unmatched FROM bank_statement_lines WHERE school_id=$1 AND matched_at IS NULL",[auth.schoolId]);
    const journals=await c.query("SELECT count(*)::int AS posted_count FROM journal_entries WHERE school_id=$1 AND status='posted' AND ($2::date IS NULL OR posting_date >= $2::date) AND ($3::date IS NULL OR posting_date <= $3::date)",[auth.schoolId,dates.from,dates.to]);
    const netCashPosition=(Number(fees.rows[0].collected??0)-Number(expenses.rows[0].paid_total??0)-Number(payroll.rows[0].paid_total??0)).toFixed(2);
    return {fees:fees.rows[0],expenses:expenses.rows[0],payroll:payroll.rows[0],cashPosition:cashPosition.rows[0],netCashPosition,recentPayments:recentPayments.rows,pendingApprovals:pendingApprovals.rows,topOutstanding:topOutstanding.rows,feeCollectionTrend:feeCollectionTrend.rows,incomeExpenseTrend:incomeExpenseTrend.rows,unmatchedBankLines:bank.rows[0].unmatched,unmatchedMpesaPayments:unmatchedMpesa.rows[0].unmatched_mpesa_payments,periodsAwaitingClosure:periodsAwaitingClosure.rows[0].periods_awaiting_closure,overdueFeeAccounts:overdue.rows[0].overdue_fee_accounts,postedJournals:journals.rows[0].posted_count,filters:{from:dates.from,to:dates.to,academicTermId}};
   });
   res.json({schoolId:auth.schoolId,summary:data});
}));

const openingBalanceSchema=z.object({financialYearId:z.string().uuid(),postingDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),description:z.string().trim().min(3).max(500),lines:z.array(z.object({accountId:z.string().uuid(),debit:z.string(),credit:z.string(),memo:z.string().max(500).optional()})).min(2).max(500)});
operationsRouter.post('/accounting/opening-balances',requirePermission('school.manage'),wrap(async(req,res)=>{
  const p=openingBalanceSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Invalid opening balance journal.',details:p.error.flatten()});return;}
  const auth=authContext(req);const d=p.data;
  try{
    const result=await withSchoolTransaction(auth.schoolId,async c=>{
      const year=await c.query("SELECT id,starts_on,status FROM financial_years WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,d.financialYearId]);
      if(!year.rowCount||year.rows[0].status!=='open'||sqlDate(year.rows[0].starts_on)!==d.postingDate)throw Object.assign(new Error('Opening balances must be posted on the start date of an open financial year.'),{statusCode:422});
      const existing=await c.query("SELECT count(*)::int AS n FROM journal_entries WHERE school_id=$1 AND financial_year_id=$2 AND status='posted'",[auth.schoolId,d.financialYearId]);
      if(existing.rows[0].n>0)throw Object.assign(new Error('Opening balances can only be posted before any other journal in the financial year.'),{statusCode:409});
      const lines=d.lines.map(l=>({accountId:l.accountId,debit:amountString(parseKesToMinorUnits(l.debit)),credit:amountString(parseKesToMinorUnits(l.credit)),memo:l.memo}));
      const journal=await postJournal(c,auth.schoolId,auth.userId,d.postingDate,d.description,'opening_balance',d.financialYearId,lines);
      await audit(c,auth.schoolId,auth.userId,'accounting.opening_balances.post','journal_entry',journal.id,{financialYearId:d.financialYearId,lineCount:lines.length});
      return journal;
    });
    res.status(201).json({journal:result});
  }catch(error){if(!handleError(res,error))throw error;}
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


operationsRouter.get('/roles',requirePermission('users.manage'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT r.id,r.name,COALESCE(json_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL),'[]'::json) AS permissions
     FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id
     WHERE r.school_id=$1 GROUP BY r.id ORDER BY r.name`,[auth.schoolId]));
  res.json({roles:result.rows});
}));
operationsRouter.get('/permissions',requirePermission('users.manage'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query('SELECT code,description FROM permissions ORDER BY code'));
  res.json({permissions:result.rows});
}));
const roleSchema=z.object({name:z.string().trim().min(2).max(80).regex(/^[a-zA-Z0-9 _-]+$/),permissions:z.array(z.string().min(2).max(100)).min(1).max(100)});
operationsRouter.post('/roles',requirePermission('users.manage'),wrap(async(req,res)=>{
  const p=roleSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Invalid role details.',details:p.error.flatten()});return;}
  const auth=authContext(req);const name=p.data.name.trim().toLowerCase();
  try{
    const role=await withSchoolTransaction(auth.schoolId,async c=>{
      const codes=[...new Set(p.data.permissions)];
      const known=await c.query('SELECT code FROM permissions WHERE code=ANY($1::text[])',[codes]);
      if(known.rowCount!==codes.length)throw Object.assign(new Error('One or more permissions are unknown.'),{statusCode:422});
      const id=randomUUID();await c.query('INSERT INTO roles (id,school_id,name) VALUES ($1,$2,$3)',[id,auth.schoolId,name]);
      for(const code of codes)await c.query('INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,$2)',[id,code]);
      await audit(c,auth.schoolId,auth.userId,'role.create','role',id,{name,permissions:codes});
      return {id,name,permissions:codes};
    });
    res.status(201).json({role});
  }catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.put('/roles/:id/permissions',requirePermission('users.manage'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);const p=z.object({permissions:z.array(z.string().min(2).max(100)).min(1).max(100)}).safeParse(req.body);
  if(!id.success||!p.success){res.status(400).json({error:'Invalid role permission update.'});return;}
  const auth=authContext(req);
  try{
    const role=await withSchoolTransaction(auth.schoolId,async c=>{
      const found=await c.query('SELECT id,name FROM roles WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,id.data]);
      if(!found.rowCount)throw Object.assign(new Error('Role not found in this school.'),{statusCode:404});
      if(['school_admin','bursar','accountant','approver','auditor'].includes(String(found.rows[0].name)))throw Object.assign(new Error('Built-in roles cannot be redefined. Create a custom role instead.'),{statusCode:409});
      const codes=[...new Set(p.data.permissions)];const known=await c.query('SELECT code FROM permissions WHERE code=ANY($1::text[])',[codes]);
      if(known.rowCount!==codes.length)throw Object.assign(new Error('One or more permissions are unknown.'),{statusCode:422});
      await c.query('DELETE FROM role_permissions WHERE role_id=$1',[id.data]);
      for(const code of codes)await c.query('INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,$2)',[id.data,code]);
      await audit(c,auth.schoolId,auth.userId,'role.permissions.update','role',id.data,{permissions:codes});
      return {id:id.data,name:String(found.rows[0].name),permissions:codes};
    });
    res.json({role});
  }catch(error){if(!handleError(res,error))throw error;}
}));


operationsRouter.put('/users/:id/role',requirePermission('users.manage'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);const p=z.object({role:z.string().trim().min(2).max(80)}).safeParse(req.body);
  if(!id.success||!p.success){res.status(400).json({error:'Invalid membership role update.'});return;}
  const auth=authContext(req);
  try{
    const result=await withSchoolTransaction(auth.schoolId,async c=>{
      const membership=await c.query('SELECT m.role_id,r.name AS role_name FROM school_memberships m JOIN roles r ON r.id=m.role_id AND r.school_id=m.school_id WHERE m.school_id=$1 AND m.user_id=$2 AND m.status=\'active\' FOR UPDATE',[auth.schoolId,id.data]);
      if(!membership.rowCount)throw Object.assign(new Error('Active school membership not found.'),{statusCode:404});
      const next=await c.query('SELECT id FROM roles WHERE school_id=$1 AND name=$2',[auth.schoolId,p.data.role.toLowerCase()]);
      if(!next.rowCount)throw Object.assign(new Error('Role not found in this school.'),{statusCode:422});
      if(String(membership.rows[0].role_name)==='school_admin'&&p.data.role.toLowerCase()!=='school_admin'){
        const count=await c.query("SELECT count(*)::int AS n FROM school_memberships m JOIN roles r ON r.id=m.role_id AND r.school_id=m.school_id WHERE m.school_id=$1 AND m.status='active' AND r.name='school_admin' AND m.user_id<>$2",[auth.schoolId,id.data]);
        if(count.rows[0].n<1)throw Object.assign(new Error('Cannot remove the last active school administrator.'),{statusCode:409});
      }
      await c.query('UPDATE school_memberships SET role_id=$3 WHERE school_id=$1 AND user_id=$2',[auth.schoolId,id.data,next.rows[0].id]);
      await audit(c,auth.schoolId,auth.userId,'user.role.update','user',id.data,{from:membership.rows[0].role_name,to:p.data.role});
      return {userId:id.data,role:p.data.role.toLowerCase()};
    });
    res.json({membership:result});
  }catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.post('/users/:id/reset-password',requirePermission('users.manage'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);const p=z.object({newPassword:z.string().min(12).max(200)}).safeParse(req.body);
  if(!id.success||!p.success){res.status(400).json({error:'Provide a valid user ID and a password of at least 12 characters.'});return;}
  const auth=authContext(req);if(id.data===auth.userId){res.status(422).json({error:'Use the change-password screen to change your own password.'});return;}
  try{
    const result=await withSchoolTransaction(auth.schoolId,async c=>{
      const membership=await c.query("SELECT user_id FROM school_memberships WHERE school_id=$1 AND user_id=$2 AND status='active'",[auth.schoolId,id.data]);
      if(!membership.rowCount)throw Object.assign(new Error('Active school membership not found.'),{statusCode:404});
      const {hashPassword}=await import('./auth.js');
      await c.query('UPDATE users SET password_hash=$2,must_change_password=true,password_changed_at=now() WHERE id=$1',[id.data,await hashPassword(p.data.newPassword)]);
      await audit(c,auth.schoolId,auth.userId,'user.password.reset','user',id.data);
      return {userId:id.data,mustChangePassword:true};
    });
    res.json({reset:result,message:'Password reset. Existing sessions across schools are invalidated; the user must change this password at next sign-in.'});
  }catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.get('/users',requirePermission('users.manage'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT u.id,u.email,u.full_name,u.status,m.status AS membership_status,r.name AS role,m.created_at
     FROM school_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id AND r.school_id=m.school_id
     WHERE m.school_id=$1 ORDER BY u.full_name LIMIT 500`,[auth.schoolId]));
  res.json({users:result.rows});
}));
const userCreateSchema=z.object({fullName:z.string().trim().min(2).max(160),email:z.string().trim().email().max(254),role:z.string().trim().min(2).max(80),password:z.string().min(12).max(200)});

const invitationSchema=z.object({email:z.string().trim().email().max(254),role:z.string().trim().min(2).max(80)});
operationsRouter.post('/users/invitations',requirePermission('users.manage'),wrap(async(req,res)=>{
  const p=invitationSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Invalid invitation details.',details:p.error.flatten()});return;}
  const auth=authContext(req);const email=p.data.email.toLowerCase();const roleName=p.data.role.toLowerCase();
  try{
    const invitation=await withSchoolTransaction(auth.schoolId,async c=>{
      const role=await c.query('SELECT id FROM roles WHERE school_id=$1 AND name=$2',[auth.schoolId,roleName]);
      if(!role.rowCount)throw Object.assign(new Error('Role not found in this school.'),{statusCode:422});
      const user=await c.query('SELECT id FROM users WHERE lower(email)=lower($1) AND status=\'active\'',[email]);
      if(!user.rowCount)throw Object.assign(new Error('Only an existing active account can accept a workspace invitation. Create a temporary account first for new staff.'),{statusCode:422});
      const member=await c.query('SELECT 1 FROM school_memberships WHERE school_id=$1 AND user_id=$2',[auth.schoolId,user.rows[0].id]);
      if(member.rowCount)throw Object.assign(new Error('This user already has a membership in this school.'),{statusCode:409});
      await c.query('UPDATE school_invitations SET revoked_at=now() WHERE school_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL AND revoked_at IS NULL',[auth.schoolId,email]);
      const id=randomUUID();const token=auth.schoolId+'.'+randomBytes(32).toString('base64url');const tokenHash=createHash('sha256').update(token).digest('hex');
      const expiresAt=new Date(Date.now()+7*24*60*60*1000);
      await c.query('INSERT INTO school_invitations (id,school_id,email,role_id,token_hash,invited_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,auth.schoolId,email,role.rows[0].id,tokenHash,auth.userId,expiresAt]);
      await audit(c,auth.schoolId,auth.userId,'user.invitation.create','school_invitation',id,{email,role:roleName,expiresAt:expiresAt.toISOString()});
      return {id,email,role:roleName,token,expiresAt:expiresAt.toISOString()};
    });
    res.status(201).json({invitation,message:'Share the token with the account holder through a trusted channel. The token is shown only once and expires in seven days.'});
  }catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.post('/users',requirePermission('users.manage'),wrap(async(req,res)=>{
  const p=userCreateSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Invalid user details.',details:p.error.flatten()});return;}
  const auth=authContext(req);const d=p.data;const email=d.email.toLowerCase();
  try{
    const result=await withSchoolTransaction(auth.schoolId,async c=>{
      const role=await c.query('SELECT id FROM roles WHERE school_id=$1 AND name=$2',[auth.schoolId,d.role]);
      if(!role.rowCount)throw Object.assign(new Error('Requested role is not configured for this school.'),{statusCode:422});
      let user=await c.query('SELECT id FROM users WHERE lower(email)=lower($1)',[email]);
      let userId:string;
      if(user.rowCount){
        const membership=await c.query('SELECT 1 FROM school_memberships WHERE school_id=$1 AND user_id=$2',[auth.schoolId,user.rows[0].id]);
        if(membership.rowCount)throw Object.assign(new Error('This user already has a membership in this school.'),{statusCode:409});
        throw Object.assign(new Error('This email already has an account. Create a school invitation and have the account holder accept it.'),{statusCode:409});
      }else{
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

operationsRouter.get('/fees/arrears',requirePermission('fees.read'),wrap(async(req,res)=>{
 const auth=authContext(req);const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;
 const result=await withSchoolTransaction(auth.schoolId,client=>client.query(
  `WITH invoice_balances AS (
    SELECT i.id,i.student_id,i.due_on,
      (i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)
       -COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0))::numeric(14,2) AS balance
    FROM fee_invoices i LEFT JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id
    WHERE i.school_id=$1 AND i.status NOT IN ('void','reversed') AND ($2::uuid IS NULL OR fs.academic_term_id=$2::uuid)
  ), aged AS (
    SELECT *,CASE WHEN due_on>=current_date THEN 0 ELSE current_date-due_on END AS days_overdue FROM invoice_balances WHERE balance>0
  )
  SELECT s.full_name AS student_name,s.admission_number,s.class_name,
    COALESCE(sum(a.balance) FILTER (WHERE a.days_overdue=0),0)::numeric(14,2)::text AS current,
    COALESCE(sum(a.balance) FILTER (WHERE a.days_overdue BETWEEN 1 AND 30),0)::numeric(14,2)::text AS days_1_30,
    COALESCE(sum(a.balance) FILTER (WHERE a.days_overdue BETWEEN 31 AND 60),0)::numeric(14,2)::text AS days_31_60,
    COALESCE(sum(a.balance) FILTER (WHERE a.days_overdue BETWEEN 61 AND 90),0)::numeric(14,2)::text AS days_61_90,
    COALESCE(sum(a.balance) FILTER (WHERE a.days_overdue>90),0)::numeric(14,2)::text AS days_over_90,
    COALESCE(sum(a.balance),0)::numeric(14,2)::text AS total_outstanding
  FROM aged a JOIN students s ON s.school_id=$1 AND s.id=a.student_id
  GROUP BY s.id,s.full_name,s.admission_number,s.class_name
  HAVING sum(a.balance)>0 ORDER BY sum(a.balance) DESC,s.full_name LIMIT 5000`,[auth.schoolId,academicTermId]));
 res.json({arrears:result.rows});
}));
operationsRouter.get('/fees/statements/:studentId',requirePermission('fees.read'),wrap(async(req,res)=>{
 const id=z.string().uuid().safeParse(req.params.studentId);if(!id.success){res.status(400).json({error:'Invalid student ID.'});return;}
 const dates=reportDateFilters(req,res);if(!dates)return;const auth=authContext(req);
 const result=await withSchoolTransaction(auth.schoolId,async client=>{
  const student=await client.query('SELECT id,admission_number,full_name,class_name FROM students WHERE school_id=$1 AND id=$2',[auth.schoolId,id.data]);
  if(!student.rowCount)throw Object.assign(new Error('Student not found in this school.'),{statusCode:404});
  const rows=await client.query(
   `WITH transactions AS (
     SELECT i.issued_on AS transaction_date,'Invoice'::text AS transaction_type,i.invoice_number AS reference,i.description,
       i.amount::numeric(14,2) AS debit,0::numeric(14,2) AS credit,1 AS sort_order
     FROM fee_invoices i WHERE i.school_id=$1 AND i.student_id=$2
     UNION ALL
     SELECT r.received_on,'Payment',r.receipt_number,'Payment allocated to invoice '||i.invoice_number,
       0::numeric(14,2),a.amount::numeric(14,2),2
     FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id
     JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id
     WHERE a.school_id=$1 AND i.student_id=$2
     UNION ALL
     SELECT w.waived_on,'Waiver / adjustment',w.waiver_number,w.reason,0::numeric(14,2),w.amount::numeric(14,2),3
     FROM fee_waivers w JOIN fee_invoices i ON i.school_id=w.school_id AND i.id=w.invoice_id
     WHERE w.school_id=$1 AND i.student_id=$2 AND w.status IN ('posted','reversed')
     UNION ALL
     SELECT r.received_on,'Student credit',r.receipt_number,'Unallocated payment held as student credit',0::numeric(14,2),cr.amount::numeric(14,2),5
     FROM student_fee_credits cr JOIN fee_receipts r ON r.school_id=cr.school_id AND r.id=cr.receipt_id
     WHERE cr.school_id=$1 AND cr.student_id=$2
     UNION ALL
     SELECT ca.created_at::date,'Credit allocation',r.receipt_number,'Student credit applied to invoice '||i.invoice_number,ca.amount::numeric(14,2),ca.amount::numeric(14,2),3
     FROM student_fee_credit_allocations ca JOIN student_fee_credits cr ON cr.school_id=ca.school_id AND cr.id=ca.credit_id JOIN fee_receipts r ON r.school_id=cr.school_id AND r.id=cr.receipt_id JOIN fee_invoices i ON i.school_id=ca.school_id AND i.id=ca.invoice_id
     WHERE ca.school_id=$1 AND cr.student_id=$2
     UNION ALL
     SELECT ca.reversed_at::date,'Credit allocation reversal',r.receipt_number,'Reversal of student credit allocation to invoice '||i.invoice_number,ca.amount::numeric(14,2),ca.amount::numeric(14,2),4
     FROM student_fee_credit_allocations ca JOIN student_fee_credits cr ON cr.school_id=ca.school_id AND cr.id=ca.credit_id JOIN fee_receipts r ON r.school_id=cr.school_id AND r.id=cr.receipt_id JOIN fee_invoices i ON i.school_id=ca.school_id AND i.id=ca.invoice_id
     WHERE ca.school_id=$1 AND cr.student_id=$2 AND ca.status='reversed'
     UNION ALL
     SELECT rev.posting_date,'Reversal',r.receipt_number,'Reversal of student credit balance',cr.amount::numeric(14,2),0::numeric(14,2),4
     FROM student_fee_credits cr JOIN fee_receipts r ON r.school_id=cr.school_id AND r.id=cr.receipt_id
     JOIN journal_entries rev ON rev.school_id=r.school_id AND rev.reversal_of_id=r.journal_entry_id AND rev.status='posted'
     WHERE cr.school_id=$1 AND cr.student_id=$2 AND cr.status='reversed'
     UNION ALL
     SELECT rev.posting_date,'Reversal',r.receipt_number,'Reversal of receipt allocation for invoice '||i.invoice_number,
       a.amount::numeric(14,2),0::numeric(14,2),4
     FROM fee_receipts r JOIN fee_receipt_allocations a ON a.school_id=r.school_id AND a.receipt_id=r.id
     JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id
     JOIN journal_entries rev ON rev.school_id=r.school_id AND rev.reversal_of_id=r.journal_entry_id AND rev.status='posted'
     WHERE r.school_id=$1 AND i.student_id=$2 AND r.status='reversed'
     UNION ALL
     SELECT rev.posting_date,'Reversal',i.invoice_number,'Reversal of invoice '||i.invoice_number,
       0::numeric(14,2),i.amount::numeric(14,2),4
     FROM fee_invoices i JOIN journal_entries original ON original.school_id=i.school_id AND original.source_type='fee_invoice' AND original.source_id=i.id
     JOIN journal_entries rev ON rev.school_id=original.school_id AND rev.reversal_of_id=original.id AND rev.status='posted'
     WHERE i.school_id=$1 AND i.student_id=$2 AND i.status IN ('void','reversed')
     UNION ALL
     SELECT rev.posting_date,'Reversal',w.waiver_number,'Reversal of waiver '||w.waiver_number,
       w.amount::numeric(14,2),0::numeric(14,2),4
     FROM fee_waivers w JOIN fee_invoices i ON i.school_id=w.school_id AND i.id=w.invoice_id
     JOIN journal_entries original ON original.school_id=w.school_id AND original.source_type='fee_waiver' AND original.source_id=w.id
     JOIN journal_entries rev ON rev.school_id=original.school_id AND rev.reversal_of_id=original.id AND rev.status='posted'
     WHERE w.school_id=$1 AND i.student_id=$2
   ), opening AS (
     SELECT COALESCE(sum(debit-credit) FILTER (WHERE ($3::date IS NOT NULL AND transaction_date<$3::date)),0)::numeric(14,2) AS balance FROM transactions
   ), filtered AS (
     SELECT * FROM transactions WHERE ($3::date IS NULL OR transaction_date >= $3::date) AND ($4::date IS NULL OR transaction_date <= $4::date)
   )
   SELECT transaction_date,transaction_type,reference,description,debit::text,credit::text,
     (SELECT balance FROM opening)+sum(debit-credit) OVER (ORDER BY transaction_date,sort_order,reference ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::numeric(14,2)::text AS running_balance
   FROM filtered ORDER BY transaction_date,sort_order,reference LIMIT 10000`,
   [auth.schoolId,id.data,dates.from,dates.to]);
  const opening=await client.query(
   `WITH tx AS (
     SELECT i.issued_on AS d,i.amount AS delta FROM fee_invoices i WHERE i.school_id=$1 AND i.student_id=$2
     UNION ALL SELECT r.received_on,-a.amount FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id WHERE a.school_id=$1 AND i.student_id=$2
     UNION ALL SELECT w.waived_on,-w.amount FROM fee_waivers w JOIN fee_invoices i ON i.school_id=w.school_id AND i.id=w.invoice_id WHERE w.school_id=$1 AND i.student_id=$2 AND w.status IN ('posted','reversed')
     UNION ALL SELECT rev.posting_date,a.amount FROM fee_receipts r JOIN fee_receipt_allocations a ON a.school_id=r.school_id AND a.receipt_id=r.id JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN journal_entries rev ON rev.school_id=r.school_id AND rev.reversal_of_id=r.journal_entry_id AND rev.status='posted' WHERE r.school_id=$1 AND i.student_id=$2 AND r.status='reversed'
     UNION ALL SELECT r.received_on,-cr.amount FROM student_fee_credits cr JOIN fee_receipts r ON r.school_id=cr.school_id AND r.id=cr.receipt_id WHERE cr.school_id=$1 AND cr.student_id=$2
     UNION ALL SELECT rev.posting_date,cr.amount FROM student_fee_credits cr JOIN fee_receipts r ON r.school_id=cr.school_id AND r.id=cr.receipt_id JOIN journal_entries rev ON rev.school_id=r.school_id AND rev.reversal_of_id=r.journal_entry_id AND rev.status='posted' WHERE cr.school_id=$1 AND cr.student_id=$2 AND cr.status='reversed'
     UNION ALL SELECT rev.posting_date,-i.amount FROM fee_invoices i JOIN journal_entries original ON original.school_id=i.school_id AND original.source_type='fee_invoice' AND original.source_id=i.id JOIN journal_entries rev ON rev.school_id=original.school_id AND rev.reversal_of_id=original.id AND rev.status='posted' WHERE i.school_id=$1 AND i.student_id=$2 AND i.status IN ('void','reversed')
     UNION ALL SELECT rev.posting_date,w.amount FROM fee_waivers w JOIN fee_invoices i ON i.school_id=w.school_id AND i.id=w.invoice_id JOIN journal_entries original ON original.school_id=w.school_id AND original.source_type='fee_waiver' AND original.source_id=w.id JOIN journal_entries rev ON rev.school_id=original.school_id AND rev.reversal_of_id=original.id AND rev.status='posted' WHERE w.school_id=$1 AND i.student_id=$2
   ) SELECT COALESCE(sum(delta) FILTER (WHERE ($3::date IS NOT NULL AND d<$3::date)),0)::numeric(14,2)::text AS opening_balance FROM tx`,
   [auth.schoolId,id.data,dates.from]);
  return {student:student.rows[0],openingBalance:opening.rows[0].opening_balance,transactions:rows.rows,from:dates.from,to:dates.to};
 });
 res.json({statement:result});
}));
const schoolClassSchema=z.object({name:z.string().trim().min(1).max(120)});
operationsRouter.get('/settings/classes',requirePermission('fees.read'),wrap(async(req,res)=>{const auth=authContext(req);const result=await withSchoolTransaction(auth.schoolId,client=>client.query('SELECT id,name,is_active,created_at FROM school_classes WHERE school_id=$1 ORDER BY is_active DESC,name',[auth.schoolId]));res.json({classes:result.rows});}));
operationsRouter.post('/settings/classes',requirePermission('school.manage'),wrap(async(req,res)=>{const p=schoolClassSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Enter a class or stream name.'});return;}const auth=authContext(req);try{const result=await withSchoolTransaction(auth.schoolId,async client=>{const row=await client.query('INSERT INTO school_classes (id,school_id,name,created_by) VALUES ($1,$2,$3,$4) RETURNING id,name,is_active,created_at',[randomUUID(),auth.schoolId,p.data.name,auth.userId]);await audit(client,auth.schoolId,auth.userId,'school.class.create','school_class',row.rows[0].id,{name:p.data.name});return row.rows[0];});res.status(201).json({class:result});}catch(error){if(!handleError(res,error))throw error;}}));
const schoolFeeItemSchema=z.object({name:z.string().trim().min(1).max(100),defaultAmount:z.string().regex(/^\d+(?:\.\d{1,2})?$/).optional()});
operationsRouter.put('/settings/fee-items/:id',requirePermission('school.manage'),wrap(async(req,res)=>{
 const id=z.string().uuid().safeParse(req.params.id);const p=z.object({name:z.string().trim().min(1).max(100),defaultAmount:z.string().regex(/^\d+(?:\.\d{1,2})?$/),isActive:z.preprocess(value=>value==='true'?true:value==='false'?false:value,z.boolean())}).safeParse(req.body);if(!id.success||!p.success){res.status(400).json({error:'Provide a fee item name, default amount and active state.'});return;}const auth=authContext(req);
 try{const row=await withSchoolTransaction(auth.schoolId,async client=>{const result=await client.query('UPDATE school_fee_items SET name=$3,default_amount=$4,is_active=$5 WHERE school_id=$1 AND id=$2 RETURNING id,name,default_amount::text,is_active,created_at',[auth.schoolId,id.data,p.data.name,p.data.defaultAmount,p.data.isActive]);if(!result.rowCount)throw Object.assign(new Error('Fee item not found.'),{statusCode:404});await audit(client,auth.schoolId,auth.userId,'school.fee_item.update','school_fee_item',id.data,{name:p.data.name,defaultAmount:p.data.defaultAmount,isActive:p.data.isActive});return result.rows[0];});res.json({feeItem:row});}catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.get('/settings/fee-items',requirePermission('fees.read'),wrap(async(req,res)=>{const auth=authContext(req);const result=await withSchoolTransaction(auth.schoolId,client=>client.query('SELECT id,name,default_amount::text,is_active,created_at FROM school_fee_items WHERE school_id=$1 ORDER BY is_active DESC,name',[auth.schoolId]));res.json({feeItems:result.rows});}));
operationsRouter.post('/settings/fee-items',requirePermission('school.manage'),wrap(async(req,res)=>{const p=schoolFeeItemSchema.safeParse(req.body);if(!p.success){res.status(400).json({error:'Enter a fee item name and a valid optional default amount.'});return;}const auth=authContext(req);try{const result=await withSchoolTransaction(auth.schoolId,async client=>{const row=await client.query('INSERT INTO school_fee_items (id,school_id,name,default_amount,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,default_amount::text,is_active,created_at',[randomUUID(),auth.schoolId,p.data.name,p.data.defaultAmount??'0',auth.userId]);await audit(client,auth.schoolId,auth.userId,'school.fee_item.create','school_fee_item',row.rows[0].id,{name:p.data.name,defaultAmount:row.rows[0].default_amount});return row.rows[0];});res.status(201).json({feeItem:result});}catch(error){if(!handleError(res,error))throw error;}}));

operationsRouter.get('/fees/credits',requirePermission('fees.read'),wrap(async(req,res)=>{const auth=authContext(req);const result=await withSchoolTransaction(auth.schoolId,client=>client.query(`SELECT cr.id,cr.student_id,s.admission_number,s.full_name AS student_name,s.class_name,r.receipt_number,cr.amount::text,cr.remaining_amount::text,cr.created_at,COALESCE((SELECT json_agg(json_build_object('id',ca.id,'invoiceNumber',i.invoice_number,'amount',ca.amount::text,'status',ca.status) ORDER BY ca.created_at) FROM student_fee_credit_allocations ca JOIN fee_invoices i ON i.school_id=ca.school_id AND i.id=ca.invoice_id WHERE ca.school_id=cr.school_id AND ca.credit_id=cr.id),'[]'::json) AS allocations FROM student_fee_credits cr JOIN students s ON s.school_id=cr.school_id AND s.id=cr.student_id JOIN fee_receipts r ON r.school_id=cr.school_id AND r.id=cr.receipt_id WHERE cr.school_id=$1 AND cr.status='posted' AND (cr.remaining_amount>0 OR EXISTS (SELECT 1 FROM student_fee_credit_allocations ca WHERE ca.school_id=cr.school_id AND ca.credit_id=cr.id AND ca.status='posted')) ORDER BY cr.created_at DESC LIMIT 1000`,[auth.schoolId]));res.json({credits:result.rows});}));
const creditAllocationSchema=z.object({invoiceId:z.string().uuid(),amount:z.string().regex(/^\d+(?:\.\d{1,2})?$/)});
operationsRouter.post('/fees/credits/:id/allocate',requirePermission('receipts.create'),wrap(async(req,res)=>{
 const id=z.string().uuid().safeParse(req.params.id);const body=creditAllocationSchema.safeParse(req.body);if(!id.success||!body.success){res.status(400).json({error:'Provide a student credit ID, invoice and positive amount.'});return;}
 const auth=authContext(req);const amount=parseKesToMinorUnits(body.data.amount);if(amount<=0n){res.status(422).json({error:'Credit allocation must be positive.'});return;}
 try{const result=await withSchoolTransaction(auth.schoolId,async client=>{
  const credit=await client.query("SELECT id,student_id,remaining_amount::text,status FROM student_fee_credits WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);if(!credit.rowCount||credit.rows[0].status!=='posted')throw Object.assign(new Error('Student credit is not available.'),{statusCode:404});if(amount>parseKesToMinorUnits(String(credit.rows[0].remaining_amount)))throw Object.assign(new Error('Allocation exceeds the remaining student credit.'),{statusCode:422});
  const invoice=await client.query("SELECT id,student_id,amount::text,status FROM fee_invoices WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,body.data.invoiceId]);if(!invoice.rowCount||invoice.rows[0].student_id!==credit.rows[0].student_id||['void','reversed'].includes(String(invoice.rows[0].status)))throw Object.assign(new Error('Choose a valid invoice belonging to the same student.'),{statusCode:422});
  const settled=await client.query(`SELECT COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id WHERE a.school_id=$1 AND a.invoice_id=$2 AND r.status='posted'),0)::text AS paid,COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=$1 AND w.invoice_id=$2 AND w.status='posted'),0)::text AS waived,COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=$1 AND ca.invoice_id=$2 AND ca.status='posted'),0)::text AS credited`,[auth.schoolId,body.data.invoiceId]);
  const outstanding=parseKesToMinorUnits(String(invoice.rows[0].amount))-parseKesToMinorUnits(String(settled.rows[0].paid))-parseKesToMinorUnits(String(settled.rows[0].waived))-parseKesToMinorUnits(String(settled.rows[0].credited));if(amount>outstanding)throw Object.assign(new Error('Credit allocation exceeds the invoice outstanding balance.'),{statusCode:422});
  const allocationId=randomUUID();await client.query('INSERT INTO student_fee_credit_allocations (id,school_id,credit_id,invoice_id,amount) VALUES ($1,$2,$3,$4,$5)',[allocationId,auth.schoolId,id.data,body.data.invoiceId,amountString(amount)]);await client.query('UPDATE student_fee_credits SET remaining_amount=remaining_amount-$3 WHERE school_id=$1 AND id=$2',[auth.schoolId,id.data,amountString(amount)]);
  const total=parseKesToMinorUnits(String(settled.rows[0].paid))+parseKesToMinorUnits(String(settled.rows[0].waived))+parseKesToMinorUnits(String(settled.rows[0].credited))+amount;await client.query("UPDATE fee_invoices SET status=CASE WHEN $3::numeric>=amount THEN 'paid' WHEN $4::numeric>0 THEN 'part_paid' ELSE 'issued' END WHERE school_id=$1 AND id=$2",[auth.schoolId,body.data.invoiceId,amountString(total),amountString(total)]);
  await audit(client,auth.schoolId,auth.userId,'student.fee_credit.allocate','student_fee_credit_allocation',allocationId,{creditId:id.data,invoiceId:body.data.invoiceId,amount:amountString(amount)});return {id:allocationId,creditId:id.data,invoiceId:body.data.invoiceId,amount:amountString(amount),status:'posted'};
 });res.status(201).json({allocation:result});}catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.post('/fees/credits/allocations/:allocationId/reverse',requirePermission('receipts.create'),wrap(async(req,res)=>{
 const id=z.string().uuid().safeParse(req.params.allocationId);const body=z.object({reason:z.string().trim().min(3).max(500)}).safeParse(req.body);if(!id.success||!body.success){res.status(400).json({error:'Provide a credit allocation ID and reversal reason.'});return;}
 const auth=authContext(req);
 try{const result=await withSchoolTransaction(auth.schoolId,async client=>{
  const allocation=await client.query("SELECT ca.id,ca.credit_id,ca.invoice_id,ca.amount::text,ca.status,cr.student_id FROM student_fee_credit_allocations ca JOIN student_fee_credits cr ON cr.school_id=ca.school_id AND cr.id=ca.credit_id WHERE ca.school_id=$1 AND ca.id=$2 FOR UPDATE OF ca,cr",[auth.schoolId,id.data]);if(!allocation.rowCount||allocation.rows[0].status!=='posted')throw Object.assign(new Error('Only an active credit allocation can be reversed.'),{statusCode:409});const row=allocation.rows[0];
  await client.query("UPDATE student_fee_credit_allocations SET status='reversed',reversed_by=$3,reversed_at=now(),reversal_reason=$4 WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data,auth.userId,body.data.reason]);await client.query('UPDATE student_fee_credits SET remaining_amount=remaining_amount+$3 WHERE school_id=$1 AND id=$2 AND status=\'posted\'',[auth.schoolId,row.credit_id,row.amount]);
  const settled=await client.query(`SELECT i.amount::text,COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)::text AS paid,COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)::text AS waived,COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)::text AS credited FROM fee_invoices i WHERE i.school_id=$1 AND i.id=$2`,[auth.schoolId,row.invoice_id]);const total=parseKesToMinorUnits(String(settled.rows[0].paid))+parseKesToMinorUnits(String(settled.rows[0].waived))+parseKesToMinorUnits(String(settled.rows[0].credited));const amount=parseKesToMinorUnits(String(settled.rows[0].amount));await client.query("UPDATE fee_invoices SET status=CASE WHEN $3::numeric>=amount THEN 'paid' WHEN $4::numeric>0 THEN 'part_paid' ELSE 'issued' END WHERE school_id=$1 AND id=$2",[auth.schoolId,row.invoice_id,amountString(total),amountString(total)]);
  await audit(client,auth.schoolId,auth.userId,'student.fee_credit.allocation.reverse','student_fee_credit_allocation',id.data,{creditId:row.credit_id,invoiceId:row.invoice_id,reason:body.data.reason});return {id:id.data,status:'reversed',reason:body.data.reason};
 });res.json({allocation:result});}catch(error){if(!handleError(res,error))throw error;}
}));
const waiverSchema=z.object({invoiceId:z.string().uuid(),waiverNumber:z.string().trim().min(1).max(60),adjustmentType:z.enum(['waiver','scholarship','discount','correction','credit_adjustment']).default('waiver'),amount:z.string(),reason:z.string().trim().min(3).max(500),waivedOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()});
operationsRouter.get('/fees/waivers',requirePermission('fees.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const r=await withSchoolTransaction(auth.schoolId,c=>c.query(
    'SELECT w.id,w.waiver_number,w.adjustment_type,w.invoice_id,i.invoice_number,w.amount::text,w.reason,w.waived_on,w.status,w.created_by,w.approved_by,w.approved_at,w.rejection_reason,w.rejected_by,w.rejected_at,w.journal_entry_id FROM fee_waivers w JOIN fee_invoices i ON i.id=w.invoice_id AND i.school_id=w.school_id WHERE w.school_id=$1 ORDER BY w.created_at DESC LIMIT 500',[auth.schoolId]));
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
         COALESCE((SELECT sum(amount) FROM fee_waivers WHERE school_id=$1 AND invoice_id=$2 AND status='posted'),0)::text AS waived,COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=$1 AND ca.invoice_id=$2 AND ca.status='posted'),0)::text AS credited`,[auth.schoolId,d.invoiceId]);
      const outstanding=parseKesToMinorUnits(String(inv.rows[0].amount))-parseKesToMinorUnits(String(settled.rows[0].allocated))-parseKesToMinorUnits(String(settled.rows[0].waived))-parseKesToMinorUnits(String(settled.rows[0].credited));
      if(amount>outstanding)throw Object.assign(new Error('Waiver exceeds the invoice outstanding balance.'),{statusCode:422});
      const id=randomUUID();
      await c.query("INSERT INTO fee_waivers (id,school_id,waiver_number,adjustment_type,invoice_id,amount,reason,waived_on,created_by,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted')",[id,auth.schoolId,d.waiverNumber,d.adjustmentType,d.invoiceId,amountString(amount),d.reason,waivedOn,auth.userId]);
      await audit(c,auth.schoolId,auth.userId,'fee.waiver.submit','fee_waiver',id,{invoiceId:d.invoiceId,adjustmentType:d.adjustmentType,amount:amountString(amount),reason:d.reason});
      return {id,waiverNumber:d.waiverNumber,adjustmentType:d.adjustmentType,invoiceId:d.invoiceId,amount:amountString(amount),reason:d.reason,status:'submitted'};
    });
    res.status(201).json({waiver,message:'Waiver submitted. A different authorized user must approve it before it affects the ledger.'});
  }catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.post('/fees/waivers/:id/reject',requirePermission('fees.manage'),wrap(async(req,res)=>{
 const id=z.string().uuid().safeParse(req.params.id);const body=z.object({reason:z.string().trim().min(3).max(500)}).safeParse(req.body);
 if(!id.success||!body.success){res.status(400).json({error:'Provide a waiver ID and rejection reason.'});return;}
 const auth=authContext(req);
 try{const result=await withSchoolTransaction(auth.schoolId,async client=>{const found=await client.query('SELECT id,waiver_number,status,created_by FROM fee_waivers WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,id.data]);if(!found.rowCount||found.rows[0].status!=='submitted')throw Object.assign(new Error('Only a submitted waiver request can be rejected.'),{statusCode:409});if(String(found.rows[0].created_by)===auth.userId)throw Object.assign(new Error('The requester cannot reject their own adjustment request.'),{statusCode:403});await client.query("UPDATE fee_waivers SET status='rejected',rejection_reason=$3,rejected_by=$4,rejected_at=now() WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data,body.data.reason,auth.userId]);await audit(client,auth.schoolId,auth.userId,'fee.waiver.reject','fee_waiver',id.data,{waiverNumber:found.rows[0].waiver_number,requestedBy:found.rows[0].created_by,reason:body.data.reason});return {id:id.data,status:'rejected',reason:body.data.reason};});res.json({waiver:result});}catch(error){if(!handleError(res,error))throw error;}
}));
operationsRouter.post('/fees/waivers/:id/approve',requirePermission('fees.manage'),wrap(async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.id);if(!id.success){res.status(400).json({error:'Invalid waiver ID.'});return;}
  const auth=authContext(req);
  try{
    const waiver=await withSchoolTransaction(auth.schoolId,async c=>{
      const found=await c.query('SELECT * FROM fee_waivers WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,id.data]);
      if(!found.rowCount||found.rows[0].status!=='submitted')throw Object.assign(new Error('Only a submitted waiver can be approved.'),{statusCode:409});
      const w=found.rows[0];if(String(w.created_by)===auth.userId)throw Object.assign(new Error('The requester cannot approve their own fee waiver.'),{statusCode:403});
      const inv=await c.query('SELECT amount::text,status FROM fee_invoices WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,w.invoice_id]);
      if(!inv.rowCount||inv.rows[0].status==='void')throw Object.assign(new Error('The invoice is no longer available.'),{statusCode:409});
      const settled=await c.query(
        `SELECT COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=$1 AND a.invoice_id=$2 AND r.status='posted'),0)::text AS allocated,
         COALESCE((SELECT sum(amount) FROM fee_waivers WHERE school_id=$1 AND invoice_id=$2 AND status='posted'),0)::text AS waived,COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=$1 AND ca.invoice_id=$2 AND ca.status='posted'),0)::text AS credited`,[auth.schoolId,w.invoice_id]);
      const amount=parseKesToMinorUnits(String(w.amount));const allocated=parseKesToMinorUnits(String(settled.rows[0].allocated));const waived=parseKesToMinorUnits(String(settled.rows[0].waived));const credited=parseKesToMinorUnits(String(settled.rows[0].credited));
      if(amount>parseKesToMinorUnits(String(inv.rows[0].amount))-allocated-waived-credited)throw Object.assign(new Error('Invoice balance changed; the waiver no longer fits the outstanding amount.'),{statusCode:409});
      const journal=await postJournal(c,auth.schoolId,auth.userId,sqlDate(w.waived_on),'Fee waiver '+String(w.waiver_number),'fee_waiver',id.data,[
        {accountCode:'4200',debit:amountString(amount),credit:'0.00'},
        {accountCode:'1200',debit:'0.00',credit:amountString(amount)},
      ]);
      await c.query("UPDATE fee_waivers SET status='posted',approved_by=$3,approved_at=now(),journal_entry_id=$4 WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data,auth.userId,journal.id]);
      const total=allocated+waived+credited+amount;
      await c.query("UPDATE fee_invoices SET status=CASE WHEN $3::numeric>=amount THEN 'paid' WHEN $4::numeric>0 THEN 'part_paid' ELSE 'issued' END WHERE school_id=$1 AND id=$2",[auth.schoolId,w.invoice_id,amountString(total),amountString(total)]);
      await audit(c,auth.schoolId,auth.userId,'fee.waiver.approve','fee_waiver',id.data,{journalEntryId:journal.id,requestedBy:w.created_by});
      return {id:id.data,status:'posted',journalEntryId:journal.id,approvedBy:auth.userId};
    });
    res.json({waiver});
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
           (SELECT count(*) FROM fee_waivers WHERE school_id=$1 AND invoice_id=$2 AND status='posted') AS waivers,
           (SELECT count(*) FROM student_fee_credit_allocations WHERE school_id=$1 AND invoice_id=$2 AND status='posted') AS credits`,[auth.schoolId,sourceId]);
        if(Number(settled.rows[0].receipts)>0||Number(settled.rows[0].waivers)>0||Number(settled.rows[0].credits)>0)throw Object.assign(new Error('Reverse posted receipts and waivers before voiding this invoice.'),{statusCode:409});
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
        const usedCredit=await c.query(`SELECT COALESCE(sum(a.amount),0)::text AS used FROM student_fee_credit_allocations a JOIN student_fee_credits cr ON cr.id=a.credit_id AND cr.school_id=a.school_id WHERE a.school_id=$1 AND cr.receipt_id=$2 AND a.status='posted'`,[auth.schoolId,sourceId]);if(parseKesToMinorUnits(String(usedCredit.rows[0].used))>0n)throw Object.assign(new Error('This receipt has student credit that has already been allocated. Reverse those credit allocations before reversing the receipt.'),{statusCode:409});
        await c.query("UPDATE fee_receipts SET status='reversed' WHERE school_id=$1 AND id=$2",[auth.schoolId,sourceId]);
        await c.query("UPDATE student_fee_credits SET status='reversed',remaining_amount=0 WHERE school_id=$1 AND receipt_id=$2",[auth.schoolId,sourceId]);
        const invoices=await c.query('SELECT DISTINCT invoice_id FROM fee_receipt_allocations WHERE school_id=$1 AND receipt_id=$2',[auth.schoolId,sourceId]);
        for(const row of invoices.rows){
          const settlement=await c.query(
            `SELECT i.amount::text,
             COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=$1 AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated,
             COALESCE((SELECT sum(amount) FROM fee_waivers WHERE school_id=$1 AND invoice_id=i.id AND status='posted'),0)::text AS waived,
             COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=$1 AND ca.invoice_id=i.id AND ca.status='posted'),0)::text AS credited
             FROM fee_invoices i WHERE i.school_id=$1 AND i.id=$2`,[auth.schoolId,row.invoice_id]);
          if(settlement.rowCount){
            const total=parseKesToMinorUnits(String(settlement.rows[0].allocated))+parseKesToMinorUnits(String(settlement.rows[0].waived))+parseKesToMinorUnits(String(settlement.rows[0].credited));
            const amount=parseKesToMinorUnits(String(settlement.rows[0].amount));
            await c.query("UPDATE fee_invoices SET status=CASE WHEN $3::numeric>=amount THEN 'paid' WHEN $4::numeric>0 THEN 'part_paid' ELSE 'issued' END WHERE school_id=$1 AND id=$2",[auth.schoolId,row.invoice_id,amountString(total),amountString(total)]);
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
             COALESCE((SELECT sum(amount) FROM fee_waivers WHERE school_id=$1 AND invoice_id=i.id AND status='posted'),0)::text AS waived,
             COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=$1 AND ca.invoice_id=i.id AND ca.status='posted'),0)::text AS credited
             FROM fee_invoices i WHERE i.school_id=$1 AND i.id=$2`,[auth.schoolId,w.rows[0].invoice_id]);
          if(t.rowCount){const total=parseKesToMinorUnits(String(t.rows[0].allocated))+parseKesToMinorUnits(String(t.rows[0].waived))+parseKesToMinorUnits(String(t.rows[0].credited));await c.query("UPDATE fee_invoices SET status=CASE WHEN $3::numeric>=amount THEN 'paid' WHEN $4::numeric>0 THEN 'part_paid' ELSE 'issued' END WHERE school_id=$1 AND id=$2",[auth.schoolId,w.rows[0].invoice_id,amountString(total),amountString(total)]);}
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
        const posted=await postJournal(c,auth.schoolId,auth.userId,sqlDate(r.rows[0].ends_on),`Year-end close ${r.rows[0].name}`,'year_end_close',id.data,closingLines);
        closingJournalId=posted.id;
      }
      const nextDates=await c.query("SELECT (ends_on+1)::date::text AS starts_on,((ends_on+1)+interval '1 year'-interval '1 day')::date::text AS ends_on FROM financial_years WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data]);
      const nextStart=sqlDate(nextDates.rows[0].starts_on);const nextEnd=sqlDate(nextDates.rows[0].ends_on);
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
async function nextFeeDocumentNumber(c:PoolClient,schoolId:string,prefix:'INV'|'RCT',date:string):Promise<string>{const year=date.slice(0,4);const table=prefix==='INV'?'fee_invoices':'fee_receipts';const column=prefix==='INV'?'invoice_number':'receipt_number';const lockKey=`fee-number:${schoolId}:${prefix}:${year}`;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);const base=`${prefix}-${year}-`;const result=await c.query(`SELECT COALESCE(MAX(CASE WHEN substring(${column} from $3) ~ '^[0-9]+

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
      const r=await c.query('INSERT INTO budgets (school_id,financial_year_id,account_id,name,budget_amount,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,financial_year_id,account_id,budget_amount::text,status',[auth.schoolId,d.financialYearId,d.accountId,d.name,amountString(amount),auth.userId]);
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
      const r=await c.query("SELECT id,status,created_by FROM budgets WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);
      if(!r.rowCount||r.rows[0].status!=='draft')throw Object.assign(new Error('Only a draft budget can be approved.'),{statusCode:409});
      if(r.rows[0].created_by&&String(r.rows[0].created_by)===auth.userId)throw Object.assign(new Error('The budget creator cannot approve their own budget.'),{statusCode:403});
      await c.query("UPDATE budgets SET status='approved',approved_by=$3,approved_at=now() WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data,auth.userId]);
      await audit(c,auth.schoolId,auth.userId,'budget.approve','budget',id.data);
      return {id:id.data,status:'approved'};
    });
    res.json({budget});
  }catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.get('/reports/trial-balance',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const dates=reportDateFilters(req,res);if(!dates)return;
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT a.id,a.code,a.name,a.account_type,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.debit ELSE 0 END),0)::text AS debit,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.credit ELSE 0 END),0)::text AS credit,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.debit-l.credit ELSE 0 END),0)::text AS net
     FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
     LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
     WHERE a.school_id=$1 AND a.is_active=true
     GROUP BY a.id ORDER BY a.code`,[auth.schoolId,dates.from,dates.to]));
  const rows=result.rows.map(r=>({...r,debit:r.debit??'0.00',credit:r.credit??'0.00',net:r.net??'0.00'}));
  const totals=rows.reduce((acc,r)=>({debit:acc.debit+parseKesToMinorUnits(String(r.debit)),credit:acc.credit+parseKesToMinorUnits(String(r.credit))}),{debit:0n,credit:0n});
  res.json({report:'trial-balance',currency:'KES',from:dates.from,to:dates.to,rows,totals:{debit:amountString(totals.debit),credit:amountString(totals.credit),balanced:totals.debit===totals.credit}});
}));

operationsRouter.get('/reports/income-statement',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const dates=reportDateFilters(req,res);if(!dates)return;
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT a.code,a.name,a.account_type,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.credit-l.debit ELSE 0 END),0)::text AS balance
     FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
     LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
     WHERE a.school_id=$1 AND a.account_type IN ('income','expense')
     GROUP BY a.id ORDER BY a.account_type,a.code`,[auth.schoolId,dates.from,dates.to]));
  const signedMinor=(value:unknown):bigint=>{const raw=String(value??'0.00');const negative=raw.startsWith('-');const parsed=parseKesToMinorUnits(negative?raw.slice(1):raw);return negative?-parsed:parsed;};
  const rows=result.rows.map(r=>({...r,balance:amountString(r.account_type==='expense'?-signedMinor(r.balance):signedMinor(r.balance))}));
  let incomeMinor=0n;let expensesMinor=0n;
  for(const row of rows){const amount=signedMinor(row.balance);if(row.account_type==='income')incomeMinor+=amount;else expensesMinor+=amount;}
  res.json({report:'income-statement',currency:'KES',from:dates.from,to:dates.to,rows,totals:{income:amountString(incomeMinor),expenses:amountString(expensesMinor),surplus:amountString(incomeMinor-expensesMinor)}});
}));

operationsRouter.get('/reports/fee-balances',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const dates=reportDateFilters(req,res);if(!dates)return;const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT s.admission_number,s.full_name,i.invoice_number,i.academic_year,i.due_on,i.amount::text,
      COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)::text AS allocated,
      COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)::text AS waived,
      (i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0))::numeric(14,2)::text AS outstanding
     FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
     LEFT JOIN fee_receipt_allocations a ON a.school_id=i.school_id AND a.invoice_id=i.id
     LEFT JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id
     WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
     GROUP BY i.id,s.id HAVING i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)>0
     ORDER BY i.due_on,s.full_name LIMIT 2000`,[auth.schoolId,dates.from,dates.to,academicTermId]));
  res.json({report:'fee-balances',currency:'KES',rows:result.rows});
}));


const reportNames=['trial-balance','income-statement','balance-sheet','general-ledger','cashbook','bankbook','receipts-register','invoice-register','fee-balances','fee-aging','expense-register','supplier-payables','bank-reconciliation','budget-variance','journal-register','collections-by-method','fees-by-class','audit-trail'];
async function buildReportRows(c:PoolClient,schoolId:string,name:string,from:string|null,to:string|null,academicTermId:string|null):Promise<Record<string,unknown>[]>{
  let sql='';
  let params:unknown[]=[schoolId,from,to,academicTermId];
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
       WHERE l.school_id=$1 AND j.status='posted' AND ${name==='cashbook'?"a.code='1000'":"EXISTS (SELECT 1 FROM bank_accounts ba WHERE ba.school_id=a.school_id AND ba.ledger_account_id=a.id)"}
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
       ORDER BY j.posting_date,j.entry_number LIMIT 10000`;break;
    case 'receipts-register':
      sql=`SELECT r.receipt_number,r.received_on,s.admission_number,s.full_name AS student,r.amount::text,r.payment_method,r.external_reference,r.status
       FROM fee_receipts r JOIN students s ON s.id=r.student_id AND s.school_id=r.school_id
       WHERE r.school_id=$1 AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)
       AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid))
       ORDER BY r.received_on DESC,r.receipt_number LIMIT 5000`;break;
    case 'invoice-register':
      sql=`SELECT i.invoice_number,i.issued_on,i.due_on,s.admission_number,s.full_name AS student,i.academic_year,i.amount::text,i.status
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
       ORDER BY i.issued_on DESC,i.invoice_number LIMIT 5000`;break;
    case 'fee-balances':
      sql=`SELECT s.admission_number,s.full_name,i.invoice_number,i.academic_year,i.issued_on,i.due_on,i.amount::text,
       COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated,
       COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)::text AS waived,
       (i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0))::numeric(14,2)::text AS outstanding
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
       ORDER BY i.due_on,s.full_name LIMIT 5000`;break;
    case 'fee-aging':
      sql=`SELECT s.admission_number,s.full_name,i.invoice_number,i.due_on,
       (CURRENT_DATE-i.due_on)::int AS days_overdue,
       (i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0))::numeric(14,2)::text AS outstanding
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND i.status<>'void' AND i.due_on<CURRENT_DATE AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
       ORDER BY i.due_on,s.full_name LIMIT 5000`;break;
    case 'expense-register':
      sql=`SELECT e.expense_number,e.incurred_on,e.category,e.description,e.amount::text,e.status,s.name AS supplier
       FROM expenses e LEFT JOIN suppliers s ON s.id=e.supplier_id AND s.school_id=e.school_id
       WHERE e.school_id=$1 AND ($2::date IS NULL OR e.incurred_on >= $2::date) AND ($3::date IS NULL OR e.incurred_on <= $3::date) AND ($4::uuid IS NULL OR e.academic_term_id=$4::uuid)
       ORDER BY e.incurred_on DESC,e.expense_number LIMIT 5000`;break;
    case 'supplier-payables':
      sql=`SELECT COALESCE(s.name,'Unspecified supplier') AS supplier,e.expense_number,e.description,e.incurred_on,e.amount::text,e.status
       FROM expenses e LEFT JOIN suppliers s ON s.id=e.supplier_id AND s.school_id=e.school_id
       WHERE e.school_id=$1 AND e.status='approved' AND ($4::uuid IS NULL OR e.academic_term_id=$4::uuid) ORDER BY e.incurred_on,e.expense_number LIMIT 5000`;break;
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
      sql=`SELECT r.payment_method,count(DISTINCT r.id)::int AS receipt_count,
       COALESCE(sum(CASE WHEN $4::uuid IS NULL THEN r.amount ELSE (SELECT COALESCE(sum(a.amount),0) FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid) END),0)::text AS collected
       FROM fee_receipts r WHERE r.school_id=$1 AND r.status='posted' AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)
       AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid))
       GROUP BY r.payment_method ORDER BY r.payment_method`;break;
    case 'fees-by-class':
      sql=`SELECT COALESCE(s.class_name,'Unassigned') AS class_name,count(DISTINCT CASE WHEN $2::uuid IS NULL THEN s.id ELSE i.student_id END)::int AS students,
       COALESCE(sum(i.amount),0)::text AS invoiced
       FROM students s LEFT JOIN fee_invoices i ON i.school_id=s.school_id AND i.student_id=s.id AND i.status<>'void' AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$2::uuid))
       WHERE s.school_id=$1 GROUP BY s.class_name ORDER BY s.class_name`;break;
    case 'audit-trail':
      sql=`SELECT created_at,actor_user_id,action,entity_type,entity_id,request_id,metadata
       FROM audit_events WHERE school_id=$1 AND ($2::date IS NULL OR created_at::date >= $2::date) AND ($3::date IS NULL OR created_at::date <= $3::date)
       ORDER BY created_at DESC LIMIT 5000`;break;
    default: throw Object.assign(new Error('Report not found.'),{statusCode:404});
  }
  const dateReports=['trial-balance','income-statement','general-ledger','cashbook','bankbook','receipts-register','invoice-register','fee-balances','expense-register','bank-reconciliation','journal-register','collections-by-method','audit-trail'];
  const termReports=['receipts-register','invoice-register','fee-balances','fee-aging','collections-by-method','fees-by-class'];
  if(name==='balance-sheet')params=[schoolId,to];
  else if(name==='expense-register'||name==='supplier-payables')params=[schoolId,from,to,academicTermId];
  else if(termReports.includes(name)&&dateReports.includes(name))params=[schoolId,from,to,academicTermId];
  else if(name==='fees-by-class')params=[schoolId,academicTermId];
  else if(termReports.includes(name))params=[schoolId,from,to,academicTermId];
  else if(dateReports.includes(name))params=[schoolId,from,to];
  else params=[schoolId];
  const result=await c.query(sql,params);
  return result.rows as Record<string,unknown>[];
}
function reportAcademicTermFilter(req:Request,res:Response):string|null|undefined{
  const value=typeof req.query.academicTermId==='string'?req.query.academicTermId:null;
  if(value&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)){res.status(400).json({error:'Academic term ID must be a valid UUID.'});return undefined;}
  return value;
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
  const dates=reportDateFilters(req,res);if(!dates)return;const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to,academicTermId));
  const keys=rows.length?Object.keys(rows[0]):['no_data'];
  const quote=(v:unknown)=>{let value=String(v??'');if(/^[=+@]/.test(value)||/^-[A-Za-z]/.test(value))value="'"+value;return /[",\r\n]/.test(value)?'"'+value.replace(/"/g,'""')+'"':value;};
  const csv=[keys.map(quote).join(','),...rows.map(row=>keys.map(k=>quote(row[k])).join(','))].join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${name}-${todayIso()}.csv"`);res.status(200).send(csv);
}));
operationsRouter.get('/reports/:report.xlsx',requirePermission('reports.export'),wrap(async(req,res)=>{
  const name=String(req.params.report);if(!reportNames.includes(name)){res.status(404).json({error:'Report not found.'});return;}
  const dates=reportDateFilters(req,res);if(!dates)return;const auth=authContext(req);
  const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to,academicTermId));
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
  const dates=reportDateFilters(req,res);if(!dates)return;const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to,academicTermId));
  const PdfDocument=(await import('pdfkit')).default;const doc=new PdfDocument({size:'A4',layout:'landscape',margin:32,bufferPages:true});
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${name}-${todayIso()}.pdf"`);
  doc.pipe(res);doc.fontSize(18).fillColor('#174c3d').text('Precious SchoolBooks — '+name.replaceAll('-',' '));doc.moveDown(.4);
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
  const dates=reportDateFilters(req,res);if(!dates)return;const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;
  const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to,academicTermId));
  res.json({report:name,currency:'KES',from:dates.from,to:dates.to,rows});
}));
 THEN substring(${column} from $3)::bigint END),0)+1 AS next FROM ${table} WHERE school_id=$1 AND ${column} LIKE $2`,[schoolId,base+'%',base.length+1]);return base+String(result.rows[0].next).padStart(6,'0');}


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
      const r=await c.query('INSERT INTO budgets (school_id,financial_year_id,account_id,name,budget_amount,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,financial_year_id,account_id,budget_amount::text,status',[auth.schoolId,d.financialYearId,d.accountId,d.name,amountString(amount),auth.userId]);
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
      const r=await c.query("SELECT id,status,created_by FROM budgets WHERE school_id=$1 AND id=$2 FOR UPDATE",[auth.schoolId,id.data]);
      if(!r.rowCount||r.rows[0].status!=='draft')throw Object.assign(new Error('Only a draft budget can be approved.'),{statusCode:409});
      if(r.rows[0].created_by&&String(r.rows[0].created_by)===auth.userId)throw Object.assign(new Error('The budget creator cannot approve their own budget.'),{statusCode:403});
      await c.query("UPDATE budgets SET status='approved',approved_by=$3,approved_at=now() WHERE school_id=$1 AND id=$2",[auth.schoolId,id.data,auth.userId]);
      await audit(c,auth.schoolId,auth.userId,'budget.approve','budget',id.data);
      return {id:id.data,status:'approved'};
    });
    res.json({budget});
  }catch(error){if(!handleError(res,error))throw error;}
}));

operationsRouter.get('/reports/trial-balance',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const dates=reportDateFilters(req,res);if(!dates)return;
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT a.id,a.code,a.name,a.account_type,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.debit ELSE 0 END),0)::text AS debit,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.credit ELSE 0 END),0)::text AS credit,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.debit-l.credit ELSE 0 END),0)::text AS net
     FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
     LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
     WHERE a.school_id=$1 AND a.is_active=true
     GROUP BY a.id ORDER BY a.code`,[auth.schoolId,dates.from,dates.to]));
  const rows=result.rows.map(r=>({...r,debit:r.debit??'0.00',credit:r.credit??'0.00',net:r.net??'0.00'}));
  const totals=rows.reduce((acc,r)=>({debit:acc.debit+parseKesToMinorUnits(String(r.debit)),credit:acc.credit+parseKesToMinorUnits(String(r.credit))}),{debit:0n,credit:0n});
  res.json({report:'trial-balance',currency:'KES',from:dates.from,to:dates.to,rows,totals:{debit:amountString(totals.debit),credit:amountString(totals.credit),balanced:totals.debit===totals.credit}});
}));

operationsRouter.get('/reports/income-statement',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const dates=reportDateFilters(req,res);if(!dates)return;
  const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT a.code,a.name,a.account_type,
      COALESCE(sum(CASE WHEN j.id IS NOT NULL THEN l.credit-l.debit ELSE 0 END),0)::text AS balance
     FROM accounts a LEFT JOIN journal_lines l ON l.school_id=a.school_id AND l.account_id=a.id
     LEFT JOIN journal_entries j ON j.school_id=l.school_id AND j.id=l.journal_entry_id AND j.status='posted'
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
     WHERE a.school_id=$1 AND a.account_type IN ('income','expense')
     GROUP BY a.id ORDER BY a.account_type,a.code`,[auth.schoolId,dates.from,dates.to]));
  const signedMinor=(value:unknown):bigint=>{const raw=String(value??'0.00');const negative=raw.startsWith('-');const parsed=parseKesToMinorUnits(negative?raw.slice(1):raw);return negative?-parsed:parsed;};
  const rows=result.rows.map(r=>({...r,balance:amountString(r.account_type==='expense'?-signedMinor(r.balance):signedMinor(r.balance))}));
  let incomeMinor=0n;let expensesMinor=0n;
  for(const row of rows){const amount=signedMinor(row.balance);if(row.account_type==='income')incomeMinor+=amount;else expensesMinor+=amount;}
  res.json({report:'income-statement',currency:'KES',from:dates.from,to:dates.to,rows,totals:{income:amountString(incomeMinor),expenses:amountString(expensesMinor),surplus:amountString(incomeMinor-expensesMinor)}});
}));

operationsRouter.get('/reports/fee-balances',requirePermission('reports.read'),wrap(async(req,res)=>{
  const auth=authContext(req);const dates=reportDateFilters(req,res);if(!dates)return;const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;const result=await withSchoolTransaction(auth.schoolId,c=>c.query(
    `SELECT s.admission_number,s.full_name,i.invoice_number,i.academic_year,i.due_on,i.amount::text,
      COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)::text AS allocated,
      COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)::text AS waived,
      (i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0))::numeric(14,2)::text AS outstanding
     FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
     LEFT JOIN fee_receipt_allocations a ON a.school_id=i.school_id AND a.invoice_id=i.id
     LEFT JOIN fee_receipts r ON r.school_id=a.school_id AND r.id=a.receipt_id
     WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
     GROUP BY i.id,s.id HAVING i.amount-COALESCE(sum(a.amount) FILTER (WHERE r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0)>0
     ORDER BY i.due_on,s.full_name LIMIT 2000`,[auth.schoolId,dates.from,dates.to,academicTermId]));
  res.json({report:'fee-balances',currency:'KES',rows:result.rows});
}));


const reportNames=['trial-balance','income-statement','balance-sheet','general-ledger','cashbook','bankbook','receipts-register','invoice-register','fee-balances','fee-aging','expense-register','supplier-payables','bank-reconciliation','budget-variance','journal-register','collections-by-method','fees-by-class','audit-trail'];
async function buildReportRows(c:PoolClient,schoolId:string,name:string,from:string|null,to:string|null,academicTermId:string|null):Promise<Record<string,unknown>[]>{
  let sql='';
  let params:unknown[]=[schoolId,from,to,academicTermId];
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
       WHERE l.school_id=$1 AND j.status='posted' AND ${name==='cashbook'?"a.code='1000'":"EXISTS (SELECT 1 FROM bank_accounts ba WHERE ba.school_id=a.school_id AND ba.ledger_account_id=a.id)"}
       AND ($2::date IS NULL OR j.posting_date >= $2::date) AND ($3::date IS NULL OR j.posting_date <= $3::date)
       ORDER BY j.posting_date,j.entry_number LIMIT 10000`;break;
    case 'receipts-register':
      sql=`SELECT r.receipt_number,r.received_on,s.admission_number,s.full_name AS student,r.amount::text,r.payment_method,r.external_reference,r.status
       FROM fee_receipts r JOIN students s ON s.id=r.student_id AND s.school_id=r.school_id
       WHERE r.school_id=$1 AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)
       AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid))
       ORDER BY r.received_on DESC,r.receipt_number LIMIT 5000`;break;
    case 'invoice-register':
      sql=`SELECT i.invoice_number,i.issued_on,i.due_on,s.admission_number,s.full_name AS student,i.academic_year,i.amount::text,i.status
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
       ORDER BY i.issued_on DESC,i.invoice_number LIMIT 5000`;break;
    case 'fee-balances':
      sql=`SELECT s.admission_number,s.full_name,i.invoice_number,i.academic_year,i.issued_on,i.due_on,i.amount::text,
       COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)::text AS allocated,
       COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)::text AS waived,
       (i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0))::numeric(14,2)::text AS outstanding
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND i.status<>'void' AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
       ORDER BY i.due_on,s.full_name LIMIT 5000`;break;
    case 'fee-aging':
      sql=`SELECT s.admission_number,s.full_name,i.invoice_number,i.due_on,
       (CURRENT_DATE-i.due_on)::int AS days_overdue,
       (i.amount-COALESCE((SELECT sum(a.amount) FROM fee_receipt_allocations a JOIN fee_receipts r ON r.id=a.receipt_id AND r.school_id=a.school_id WHERE a.school_id=i.school_id AND a.invoice_id=i.id AND r.status='posted'),0)-COALESCE((SELECT sum(w.amount) FROM fee_waivers w WHERE w.school_id=i.school_id AND w.invoice_id=i.id AND w.status='posted'),0)-COALESCE((SELECT sum(ca.amount) FROM student_fee_credit_allocations ca WHERE ca.school_id=i.school_id AND ca.invoice_id=i.id AND ca.status='posted'),0))::numeric(14,2)::text AS outstanding
       FROM fee_invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
       WHERE i.school_id=$1 AND i.status<>'void' AND i.due_on<CURRENT_DATE AND ($2::date IS NULL OR i.issued_on >= $2::date) AND ($3::date IS NULL OR i.issued_on <= $3::date) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$4::uuid))
       ORDER BY i.due_on,s.full_name LIMIT 5000`;break;
    case 'expense-register':
      sql=`SELECT e.expense_number,e.incurred_on,e.category,e.description,e.amount::text,e.status,s.name AS supplier
       FROM expenses e LEFT JOIN suppliers s ON s.id=e.supplier_id AND s.school_id=e.school_id
       WHERE e.school_id=$1 AND ($2::date IS NULL OR e.incurred_on >= $2::date) AND ($3::date IS NULL OR e.incurred_on <= $3::date) AND ($4::uuid IS NULL OR e.academic_term_id=$4::uuid)
       ORDER BY e.incurred_on DESC,e.expense_number LIMIT 5000`;break;
    case 'supplier-payables':
      sql=`SELECT COALESCE(s.name,'Unspecified supplier') AS supplier,e.expense_number,e.description,e.incurred_on,e.amount::text,e.status
       FROM expenses e LEFT JOIN suppliers s ON s.id=e.supplier_id AND s.school_id=e.school_id
       WHERE e.school_id=$1 AND e.status='approved' AND ($4::uuid IS NULL OR e.academic_term_id=$4::uuid) ORDER BY e.incurred_on,e.expense_number LIMIT 5000`;break;
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
      sql=`SELECT r.payment_method,count(DISTINCT r.id)::int AS receipt_count,
       COALESCE(sum(CASE WHEN $4::uuid IS NULL THEN r.amount ELSE (SELECT COALESCE(sum(a.amount),0) FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid) END),0)::text AS collected
       FROM fee_receipts r WHERE r.school_id=$1 AND r.status='posted' AND ($2::date IS NULL OR r.received_on >= $2::date) AND ($3::date IS NULL OR r.received_on <= $3::date)
       AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_receipt_allocations a JOIN fee_invoices i ON i.school_id=a.school_id AND i.id=a.invoice_id JOIN fee_structures fs ON fs.school_id=i.school_id AND fs.id=i.fee_structure_id WHERE a.school_id=r.school_id AND a.receipt_id=r.id AND fs.academic_term_id=$4::uuid))
       GROUP BY r.payment_method ORDER BY r.payment_method`;break;
    case 'fees-by-class':
      sql=`SELECT COALESCE(s.class_name,'Unassigned') AS class_name,count(DISTINCT CASE WHEN $2::uuid IS NULL THEN s.id ELSE i.student_id END)::int AS students,
       COALESCE(sum(i.amount),0)::text AS invoiced
       FROM students s LEFT JOIN fee_invoices i ON i.school_id=s.school_id AND i.student_id=s.id AND i.status<>'void' AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM fee_structures fs WHERE fs.school_id=i.school_id AND fs.id=i.fee_structure_id AND fs.academic_term_id=$2::uuid))
       WHERE s.school_id=$1 GROUP BY s.class_name ORDER BY s.class_name`;break;
    case 'audit-trail':
      sql=`SELECT created_at,actor_user_id,action,entity_type,entity_id,request_id,metadata
       FROM audit_events WHERE school_id=$1 AND ($2::date IS NULL OR created_at::date >= $2::date) AND ($3::date IS NULL OR created_at::date <= $3::date)
       ORDER BY created_at DESC LIMIT 5000`;break;
    default: throw Object.assign(new Error('Report not found.'),{statusCode:404});
  }
  const dateReports=['trial-balance','income-statement','general-ledger','cashbook','bankbook','receipts-register','invoice-register','fee-balances','expense-register','bank-reconciliation','journal-register','collections-by-method','audit-trail'];
  const termReports=['receipts-register','invoice-register','fee-balances','fee-aging','collections-by-method','fees-by-class'];
  if(name==='balance-sheet')params=[schoolId,to];
  else if(name==='expense-register'||name==='supplier-payables')params=[schoolId,from,to,academicTermId];
  else if(termReports.includes(name)&&dateReports.includes(name))params=[schoolId,from,to,academicTermId];
  else if(name==='fees-by-class')params=[schoolId,academicTermId];
  else if(termReports.includes(name))params=[schoolId,from,to,academicTermId];
  else if(dateReports.includes(name))params=[schoolId,from,to];
  else params=[schoolId];
  const result=await c.query(sql,params);
  return result.rows as Record<string,unknown>[];
}
function reportAcademicTermFilter(req:Request,res:Response):string|null|undefined{
  const value=typeof req.query.academicTermId==='string'?req.query.academicTermId:null;
  if(value&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)){res.status(400).json({error:'Academic term ID must be a valid UUID.'});return undefined;}
  return value;
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
  const dates=reportDateFilters(req,res);if(!dates)return;const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to,academicTermId));
  const keys=rows.length?Object.keys(rows[0]):['no_data'];
  const quote=(v:unknown)=>{let value=String(v??'');if(/^[=+@]/.test(value)||/^-[A-Za-z]/.test(value))value="'"+value;return /[",\r\n]/.test(value)?'"'+value.replace(/"/g,'""')+'"':value;};
  const csv=[keys.map(quote).join(','),...rows.map(row=>keys.map(k=>quote(row[k])).join(','))].join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${name}-${todayIso()}.csv"`);res.status(200).send(csv);
}));
operationsRouter.get('/reports/:report.xlsx',requirePermission('reports.export'),wrap(async(req,res)=>{
  const name=String(req.params.report);if(!reportNames.includes(name)){res.status(404).json({error:'Report not found.'});return;}
  const dates=reportDateFilters(req,res);if(!dates)return;const auth=authContext(req);
  const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to,academicTermId));
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
  const dates=reportDateFilters(req,res);if(!dates)return;const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to,academicTermId));
  const PdfDocument=(await import('pdfkit')).default;const doc=new PdfDocument({size:'A4',layout:'landscape',margin:32,bufferPages:true});
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${name}-${todayIso()}.pdf"`);
  doc.pipe(res);doc.fontSize(18).fillColor('#174c3d').text('Precious SchoolBooks — '+name.replaceAll('-',' '));doc.moveDown(.4);
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
  const dates=reportDateFilters(req,res);if(!dates)return;const academicTermId=reportAcademicTermFilter(req,res);if(academicTermId===undefined)return;
  const auth=authContext(req);
  const rows=await withSchoolTransaction(auth.schoolId,c=>buildReportRows(c,auth.schoolId,name,dates.from,dates.to,academicTermId));
  res.json({report:name,currency:'KES',from:dates.from,to:dates.to,rows});
}));
