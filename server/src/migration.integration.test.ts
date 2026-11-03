import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool, withSchoolTransaction } from './db.js';

describe.skipIf(!process.env.DATABASE_URL)('school book migration database controls',()=>{
  it('enforces tenant isolation, independent review and append-only approvals',async()=>{
    const schoolA=randomUUID(),schoolB=randomUUID();
    const creator=randomUUID(),reviewer=randomUUID(),batchId=randomUUID();
    const code='MIG'+randomUUID().replaceAll('-','').slice(0,10).toUpperCase();
    await withSchoolTransaction(schoolA,async client=>{
      await client.query('INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',[schoolA,'Migration Test School A',code]);
      await client.query('INSERT INTO users (id,email,password_hash,full_name) VALUES ($1,$2,$3,$4),($5,$6,$3,$7)',[
        creator,'migration-maker-'+code.toLowerCase()+'@example.test','test-hash','Migration Maker',
        reviewer,'migration-reviewer-'+code.toLowerCase()+'@example.test','Migration Reviewer',
      ]);
      await client.query(
        "INSERT INTO migration_batches (id,school_id,batch_type,status,effective_date,description,source_label,created_by) VALUES ($1,$2,'opening_balances','draft','2026-01-01','Opening balances at migration cut-off','Paper cashbook',$3)",
        [batchId,schoolA,creator],
      );
      await client.query(
        "INSERT INTO migration_batch_rows (school_id,batch_id,row_number,fingerprint,payload) VALUES ($1,$2,1,$3,$4::jsonb)",
        [schoolA,batchId,'a'.repeat(64),JSON.stringify({accountCode:'1000',debit:'100.00',credit:'0.00'})],
      );
      await client.query("UPDATE migration_batches SET status='pending_review',row_count=1,submitted_at=now() WHERE school_id=$1 AND id=$2",[schoolA,batchId]);
    });
    await expect(withSchoolTransaction(schoolA,client=>client.query(
      "UPDATE migration_batch_rows SET payload='{}'::jsonb WHERE school_id=$1 AND batch_id=$2",
      [schoolA,batchId],
    ))).rejects.toThrow(/only be changed while the batch is draft/i);
    await expect(withSchoolTransaction(schoolA,client=>client.query(
      "UPDATE migration_batches SET effective_date='2026-02-01' WHERE school_id=$1 AND id=$2",
      [schoolA,batchId],
    ))).rejects.toThrow(/details are immutable/i);
    await expect(withSchoolTransaction(schoolA,client=>client.query(
      "INSERT INTO migration_batch_approvals (school_id,batch_id,reviewer_user_id,decision) VALUES ($1,$2,$3,'approved')",
      [schoolA,batchId,creator],
    ))).rejects.toThrow(/cannot approve their own batch/i);
    await withSchoolTransaction(schoolA,client=>client.query(
      "INSERT INTO migration_batch_approvals (school_id,batch_id,reviewer_user_id,decision,note) VALUES ($1,$2,$3,'approved','Reviewed independently')",
      [schoolA,batchId,reviewer],
    ));
    await withSchoolTransaction(schoolA,client=>client.query(
      "UPDATE migration_batches SET status='approved',reviewed_by=$3,reviewed_at=now(),review_note='Reviewed independently' WHERE school_id=$1 AND id=$2",
      [schoolA,batchId,reviewer],
    ));
    await expect(withSchoolTransaction(schoolA,client=>client.query(
      "UPDATE migration_batch_approvals SET note='tampered' WHERE school_id=$1 AND batch_id=$2",
      [schoolA,batchId],
    ))).rejects.toThrow(/append-only/i);
    await withSchoolTransaction(schoolB,client=>client.query(
      'INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',
      [schoolB,'Migration Test School B','MIGB'+code.slice(3)],
    ));
    const isolated=await withSchoolTransaction(schoolB,client=>
      client.query('SELECT id FROM migration_batches WHERE school_id=$1',[schoolA]),
    );
    expect(isolated.rowCount).toBe(0);
    const own=await withSchoolTransaction(schoolA,client=>
      client.query('SELECT status,row_count FROM migration_batches WHERE school_id=$1 AND id=$2',[schoolA,batchId]),
    );
    expect(own.rows[0]).toMatchObject({status:'approved',row_count:1});
  });
});
afterAll(async()=>{await pool?.end();});
