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

});

afterAll(async () => { await pool?.end(); });
