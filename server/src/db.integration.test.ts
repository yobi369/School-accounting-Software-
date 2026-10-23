import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool, withSchoolTransaction } from './db.js';
import { authenticateRequest, createSession } from './auth.js';

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
      await c.query('INSERT INTO students (id,school_id,admission_number,full_name) VALUES ($1,$2,$3,$4)',[studentA,schoolA,'TEST-A','Test Student A']);
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
    await withSchoolTransaction(schoolA, async c => {
      await c.query("INSERT INTO journal_entries (id,school_id,financial_year_id,period_id,entry_number,posting_date,description,status,source_type) VALUES ($1,$2,$3,$4,1,'2026-03-01','Integration posting','draft','test')",[journalId,schoolA,yearId,periodId]);
      const insertedLines=await c.query("INSERT INTO journal_lines (school_id,journal_entry_id,account_id,line_number,debit,credit) VALUES ($1,$2,$3,1,100.00,0),($1,$2,$4,2,0,100.00) RETURNING id",[schoolA,journalId,cashId,incomeId]);
      await c.query("UPDATE journal_entries SET status='posted' WHERE school_id=$1 AND id=$2",[schoolA,journalId]);
      const posted = await c.query('SELECT status,posted_at FROM journal_entries WHERE school_id=$1 AND id=$2',[schoolA,journalId]);
      expect(posted.rows[0].status).toBe('posted');
      expect(posted.rows[0].posted_at).toBeTruthy();
      await expect(c.query("UPDATE journal_entries SET description='tampered' WHERE school_id=$1 AND id=$2",[schoolA,journalId])).rejects.toThrow();
      await expect(c.query('UPDATE journal_lines SET debit=200 WHERE school_id=$1 AND id=$2',[schoolA,insertedLines.rows[0].id])).rejects.toThrow();
      await expect(c.query('DELETE FROM journal_lines WHERE school_id=$1 AND id=$2',[schoolA,insertedLines.rows[1].id])).rejects.toThrow();

      // Database-level posting integrity must reject an unbalanced draft even if
      // an application handler or caller attempts to bypass domain validation.
      const unbalancedId=randomUUID();
      await c.query("INSERT INTO journal_entries (id,school_id,financial_year_id,period_id,entry_number,posting_date,description,status,source_type) VALUES ($1,$2,$3,$4,2,'2026-03-02','Unbalanced integration posting','draft','test')",[unbalancedId,schoolA,yearId,periodId]);
      await c.query("INSERT INTO journal_lines (school_id,journal_entry_id,account_id,line_number,debit,credit) VALUES ($1,$2,$3,1,100.00,0),($1,$2,$4,2,0,99.00)",[schoolA,unbalancedId,cashId,incomeId]);
      await expect(c.query("UPDATE journal_entries SET status='posted' WHERE school_id=$1 AND id=$2",[schoolA,unbalancedId])).rejects.toThrow(/equal, positive debit and credit totals/);
    });
  });
});

afterAll(async () => { await pool?.end(); });
