import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool, withSchoolTransaction } from './db.js';
import { authenticateRequest, createSession } from './auth.js';
import { operationsRouter } from './operations.js';

const enabled = Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)('PostgreSQL tenant and ledger integration', () => {
  const schoolA = randomUUID();
  const schoolB = randomUUID();
  const codeA = `T${randomUUID().replaceAll('-','').slice(0,10).toUpperCase()}`;
  const codeB = `T${randomUUID().replaceAll('-','').slice(0,10).toUpperCase()}`;
  const yearId = randomUUID();
  const periodId = randomUUID();
  const cashId = randomUUID();
  const incomeId = randomUUID();
  const studentA = randomUUID();
  const studentB = randomUUID();
  const userId = randomUUID();
  const roleA = randomUUID();
  const roleB = randomUUID();

  it('enforces tenant row-level security and posted-journal immutability', async () => {
    await withSchoolTransaction(schoolA, async c => {
      await c.query('INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',[schoolA,'Integration School A',codeA]);
      await c.query('INSERT INTO users (id,email,password_hash,full_name) VALUES ($1,$2,$3,$4)',[userId,`multi-${codeA.toLowerCase()}@example.test`,'test-hash','Multi School User']);
      await c.query('INSERT INTO roles (id,school_id,name) VALUES ($1,$2,$3)',[roleA,schoolA,'auditor']);
      await c.query('INSERT INTO school_memberships (school_id,user_id,role_id,status) VALUES ($1,$2,$3,$4)',[schoolA,userId,roleA,'active']);
      await c.query(
        'INSERT INTO students (id,school_id,admission_number,full_name,sex,date_of_birth,guardian_name,guardian_relationship,guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [studentA,schoolA,'TEST-A','Test Student A','female','2012-04-05','Amina Test','Mother','0712345678','0723456789','Voi, Taita Taveta','Emergency Contact','0734567890']);
      await c.query('INSERT INTO financial_years (id,school_id,name,starts_on,ends_on) VALUES ($1,$2,$3,$4,$5)',[yearId,schoolA,'Test Year','2026-01-01','2026-12-31']);
      await c.query('INSERT INTO accounting_periods (id,school_id,financial_year_id,starts_on,ends_on) VALUES ($1,$2,$3,$4,$5)',[periodId,schoolA,yearId,'2026-01-01','2026-12-31']);
      await c.query("INSERT INTO accounts (id,school_id,code,name,account_type) VALUES ($1,$2,'T100','Test cash','asset'),($3,$2,'T400','Test income','income')",[cashId,schoolA,incomeId]);
    });
    await withSchoolTransaction(schoolB, async c => {
      await c.query('INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',[schoolB,'Integration School B',codeB]);
      await c.query('INSERT INTO roles (id,school_id,name) VALUES ($1,$2,$3)',[roleB,schoolB,'accountant']);
      await c.query('INSERT INTO school_memberships (school_id,user_id,role_id,status) VALUES ($1,$2,$3,$4)',[schoolB,userId,roleB,'active']);
      await c.query('INSERT INTO students (id,school_id,admission_number,full_name) VALUES ($1,$2,$3,$4)',[studentB,schoolB,'TEST-B','Test Student B']);
    });
    const profile = await withSchoolTransaction(schoolA,c=>c.query(
      'SELECT sex,date_of_birth::text AS date_of_birth,guardian_relationship,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone FROM students WHERE school_id=$1 AND id=$2',
      [schoolA,studentA]));
    expect(profile.rows[0]).toMatchObject({
      sex:'female',date_of_birth:'2012-04-05',guardian_relationship:'Mother',
      guardian_alternate_phone:'0723456789',home_address:'Voi, Taita Taveta',
      emergency_contact_name:'Emergency Contact',emergency_contact_phone:'0734567890',
    });
    const isolated = await withSchoolTransaction(schoolA,c=>c.query('SELECT id FROM students WHERE school_id=$1',[schoolB]));
    expect(isolated.rowCount).toBe(0);
    // Row-level security must also reject cross-school writes, not merely hide rows.
    await expect(withSchoolTransaction(schoolA, c =>
      c.query('INSERT INTO students (id,school_id,admission_number,full_name) VALUES ($1,$2,$3,$4)',
        [randomUUID(),schoolB,'CROSS-TENANT','Must be rejected'])
    )).rejects.toThrow();
    const ownRows = await withSchoolTransaction(schoolA, c =>
      c.query('SELECT id FROM students WHERE school_id=$1 ORDER BY id',[schoolA]));
    expect(ownRows.rows.map((row: {id:string})=>row.id)).toContain(studentA);
    expect(ownRows.rows.map((row: {id:string})=>row.id)).not.toContain(studentB);
    const workspaces=await withSchoolTransaction(schoolA,async c=>{await c.query("SELECT set_config('app.user_id',$1,true)",[userId]);return c.query('SELECT sc.id,sc.name FROM school_memberships m JOIN schools sc ON sc.id=m.school_id WHERE m.user_id=$1 AND m.status=\'active\' ORDER BY sc.name',[userId]);});
    expect(workspaces.rows.map((row: {id:string})=>row.id).sort()).toEqual([schoolA,schoolB].sort());

    // Exercise the real session lookup against the least-privilege PostgreSQL role.
    await withSchoolTransaction(schoolA, async c => {
      await c.query("INSERT INTO permissions (code,description) VALUES ('reports.read','Read reports') ON CONFLICT (code) DO NOTHING");
      await c.query("INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,'reports.read') ON CONFLICT DO NOTHING",[roleA]);
    });
    const session = await createSession(userId,schoolA);
    const request = { header: (name:string) => name.toLowerCase()==='authorization' ? 'Bearer '+session.token : undefined } as import('express').Request;
    const authenticated = await authenticateRequest(request);
    expect(authenticated?.userId).toBe(userId);
    expect(authenticated?.schoolId).toBe(schoolA);
    expect(authenticated?.role).toBe('auditor');
    expect(authenticated?.permissions).toContain('reports.read');

    // A valid token must stop working immediately when the membership is revoked.
    await withSchoolTransaction(schoolA,c=>c.query(
      "UPDATE school_memberships SET status='revoked' WHERE school_id=$1 AND user_id=$2",[schoolA,userId]));
    expect(await authenticateRequest(request)).toBeNull();
    await withSchoolTransaction(schoolA,c=>c.query(
      "UPDATE school_memberships SET status='active' WHERE school_id=$1 AND user_id=$2",[schoolA,userId]));

    // Concurrent retries with the same offline mutation ID must produce one durable receipt.
    const mutationId=randomUUID();
    const requestHash='a'.repeat(64);
    const submitMutation=()=>withSchoolTransaction(schoolA,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[mutationId]);
      const existing=await c.query(
        'SELECT request_hash,resource_id FROM offline_sync_receipts WHERE school_id=$1 AND client_mutation_id=$2 FOR UPDATE',
        [schoolA,mutationId]);
      if(existing.rowCount)return {duplicate:true,resourceId:String(existing.rows[0].resource_id)};
      const resourceId=randomUUID();
      await c.query(
        'INSERT INTO offline_sync_receipts (school_id,client_mutation_id,request_hash,resource_type,resource_id,response_body,created_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)',
        [schoolA,mutationId,requestHash,'expense',resourceId,JSON.stringify({status:'accepted',serverId:resourceId}),userId]);
      return {duplicate:false,resourceId};
    });
    const retries=await Promise.all([submitMutation(),submitMutation()]);
    expect(retries.filter(x=>!x.duplicate)).toHaveLength(1);
    expect(retries[0].resourceId).toBe(retries[1].resourceId);
    const receiptCount=await withSchoolTransaction(schoolA,c=>c.query(
      'SELECT count(*)::int AS n FROM offline_sync_receipts WHERE school_id=$1 AND client_mutation_id=$2',[schoolA,mutationId]));
    expect(receiptCount.rows[0].n).toBe(1);
    await expect(withSchoolTransaction(schoolA,c=>c.query('INSERT INTO school_memberships (school_id,user_id,role_id,status) VALUES ($1,$2,$3,$4)',[schoolA,userId,roleB,'active']))).rejects.toThrow();

    const journalId = randomUUID();
    const insertedLineIds = await withSchoolTransaction(schoolA, async c => {
      await c.query("INSERT INTO journal_entries (id,school_id,financial_year_id,period_id,entry_number,posting_date,description,status,source_type) VALUES ($1,$2,$3,$4,1,'2026-03-01','Integration posting','draft','test')",[journalId,schoolA,yearId,periodId]);
      const insertedLines=await c.query("INSERT INTO journal_lines (school_id,journal_entry_id,account_id,line_number,debit,credit) VALUES ($1,$2,$3,1,100.00,0),($1,$2,$4,2,0,100.00) RETURNING id",[schoolA,journalId,cashId,incomeId]);
      await c.query("UPDATE journal_entries SET status='posted' WHERE school_id=$1 AND id=$2",[schoolA,journalId]);
      const posted = await c.query('SELECT status,posted_at FROM journal_entries WHERE school_id=$1 AND id=$2',[schoolA,journalId]);
      expect(posted.rows[0].status).toBe('posted');
      expect(posted.rows[0].posted_at).toBeTruthy();
      return insertedLines.rows.map((row:{id:string})=>row.id);
    });

    // Each expected database failure gets its own transaction. PostgreSQL marks
    // a transaction failed after a constraint/trigger error until it is rolled back.
    await expect(withSchoolTransaction(schoolA,c=>
      c.query("UPDATE journal_entries SET description='tampered' WHERE school_id=$1 AND id=$2",[schoolA,journalId])
    )).rejects.toThrow(/Posted journal entries are immutable/);
    await expect(withSchoolTransaction(schoolA,c=>
      c.query('UPDATE journal_lines SET debit=200 WHERE school_id=$1 AND id=$2',[schoolA,insertedLineIds[0]])
    )).rejects.toThrow();
    await expect(withSchoolTransaction(schoolA,c=>
      c.query('DELETE FROM journal_lines WHERE school_id=$1 AND id=$2',[schoolA,insertedLineIds[1]])
    )).rejects.toThrow();

    // Database-level posting integrity rejects unbalanced drafts even when a
    // caller bypasses application-layer domain validation.
    const unbalancedId=randomUUID();
    await expect(withSchoolTransaction(schoolA,async c=>{
      await c.query("INSERT INTO journal_entries (id,school_id,financial_year_id,period_id,entry_number,posting_date,description,status,source_type) VALUES ($1,$2,$3,$4,2,'2026-03-02','Unbalanced integration posting','draft','test')",[unbalancedId,schoolA,yearId,periodId]);
      await c.query("INSERT INTO journal_lines (school_id,journal_entry_id,account_id,line_number,debit,credit) VALUES ($1,$2,$3,1,100.00,0),($1,$2,$4,2,0,99.00)",[schoolA,unbalancedId,cashId,incomeId]);
      await c.query("UPDATE journal_entries SET status='posted' WHERE school_id=$1 AND id=$2",[schoolA,unbalancedId]);
    })).rejects.toThrow(/equal, positive debit and credit totals/);
  });


  it('runs fee collection and maker-checker expense workflows through the authenticated API', async () => {
    const schoolId=randomUUID();
    const userIds={requester:randomUUID(),approver:randomUUID(),payer:randomUUID()};
    const roleIds={requester:randomUUID(),approver:randomUUID(),payer:randomUUID()};
    const yearId=randomUUID(),periodId=randomUUID(),studentId=randomUUID();
    const cashId=randomUUID(),receivableId=randomUUID(),payableId=randomUUID(),incomeId=randomUUID(),expenseAccountId=randomUUID();
    const code='WF'+randomUUID().replaceAll('-','').slice(0,10).toUpperCase();
    const permissionCodes=['fees.manage','receipts.create','expenses.create','expenses.approve','expenses.pay','reports.read'];
    await withSchoolTransaction(schoolId,async c=>{
      await c.query('INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',[schoolId,'Workflow Integration School',code]);
      for(const [kind,id] of Object.entries(userIds)){
        await c.query('INSERT INTO users (id,email,password_hash,full_name) VALUES ($1,$2,$3,$4)',[id,kind+'-'+code.toLowerCase()+'@example.test','test-hash',kind+' Workflow User']);
      }
      for(const [kind,id] of Object.entries(roleIds)){
        await c.query('INSERT INTO roles (id,school_id,name) VALUES ($1,$2,$3)',[id,schoolId,kind]);
        await c.query('INSERT INTO school_memberships (school_id,user_id,role_id,status) VALUES ($1,$2,$3,$4)',[schoolId,userIds[kind as keyof typeof userIds],id,'active']);
      }
      for(const permission of permissionCodes){
        await c.query('INSERT INTO permissions (code,description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING',[permission,permission]);
      }
      const assignments=[
        ['requester',['fees.manage','receipts.create','expenses.create','expenses.approve','reports.read']],
        ['approver',['expenses.approve','expenses.pay']],
        ['payer',['expenses.pay']],
      ] as const;
      for(const [kind,codes] of assignments){
        for(const permission of codes){
          await c.query('INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',[roleIds[kind],permission]);
        }
      }
      await c.query('INSERT INTO financial_years (id,school_id,name,starts_on,ends_on) VALUES ($1,$2,$3,$4,$5)',[yearId,schoolId,'2026','2026-01-01','2026-12-31']);
      await c.query('INSERT INTO accounting_periods (id,school_id,financial_year_id,starts_on,ends_on) VALUES ($1,$2,$3,$4,$5)',[periodId,schoolId,yearId,'2026-01-01','2026-12-31']);
      await c.query('INSERT INTO accounts (id,school_id,code,name,account_type) VALUES ($1,$2,$3,$4,$5),($6,$2,$7,$8,$9),($10,$2,$11,$12,$13),($14,$2,$15,$16,$17),($18,$2,$19,$20,$21)',[
        cashId,schoolId,'1000','Cash','asset',
        receivableId,'1200','Fees receivable','asset',
        payableId,'2000','Accounts payable','liability',
        incomeId,'4000','School fee income','income',
        expenseAccountId,'5000','Administration expenses','expense',
      ]);
      await c.query('INSERT INTO students (id,school_id,admission_number,full_name) VALUES ($1,$2,$3,$4)',[studentId,schoolId,'WF-STUDENT-1','Workflow Test Student']);
    });

    const requesterSession=await createSession(userIds.requester,schoolId);
    const approverSession=await createSession(userIds.approver,schoolId);
    const payerSession=await createSession(userIds.payer,schoolId);
    const app=express();app.use(express.json());app.use('/api/v1',operationsRouter);
    const server=app.listen(0,'127.0.0.1');
    try{
      await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('Integration API server did not bind to a TCP port.');
      const base='http://127.0.0.1:'+address.port;
      const post=async(path:string,token:string,body:unknown,extra:Record<string,string>={})=>{
        const response=await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
        return {status:response.status,body:await response.json() as Record<string,any>};
      };

      const invoiceResult=await post('/api/v1/fees/invoices',requesterSession.token,{
        studentId,invoiceNumber:'WF-INV-001',academicYear:'2026',description:'Term fees',issuedOn:'2026-02-01',dueOn:'2026-02-15',amount:'1000.00',
      });
      expect(invoiceResult.status).toBe(201);
      const invoiceId=invoiceResult.body.invoice.id as string;

      const receiptBody={studentId,receiptNumber:'WF-RCT-001',receivedOn:'2026-02-05',amount:'400.00',paymentAccountId:cashId,paymentMethod:'cash',allocations:[{invoiceId,amount:'400.00'}]};
      const receiptHeaders={'Idempotency-Key':'workflow-receipt-001'};
      const receipt=await post('/api/v1/fees/receipts',requesterSession.token,receiptBody,receiptHeaders);
      expect(receipt.status).toBe(201);
      expect(receipt.body.receipt.status).toBe('posted');
      const duplicate=await post('/api/v1/fees/receipts',requesterSession.token,receiptBody,receiptHeaders);
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.duplicate).toBe(true);

      const overAllocation=await post('/api/v1/fees/receipts',requesterSession.token,{
        studentId,receiptNumber:'WF-RCT-OVER',receivedOn:'2026-02-06',amount:'700.00',paymentAccountId:cashId,paymentMethod:'cash',allocations:[{invoiceId,amount:'700.00'}],
      },{'Idempotency-Key':'workflow-receipt-over'});
      expect(overAllocation.status).toBe(422);
      expect(overAllocation.body.error).toMatch(/outstanding balance/);

      // Complete the second instalment and verify the invoice and ledger-backed
      // trial balance reconcile through the same authenticated API.
      const finalReceipt=await post('/api/v1/fees/receipts',requesterSession.token,{
        studentId,receiptNumber:'WF-RCT-002',receivedOn:'2026-02-07',amount:'600.00',
        paymentAccountId:cashId,paymentMethod:'cash',allocations:[{invoiceId,amount:'600.00'}],
      },{'Idempotency-Key':'workflow-receipt-002'});
      expect(finalReceipt.status).toBe(201);
      expect(finalReceipt.body.receipt.status).toBe('posted');
      const trialBalanceResponse=await fetch(base+'/api/v1/reports/trial-balance',{
        headers:{Authorization:'Bearer '+requesterSession.token},
      });
      expect(trialBalanceResponse.status).toBe(200);
      const trialBalance=await trialBalanceResponse.json() as {totals:{debit:string;credit:string;balanced:boolean}};
      expect(trialBalance.totals.balanced).toBe(true);
      expect(trialBalance.totals.debit).toBe(trialBalance.totals.credit);

      const expenseResult=await post('/api/v1/expenses',requesterSession.token,{
        expenseNumber:'WF-EXP-001',expenseAccountId,category:'Supplies',description:'Classroom supplies',incurredOn:'2026-02-06',amount:'200.00',
      });
      expect(expenseResult.status).toBe(201);
      const expenseId=expenseResult.body.expense.id as string;
      const selfApproval=await post('/api/v1/expenses/'+expenseId+'/approve',requesterSession.token,{});
      expect(selfApproval.status).toBe(403);
      expect(selfApproval.body.error).toMatch(/requester cannot approve/);

      const approval=await post('/api/v1/expenses/'+expenseId+'/approve',approverSession.token,{});
      expect(approval.status).toBe(200);
      expect(approval.body.expense.status).toBe('approved');
      const approverSelfPayment=await post('/api/v1/expenses/'+expenseId+'/pay',approverSession.token,{paymentAccountId:cashId,paidOn:'2026-02-07'});
      expect(approverSelfPayment.status).toBe(403);
      expect(approverSelfPayment.body.error).toMatch(/approver cannot pay/);
      const payment=await post('/api/v1/expenses/'+expenseId+'/pay',payerSession.token,{paymentAccountId:cashId,paidOn:'2026-02-07'});
      expect(payment.status).toBe(200);
      expect(payment.body.expense.status).toBe('paid');

      const totals=await withSchoolTransaction(schoolId,async c=>{
        const invoice=await c.query("SELECT status,amount::text FROM fee_invoices WHERE school_id=$1 AND id=$2",[schoolId,invoiceId]);
        const allocation=await c.query("SELECT COALESCE(sum(amount),0)::text AS total FROM fee_receipt_allocations WHERE school_id=$1 AND invoice_id=$2",[schoolId,invoiceId]);
        const receipts=await c.query("SELECT count(*)::int AS n FROM fee_receipts WHERE school_id=$1 AND receipt_number='WF-RCT-001'",[schoolId]);
        const expense=await c.query("SELECT status,approved_by,paid_at,payment_journal_entry_id FROM expenses WHERE school_id=$1 AND id=$2",[schoolId,expenseId]);
        const journals=await c.query("SELECT count(*)::int AS n FROM journal_entries WHERE school_id=$1 AND status='posted'",[schoolId]);
        return {invoice:invoice.rows[0],allocation:allocation.rows[0],receipts:receipts.rows[0],expense:expense.rows[0],journals:journals.rows[0]};
      });
      expect(totals.invoice.status).toBe('paid');
      expect(totals.allocation.total).toBe('1000.00');
      expect(totals.receipts.n).toBe(1);
      const secondReceiptCount=await withSchoolTransaction(schoolId,c=>c.query("SELECT count(*)::int AS n FROM fee_receipts WHERE school_id=$1 AND receipt_number='WF-RCT-002'",[schoolId]));
      expect(secondReceiptCount.rows[0].n).toBe(1);
      expect(totals.expense.status).toBe('paid');
      expect(totals.expense.paid_at).toBeTruthy();
      expect(totals.expense.payment_journal_entry_id).toBeTruthy();
      expect(totals.journals.n).toBe(5);
    } finally {
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  });

  it('prevents duplicate bank reconciliation matches and preserves failed attempts', async () => {
    const schoolId=randomUUID(),userId=randomUUID(),roleId=randomUUID();
    const yearId=randomUUID(),periodId=randomUUID(),cashId=randomUUID(),incomeId=randomUUID(),bankId=randomUUID(),journalId=randomUUID();
    const code='BANK'+randomUUID().replaceAll('-','').slice(0,8).toUpperCase();
    const lineIds:string[]=[];
    await withSchoolTransaction(schoolId,async db=>{
      await db.query('INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',[schoolId,'Bank Reconciliation Test School',code]);
      await db.query('INSERT INTO users (id,email,password_hash,full_name) VALUES ($1,$2,$3,$4)',[userId,'bank-'+code.toLowerCase()+'@example.test','test-hash','Bank Reconciliation Tester']);
      await db.query('INSERT INTO roles (id,school_id,name) VALUES ($1,$2,$3)',[roleId,schoolId,'bank_reconciliation_tester']);
      await db.query("INSERT INTO school_memberships (school_id,user_id,role_id,status) VALUES ($1,$2,$3,'active')",[schoolId,userId,roleId]);
      for(const permission of ['bank.reconcile','bank.read']){
        await db.query('INSERT INTO permissions (code,description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING',[permission,permission]);
        await db.query('INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',[roleId,permission]);
      }
      await db.query('INSERT INTO financial_years (id,school_id,name,starts_on,ends_on) VALUES ($1,$2,$3,$4,$5)',[yearId,schoolId,'2026','2026-01-01','2026-12-31']);
      await db.query('INSERT INTO accounting_periods (id,school_id,financial_year_id,starts_on,ends_on) VALUES ($1,$2,$3,$4,$5)',[periodId,schoolId,yearId,'2026-01-01','2026-12-31']);
      await db.query("INSERT INTO accounts (id,school_id,code,name,account_type) VALUES ($1,$2,'B100','Bank control','asset'),($3,$2,'B400','Test income','income')",[cashId,schoolId,incomeId]);
      await db.query('INSERT INTO bank_accounts (id,school_id,name,bank_name,account_number_masked,ledger_account_id) VALUES ($1,$2,$3,$4,$5,$6)',[bankId,schoolId,'Test bank','Test Bank','****1234',cashId]);
      await db.query("INSERT INTO journal_entries (id,school_id,financial_year_id,period_id,entry_number,posting_date,description,status,source_type) VALUES ($1,$2,$3,$4,1,'2026-03-01','Bank reconciliation test','draft','test')",[journalId,schoolId,yearId,periodId]);
      const lines=await db.query("INSERT INTO journal_lines (school_id,journal_entry_id,account_id,line_number,debit,credit) VALUES ($1,$2,$3,1,55.00,0),($1,$2,$4,2,0,55.00) RETURNING id",[schoolId,journalId,cashId,incomeId]);
      lineIds.push(...lines.rows.map((row:{id:string})=>String(row.id)));
      await db.query("UPDATE journal_entries SET status='posted' WHERE school_id=$1 AND id=$2",[schoolId,journalId]);
    });
    const session=await createSession(userId,schoolId);
    const app=express();app.use(express.json());app.use('/api/v1',operationsRouter);
    const server=app.listen(0,'127.0.0.1');
    try{
      await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('Bank reconciliation test server did not bind to a TCP port.');
      const base='http://127.0.0.1:'+address.port;
      const post=async(body:unknown)=>{
        const response=await fetch(base+'/api/v1/bank/reconcile',{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
        return {status:response.status,body:await response.json() as Record<string,any>};
      };
      const statementOne=randomUUID(),statementTwo=randomUUID();
      await withSchoolTransaction(schoolId,async db=>{
        await db.query('INSERT INTO bank_statement_lines (id,school_id,bank_account_id,transaction_date,description,reference,amount,imported_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8),($9,$2,$3,$4,$10,$11,$13,$12)',[
          statementOne,schoolId,bankId,'2026-03-01','Deposit one','REF-1','54.99','a'.repeat(64),
          statementTwo,'Deposit duplicate','REF-2','b'.repeat(64),'55.00',
        ]);
      });
      const mismatch=await post({statementLineId:statementOne,journalLineId:lineIds[0]});
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.error).toContain('amount does not equal');
      const stillUnmatched=await withSchoolTransaction(schoolId,db=>db.query('SELECT matched_at FROM bank_statement_lines WHERE school_id=$1 AND id=$2',[schoolId,statementOne]));
      expect(stillUnmatched.rows[0].matched_at).toBeNull();
      await withSchoolTransaction(schoolId,db=>db.query('UPDATE bank_statement_lines SET amount=55.00 WHERE school_id=$1 AND id=$2',[schoolId,statementOne]));
      // The corrected statement amount is 55.00; use the cash debit line to match it.
      const matched=await post({statementLineId:statementOne,journalLineId:lineIds[0]});
      expect(matched.status).toBe(200);
      expect(matched.body.matched).toBe(true);
      const duplicate=await post({statementLineId:statementTwo,journalLineId:lineIds[0]});
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toContain('already been reconciled');
      const finalState=await withSchoolTransaction(schoolId,db=>db.query('SELECT count(*) FILTER (WHERE matched_at IS NOT NULL)::int AS matched,count(*) FILTER (WHERE matched_at IS NULL)::int AS unmatched FROM bank_statement_lines WHERE school_id=$1 AND bank_account_id=$2',[schoolId,bankId]));
      expect(finalState.rows[0]).toMatchObject({matched:1,unmatched:1});
    }finally{
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  });


  it('enforces class fee structure isolation and prevents duplicate invoices per student and structure', async () => {
    const schoolId=randomUUID();
    const otherSchoolId=randomUUID();
    const studentId=randomUUID();
    const structureId=randomUUID();
    const invoiceId=randomUUID();
    const code='FS'+randomUUID().replaceAll('-','').slice(0,10).toUpperCase();
    const otherCode='FS'+randomUUID().replaceAll('-','').slice(0,10).toUpperCase();
    await withSchoolTransaction(schoolId,async c=>{
      await c.query('INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',[schoolId,'Fee Structure Test School',code]);
      await c.query('INSERT INTO students (id,school_id,admission_number,full_name,class_name) VALUES ($1,$2,$3,$4,$5)',[studentId,schoolId,'FS-TEST-001','Fee Structure Student','Grade 4']);
      await c.query("INSERT INTO fee_structures (id,school_id,class_name,academic_year,term_name,due_on,status) VALUES ($1,$2,'Grade 4','2026','Term 1','2026-11-30','active')",[structureId,schoolId]);
      await c.query("INSERT INTO fee_structure_items (id,school_id,structure_id,item_name,amount) VALUES ($1,$2,$3,'Tuition','1500.00')",[randomUUID(),schoolId,structureId]);
      await c.query("INSERT INTO fee_invoices (id,school_id,student_id,invoice_number,academic_year,description,due_on,amount,fee_structure_id) VALUES ($1,$2,$3,'FS-TEST-INVOICE-1','2026','Tuition','2026-11-30','1500.00',$4)",[invoiceId,schoolId,studentId,structureId]);
    });
    await expect(withSchoolTransaction(schoolId,c=>c.query(
      "INSERT INTO fee_invoices (id,school_id,student_id,invoice_number,academic_year,description,due_on,amount,fee_structure_id) VALUES ($1,$2,$3,'FS-TEST-INVOICE-2','2026','Tuition','2026-11-30','1500.00',$4)",
      [randomUUID(),schoolId,studentId,structureId]
    ))).rejects.toThrow();
    await withSchoolTransaction(otherSchoolId,async c=>{
      await c.query('INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',[otherSchoolId,'Other Fee Structure School',otherCode]);
      await c.query("INSERT INTO fee_structures (id,school_id,class_name,academic_year,term_name,due_on,status) VALUES ($1,$2,'Grade 4','2026','Term 1','2026-11-30','draft')",[randomUUID(),otherSchoolId]);
    });
    const isolated=await withSchoolTransaction(schoolId,c=>c.query('SELECT id FROM fee_structures WHERE school_id=$1',[otherSchoolId]));
    expect(isolated.rowCount).toBe(0);
    const invoiceCount=await withSchoolTransaction(schoolId,c=>c.query('SELECT count(*)::int AS n FROM fee_invoices WHERE school_id=$1 AND fee_structure_id=$2',[schoolId,structureId]));
    expect(invoiceCount.rows[0].n).toBe(1);
  });


  it('rejects bulk invoicing when the linked academic term has been closed', async () => {
    const schoolId=randomUUID(),userId=randomUUID(),roleId=randomUUID();
    const yearId=randomUUID(),termId=randomUUID(),studentId=randomUUID(),structureId=randomUUID();
    const code='CLOSE'+randomUUID().replaceAll('-','').slice(0,8).toUpperCase();
    await withSchoolTransaction(schoolId,async c=>{
      await c.query('INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',[schoolId,'Closed Term Billing School',code]);
      await c.query('INSERT INTO users (id,email,password_hash,full_name) VALUES ($1,$2,$3,$4)',[userId,'closed-'+code.toLowerCase()+'@example.test','test-hash','Closed Term Tester']);
      await c.query('INSERT INTO roles (id,school_id,name) VALUES ($1,$2,$3)',[roleId,schoolId,'term_billing_tester']);
      await c.query("INSERT INTO school_memberships (school_id,user_id,role_id,status) VALUES ($1,$2,$3,'active')",[schoolId,userId,roleId]);
      for(const permission of ['fees.manage']){
        await c.query('INSERT INTO permissions (code,description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING',[permission,permission]);
        await c.query('INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',[roleId,permission]);
      }
      await c.query('INSERT INTO academic_years (id,school_id,name,starts_on,ends_on,created_by) VALUES ($1,$2,$3,$4,$5,$6)',[yearId,schoolId,'2026–2027','2026-01-01','2027-12-31',userId]);
      await c.query('INSERT INTO academic_terms (id,school_id,academic_year_id,name,starts_on,ends_on,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',[termId,schoolId,yearId,'Term 3','2026-01-01','2027-03-31',userId]);
      await c.query("INSERT INTO students (id,school_id,admission_number,full_name,class_name,status) VALUES ($1,$2,'CLOSE-001','Closed Term Student','Grade 5','active')",[studentId,schoolId]);
      await c.query("INSERT INTO fee_structures (id,school_id,class_name,academic_year,term_name,academic_term_id,due_on,status,created_by) VALUES ($1,$2,'Grade 5','2026–2027','Term 3',$3,'2027-03-20','active',$4)",[structureId,schoolId,termId,userId]);
      await c.query("INSERT INTO fee_structure_items (id,school_id,structure_id,item_name,amount) VALUES ($1,$2,$3,'Tuition',1000)",[randomUUID(),schoolId,structureId]);
      await c.query("UPDATE academic_terms SET status='closed',closed_at=now(),closed_by=$3 WHERE school_id=$1 AND id=$2",[schoolId,termId,userId]);
    });
    const session=await createSession(userId,schoolId);
    const app=express();app.use(express.json());app.use('/api/v1',operationsRouter);
    const server=app.listen(0,'127.0.0.1');
    try{
      await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('Closed-term test server did not bind to a TCP port.');
      const response=await fetch('http://127.0.0.1:'+address.port+'/api/v1/fees/structures/'+structureId+'/invoice-class',{
        method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:JSON.stringify({}),
      });
      expect(response.status).toBe(409);
      expect((await response.json() as {error:string}).error).toContain('closed or missing academic term');
      const invoices=await withSchoolTransaction(schoolId,c=>c.query('SELECT id FROM fee_invoices WHERE school_id=$1 AND fee_structure_id=$2',[schoolId,structureId]));
      expect(invoices.rowCount).toBe(0);
    }finally{
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  });

  it('filters invoice reports and CSV exports by school-scoped academic term', async () => {
    const schoolId=randomUUID(), userId=randomUUID(), roleId=randomUUID();
    const studentId=randomUUID(), yearId=randomUUID(), termOneId=randomUUID(), termTwoId=randomUUID();
    const structureOneId=randomUUID(), structureTwoId=randomUUID();
    const code='TERM'+randomUUID().replaceAll('-','').slice(0,8).toUpperCase();
    await withSchoolTransaction(schoolId,async c=>{
      await c.query('INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',[schoolId,'Academic Term Report School',code]);
      await c.query('INSERT INTO users (id,email,password_hash,full_name) VALUES ($1,$2,$3,$4)',[userId,'report-'+code.toLowerCase()+'@example.test','test-hash','Report Test User']);
      await c.query('INSERT INTO roles (id,school_id,name) VALUES ($1,$2,$3)',[roleId,schoolId,'term_reporter']);
      await c.query('INSERT INTO school_memberships (school_id,user_id,role_id,status) VALUES ($1,$2,$3,$4)',[schoolId,userId,roleId,'active']);
      for(const permission of ['reports.read','reports.export','fees.read','students.read','expenses.read']){
        await c.query('INSERT INTO permissions (code,description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING',[permission,permission]);
        await c.query('INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',[roleId,permission]);
      }
      await c.query('INSERT INTO academic_years (id,school_id,name,starts_on,ends_on,created_by) VALUES ($1,$2,$3,$4,$5,$6)',[yearId,schoolId,'2026 Academic Year','2026-01-01','2026-12-31',userId]);
      await c.query('INSERT INTO academic_terms (id,school_id,academic_year_id,name,starts_on,ends_on,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7),($8,$2,$3,$9,$10,$11,$7)',[
        termOneId,schoolId,yearId,'Term 1','2026-01-01','2026-03-31',userId,
        termTwoId,'Term 2','2026-04-01','2026-06-30',
      ]);
      await c.query('INSERT INTO students (id,school_id,admission_number,full_name,class_name) VALUES ($1,$2,$3,$4,$5)',[studentId,schoolId,'TERM-001','Term Filter Student','Grade 4']);
      await c.query("INSERT INTO fee_structures (id,school_id,class_name,academic_year,term_name,academic_term_id,due_on,status) VALUES ($1,$2,'Grade 4','2026 Academic Year','Term 1',$3,'2026-03-20','active'),($4,$2,'Grade 4','2026 Academic Year','Term 2',$5,'2026-06-20','active')",[structureOneId,schoolId,termOneId,structureTwoId,termTwoId]);
      await c.query("INSERT INTO fee_invoices (id,school_id,student_id,invoice_number,academic_year,description,issued_on,due_on,amount,status,fee_structure_id) VALUES ($1,$2,$3,'TERM-INV-1','2026 Academic Year','Term 1 fees','2026-01-10','2026-03-20',1000,'issued',$4),($5,$2,$3,'TERM-INV-2','2026 Academic Year','Term 2 fees','2026-04-10','2026-06-20',2000,'issued',$6)",[
        randomUUID(),schoolId,studentId,structureOneId,randomUUID(),structureTwoId,
      ]);
      await c.query("INSERT INTO expenses (id,school_id,expense_number,category,description,incurred_on,amount,status,requested_by,academic_term_id) VALUES ($1,$2,'TERM-EXP-1','Supplies','Term 1 stationery','2026-02-10',120,'submitted',$3,$4),($5,$2,'TERM-EXP-2','Repairs','Term 2 repair','2026-05-10',240,'submitted',$3,$6)",[
        randomUUID(),schoolId,userId,termOneId,randomUUID(),termTwoId,
      ]);
    });

    const session=await createSession(userId,schoolId);
    const app=express();app.use(express.json());app.use('/api/v1',operationsRouter);
    const server=app.listen(0,'127.0.0.1');
    try{
      await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('Academic report test server did not bind to a TCP port.');
      const base='http://127.0.0.1:'+address.port;
      const headers={Authorization:'Bearer '+session.token};
      const overviewResponse=await fetch(base+'/api/v1/overview?academicTermId='+termOneId,{headers});
      expect(overviewResponse.status).toBe(200);
      const overview=await overviewResponse.json() as {summary:{fees:{billed:string;outstanding:string};expenses:{awaiting_approval:number};topOutstanding:Array<{admission_number:string}>;feeCollectionTrend:unknown[];incomeExpenseTrend:unknown[];filters:{academicTermId:string}}};
      expect(Number(overview.summary.fees.billed)).toBe(1000);
      expect(Number(overview.summary.fees.outstanding)).toBe(1000);
      expect(overview.summary.topOutstanding.map(row=>row.admission_number)).toEqual(['TERM-001']);
      expect(overview.summary.filters.academicTermId).toBe(termOneId);
      expect(overview.summary.expenses.awaiting_approval).toBe(1);
      expect(overview.summary.incomeExpenseTrend).toHaveLength(12);
      expect(overview.summary.incomeExpenseTrend.every(row=>Number((row as {income?:string}).income??0)===0)).toBe(true);

      const expenseReportResponse=await fetch(base+'/api/v1/reports/expense-register?academicTermId='+termOneId,{headers});
      expect(expenseReportResponse.status).toBe(200);
      const expenseReport=await expenseReportResponse.json() as {rows:Array<{expense_number:string}>};
      expect(expenseReport.rows.map(row=>row.expense_number)).toEqual(['TERM-EXP-1']);

      const invoiceResponse=await fetch(base+'/api/v1/reports/invoice-register?academicTermId='+termOneId,{headers});
      expect(invoiceResponse.status).toBe(200);
      const invoiceReport=await invoiceResponse.json() as {rows:Array<{invoice_number:string}>};
      expect(invoiceReport.rows.map(row=>row.invoice_number)).toEqual(['TERM-INV-1']);

      const invoiceListResponse=await fetch(base+'/api/v1/fees/invoices?academicTermId='+termOneId,{headers});
      expect(invoiceListResponse.status).toBe(200);
      expect((await invoiceListResponse.json() as {invoices:Array<{invoice_number:string}>}).invoices.map(row=>row.invoice_number)).toEqual(['TERM-INV-1']);

      const statementResponse=await fetch(base+'/api/v1/students/'+studentId+'/financial-account?academicTermId='+termTwoId,{headers});
      expect(statementResponse.status).toBe(200);
      expect((await statementResponse.json() as {transactions:Array<{reference:string}>}).transactions.map(row=>row.reference)).toEqual(['TERM-INV-2']);

      const balanceResponse=await fetch(base+'/api/v1/reports/fee-balances?academicTermId='+termTwoId,{headers});
      expect(balanceResponse.status).toBe(200);
      const balanceReport=await balanceResponse.json() as {rows:Array<{invoice_number:string}>};
      expect(balanceReport.rows.map(row=>row.invoice_number)).toEqual(['TERM-INV-2']);

      const foreignTermResponse=await fetch(base+'/api/v1/reports/invoice-register?academicTermId='+randomUUID(),{headers});
      expect(foreignTermResponse.status).toBe(200);
      expect((await foreignTermResponse.json() as {rows:unknown[]}).rows).toHaveLength(0);

      const invalidTermResponse=await fetch(base+'/api/v1/reports/invoice-register?academicTermId=not-a-uuid',{headers});
      expect(invalidTermResponse.status).toBe(400);

      const csvResponse=await fetch(base+'/api/v1/reports/invoice-register.csv?academicTermId='+termTwoId,{headers});
      expect(csvResponse.status).toBe(200);
      const csv=await csvResponse.text();
      expect(csv).toContain('TERM-INV-2');
      expect(csv).not.toContain('TERM-INV-1');
    } finally {
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  });

});

afterAll(async () => { await pool?.end(); });
