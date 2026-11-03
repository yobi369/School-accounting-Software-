import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authContext, requireAuth, requirePermission } from './auth.js';
import { withSchoolTransaction } from './db.js';
import { audit, postJournal } from './operations.js';
import { parseKesToMinorUnits } from './domain/ledger.js';

export const migrationRouter = Router();
migrationRouter.use(requireAuth);

function wrap(handler:(req:Request,res:Response,next:NextFunction)=>Promise<void>) {
  return (req:Request,res:Response,next:NextFunction) => { void handler(req,res,next).catch(next); };
}
function fail(message:string,statusCode:number):never {
  throw Object.assign(new Error(message),{statusCode});
}
const dateOnly=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
  const date=new Date(value+'T00:00:00.000Z');
  return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===value;
},'Enter a valid calendar date.');
const createBatchSchema=z.object({
  effectiveDate:dateOnly,
  description:z.string().trim().min(3).max(500),
  sourceLabel:z.string().trim().min(1).max(160),
});
const rowSchema=z.object({
  accountCode:z.string().trim().min(1).max(32),
  debit:z.string().default('0.00'),
  credit:z.string().default('0.00'),
  memo:z.string().trim().max(500).optional(),
});
const addRowsSchema=z.object({rows:z.array(rowSchema).min(1).max(500)});
const reviewSchema=z.object({decision:z.enum(['approved','rejected']),note:z.string().trim().max(1000).optional()});

function formatMoney(minor:bigint):string {
  return (minor/100n).toString()+'.'+(minor%100n).toString().padStart(2,'0');
}
function rowFingerprint(row:z.infer<typeof rowSchema>):string {
  return createHash('sha256').update(JSON.stringify({
    accountCode:row.accountCode.toUpperCase(),
    debit:row.debit,
    credit:row.credit,
    memo:row.memo??'',
  })).digest('hex');
}
function money(value:string):bigint {
  try { return parseKesToMinorUnits(value); }
  catch { return fail('Amounts must be valid KES values with no more than two decimal places.',422); }
}

migrationRouter.post('/migration/batches',requirePermission('migration.manage'),wrap(async(req,res)=>{
  const parsed=createBatchSchema.safeParse(req.body);
  if(!parsed.success)fail('Invalid migration batch details.',400);
  const auth=authContext(req);
  const batchId=randomUUID();
  const batch=await withSchoolTransaction(auth.schoolId,async client=>{
    const result=await client.query(
      "INSERT INTO migration_batches (id,school_id,batch_type,status,effective_date,description,source_label,created_by) VALUES ($1,$2,'opening_balances','draft',$3,$4,$5,$6) RETURNING id,batch_type,status,effective_date::text,description,source_label,row_count,created_at",
      [batchId,auth.schoolId,parsed.data.effectiveDate,parsed.data.description,parsed.data.sourceLabel,auth.userId],
    );
    await audit(client,auth.schoolId,auth.userId,'migration.batch.create','migration_batch',batchId,{batchType:'opening_balances',effectiveDate:parsed.data.effectiveDate});
    return result.rows[0];
  });
  res.status(201).json({batch});
}));

migrationRouter.post('/migration/batches/:batchId/rows',requirePermission('migration.manage'),wrap(async(req,res)=>{
  const parsed=addRowsSchema.safeParse(req.body);
  if(!parsed.success)fail('Provide between 1 and 500 valid opening-balance rows.',400);
  const auth=authContext(req);
  const batchId=z.string().uuid().safeParse(req.params.batchId);
  if(!batchId.success)fail('Invalid migration batch ID.',400);
  const result=await withSchoolTransaction(auth.schoolId,async client=>{
    const batch=await client.query('SELECT status FROM migration_batches WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,batchId.data]);
    if(!batch.rowCount)fail('Migration batch not found.',404);
    if(batch.rows[0].status!=='draft')fail('Rows can only be added while a migration batch is in draft.',409);
    const existingRows=await client.query('SELECT COALESCE(MAX(row_number),0)::int AS max_row FROM migration_batch_rows WHERE school_id=$1 AND batch_id=$2',[auth.schoolId,batchId.data]);
    const firstRowNumber=Number(existingRows.rows[0].max_row)+1;
    const inserted=[];
    for(const [index,row] of parsed.data.rows.entries()){
      const debit=money(row.debit),credit=money(row.credit);
      if(debit<0n||credit<0n)fail('Opening-balance debit and credit amounts cannot be negative.',422);
      if((debit>0n)===(credit>0n))fail('Each row must contain either a positive debit or a positive credit, not both.',422);
      const account=await client.query('SELECT id,code FROM accounts WHERE school_id=$1 AND upper(code)=upper($2) AND is_active=true',[auth.schoolId,row.accountCode]);
      if(!account.rowCount)fail('An account code is missing, inactive, or does not belong to this school: '+row.accountCode,422);
      const normalized={accountCode:String(account.rows[0].code),debit:formatMoney(debit),credit:formatMoney(credit),memo:row.memo??''};
      const payload=normalized;
      const fingerprint=rowFingerprint(normalized);
      const saved=await client.query(
        'INSERT INTO migration_batch_rows (school_id,batch_id,row_number,fingerprint,payload) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (school_id,batch_id,fingerprint) DO NOTHING RETURNING id,row_number',
        [auth.schoolId,batchId.data,firstRowNumber+index,fingerprint,JSON.stringify(payload)],
      );
      if(!saved.rowCount)fail('A duplicate opening-balance row was detected in this batch.',409);
      inserted.push(saved.rows[0]);
    }
    const count=await client.query('SELECT count(*)::int AS n FROM migration_batch_rows WHERE school_id=$1 AND batch_id=$2',[auth.schoolId,batchId.data]);
    await client.query('UPDATE migration_batches SET row_count=$3,updated_at=now() WHERE school_id=$1 AND id=$2',[auth.schoolId,batchId.data,count.rows[0].n]);
    await audit(client,auth.schoolId,auth.userId,'migration.batch.rows.add','migration_batch',batchId.data,{added:inserted.length,total:count.rows[0].n});
    return {inserted:inserted.length,rowCount:count.rows[0].n};
  });
  res.status(201).json(result);
}));

migrationRouter.get('/migration/batches/:batchId',wrap(async(req,res)=>{
  const auth=authContext(req);
  if(!auth.permissions.includes('migration.manage')&&!auth.permissions.includes('migration.approve'))fail('Insufficient permission.',403);
  const parsed=z.string().uuid().safeParse(req.params.batchId);
  if(!parsed.success)fail('Invalid migration batch ID.',400);
  const result=await withSchoolTransaction(auth.schoolId,async client=>{
    const batch=await client.query(
      'SELECT id,batch_type,status,effective_date::text,description,source_label,row_count,created_by,submitted_at,reviewed_by,reviewed_at,review_note,posted_at,journal_entry_id,created_at FROM migration_batches WHERE school_id=$1 AND id=$2',
      [auth.schoolId,parsed.data],
    );
    if(!batch.rowCount)fail('Migration batch not found.',404);
    const rows=await client.query('SELECT row_number,payload,validation_errors FROM migration_batch_rows WHERE school_id=$1 AND batch_id=$2 ORDER BY row_number',[auth.schoolId,parsed.data]);
    return {batch:batch.rows[0],rows:rows.rows};
  });
  res.json(result);
}));

migrationRouter.post('/migration/batches/:batchId/submit',requirePermission('migration.manage'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const parsed=z.string().uuid().safeParse(req.params.batchId);
  if(!parsed.success)fail('Invalid migration batch ID.',400);
  const result=await withSchoolTransaction(auth.schoolId,async client=>{
    const batch=await client.query('SELECT * FROM migration_batches WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,parsed.data]);
    if(!batch.rowCount)fail('Migration batch not found.',404);
    if(batch.rows[0].status!=='draft')fail('Only draft migration batches can be submitted.',409);
    const rows=await client.query('SELECT payload FROM migration_batch_rows WHERE school_id=$1 AND batch_id=$2 ORDER BY row_number',[auth.schoolId,parsed.data]);
    if(rows.rows.length<2)fail('An opening-balance journal requires at least two account rows.',422);
    let debits=0n,credits=0n;
    for(const item of rows.rows){
      const payload=item.payload as {accountCode:string;debit:string;credit:string;memo?:string};
      debits+=money(payload.debit);credits+=money(payload.credit);
    }
    if(debits<=0n||debits!==credits)fail('Opening balances must have equal, positive total debits and credits.',422);
    const period=await client.query(
      "SELECT p.id FROM financial_years y JOIN accounting_periods p ON p.school_id=y.school_id AND p.financial_year_id=y.id WHERE y.school_id=$1 AND y.status='open' AND p.status='open' AND y.starts_on<=$2::date AND y.ends_on>=$2::date AND p.starts_on<=$2::date AND p.ends_on>=$2::date",
      [auth.schoolId,batch.rows[0].effective_date],
    );
    if(!period.rowCount)fail('The opening-balance date must fall within an open financial year and accounting period.',422);
    await client.query("UPDATE migration_batches SET status='pending_review',submitted_at=now(),updated_at=now() WHERE school_id=$1 AND id=$2",[auth.schoolId,parsed.data]);
    await audit(client,auth.schoolId,auth.userId,'migration.batch.submit','migration_batch',parsed.data,{rowCount:rows.rows.length,totalDebitMinor:debits.toString(),totalCreditMinor:credits.toString()});
    return {status:'pending_review',rowCount:rows.rowCount,total:((debits/100n).toString()+'.'+(debits%100n).toString().padStart(2,'0'))};
  });
  res.json(result);
}));

migrationRouter.post('/migration/batches/:batchId/review',requirePermission('migration.approve'),wrap(async(req,res)=>{
  const body=reviewSchema.safeParse(req.body);
  if(!body.success)fail('Invalid migration review decision.',400);
  const auth=authContext(req);
  const parsed=z.string().uuid().safeParse(req.params.batchId);
  if(!parsed.success)fail('Invalid migration batch ID.',400);
  const result=await withSchoolTransaction(auth.schoolId,async client=>{
    const batch=await client.query('SELECT status,created_by FROM migration_batches WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,parsed.data]);
    if(!batch.rowCount)fail('Migration batch not found.',404);
    if(batch.rows[0].status!=='pending_review')fail('Only submitted migration batches can be reviewed.',409);
    if(batch.rows[0].created_by===auth.userId)fail('The preparer cannot review their own migration batch.',403);
    await client.query(
      'INSERT INTO migration_batch_approvals (school_id,batch_id,reviewer_user_id,decision,note) VALUES ($1,$2,$3,$4,$5)',
      [auth.schoolId,parsed.data,auth.userId,body.data.decision,body.data.note??null],
    );
    const status=body.data.decision==='approved'?'approved':'rejected';
    await client.query(
      'UPDATE migration_batches SET status=$3,reviewed_by=$4,reviewed_at=now(),review_note=$5,updated_at=now() WHERE school_id=$1 AND id=$2',
      [auth.schoolId,parsed.data,status,auth.userId,body.data.note??null],
    );
    await audit(client,auth.schoolId,auth.userId,'migration.batch.review','migration_batch',parsed.data,{decision:status});
    return {status};
  });
  res.json(result);
}));

migrationRouter.post('/migration/batches/:batchId/post',requirePermission('migration.manage'),wrap(async(req,res)=>{
  const auth=authContext(req);
  const parsed=z.string().uuid().safeParse(req.params.batchId);
  if(!parsed.success)fail('Invalid migration batch ID.',400);
  const result=await withSchoolTransaction(auth.schoolId,async client=>{
    const batch=await client.query('SELECT * FROM migration_batches WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,parsed.data]);
    if(!batch.rowCount)fail('Migration batch not found.',404);
    if(batch.rows[0].status!=='approved')fail('A migration batch must be independently approved before posting.',409);
    const rows=await client.query('SELECT payload FROM migration_batch_rows WHERE school_id=$1 AND batch_id=$2 ORDER BY row_number',[auth.schoolId,parsed.data]);
    const postingLines=rows.rows.map(item=>{
      const payload=item.payload as {accountCode:string;debit:string;credit:string;memo?:string};
      return {accountCode:payload.accountCode,debit:payload.debit,credit:payload.credit,memo:payload.memo};
    });
    const journal=await postJournal(
      client,auth.schoolId,auth.userId,String(batch.rows[0].effective_date).slice(0,10),
      'Opening balances migration: '+String(batch.rows[0].description),
      'migration_opening_balance',parsed.data,postingLines,
    );
    await client.query(
      "UPDATE migration_batches SET status='posted',posted_at=now(),journal_entry_id=$3,updated_at=now() WHERE school_id=$1 AND id=$2",
      [auth.schoolId,parsed.data,journal.id],
    );
    await audit(client,auth.schoolId,auth.userId,'migration.batch.post','migration_batch',parsed.data,{journalEntryId:journal.id,entryNumber:journal.entryNumber});
    return {status:'posted',journalEntryId:journal.id,entryNumber:journal.entryNumber};
  });
  res.status(201).json(result);
}));
