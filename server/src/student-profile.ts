import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authContext, requireAuth, requirePermission } from './auth.js';
import { withSchoolTransaction } from './db.js';

export const studentProfileRouter = Router();
studentProfileRouter.use(requireAuth);

const studentProfileSchema = z.object({
  admissionNumber: z.string().trim().min(1).max(40),
  fullName: z.string().trim().min(2).max(160),
  className: z.string().trim().max(80).optional(),
  sex: z.enum(['female','male','other','prefer_not_to_say']).optional().or(z.literal('')),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v, 'Enter a valid date of birth.').optional().or(z.literal('')),
  guardianName: z.string().trim().max(160).optional(),
  guardianRelationship: z.string().trim().max(80).optional(),
  guardianPhone: z.string().trim().max(40).optional(),
  guardianAlternatePhone: z.string().trim().max(40).optional(),
  homeAddress: z.string().trim().max(300).optional(),
  emergencyContactName: z.string().trim().max(160).optional(),
  emergencyContactPhone: z.string().trim().max(40).optional(),
});

function wrap(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => { void handler(req,res,next).catch(next); };
}

studentProfileRouter.get('/students', requirePermission('students.read'), wrap(async (req,res) => {
  const auth = authContext(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0,100) : '';
  const result = await withSchoolTransaction(auth.schoolId, client => client.query(
    `SELECT id,admission_number,full_name,class_name,sex,date_of_birth,guardian_name,guardian_relationship,
            guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone,
            status,created_at
     FROM students WHERE school_id=$1 AND ($2='' OR admission_number ILIKE '%'||$2||'%' OR full_name ILIKE '%'||$2||'%')
     ORDER BY full_name LIMIT 500`, [auth.schoolId,q]));
  res.json({students:result.rows});
}));

studentProfileRouter.post('/students', requirePermission('students.manage'), wrap(async (req,res) => {
  const parsed = studentProfileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({error:'Invalid student details.',details:parsed.error.flatten()}); return; }
  const auth = authContext(req);
  const d = parsed.data;
  const student = await withSchoolTransaction(auth.schoolId, async client => {
    const result = await client.query(
      `INSERT INTO students (school_id,admission_number,full_name,class_name,sex,date_of_birth,guardian_name,
        guardian_relationship,guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id,admission_number,full_name,class_name,sex,date_of_birth,guardian_name,guardian_relationship,
        guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone,status,created_at`,
      [auth.schoolId,d.admissionNumber,d.fullName,d.className||null,d.sex||null,d.dateOfBirth||null,d.guardianName||null,
       d.guardianRelationship||null,d.guardianPhone||null,d.guardianAlternatePhone||null,d.homeAddress||null,
       d.emergencyContactName||null,d.emergencyContactPhone||null]);
    await client.query(
      "INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,'student.create','student',$3,$4::jsonb)",
      [auth.schoolId,auth.userId,result.rows[0].id,JSON.stringify({fields:['admissionNumber','fullName','className','sex','dateOfBirth','guardianName','guardianRelationship','guardianPhone','guardianAlternatePhone','homeAddress','emergencyContactName','emergencyContactPhone']})]);
    return result.rows[0];
  });
  res.status(201).json({student});
}));

studentProfileRouter.get('/students/:studentId/financial-account', requirePermission('students.read'), wrap(async (req,res) => {
  const auth = authContext(req);
  const studentId = String(req.params.studentId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(studentId)) {
    res.status(400).json({error:'Invalid student ID.'}); return;
  }
  const result = await withSchoolTransaction(auth.schoolId, async client => {
    const student = await client.query(
      `SELECT id,admission_number,full_name,class_name,sex,date_of_birth,guardian_name,guardian_relationship,
              guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone,status
       FROM students WHERE school_id=$1 AND id=$2`, [auth.schoolId,studentId]);
    if (!student.rowCount) return null;
    const transactions = await client.query(
      `WITH events AS (
        SELECT i.id AS transaction_id,i.issued_on::date AS transaction_date,i.invoice_number AS reference,
          COALESCE(i.description,'School fees') AS description,'invoice'::text AS transaction_type,
          i.amount::numeric(14,2) AS debit,0::numeric(14,2) AS credit,1 AS sort_order
        FROM fee_invoices i WHERE i.school_id=$1 AND i.student_id=$2 AND i.status<>'void'
        UNION ALL
        SELECT r.id,r.received_on::date,r.receipt_number,COALESCE(r.notes,'Fee payment · '||r.payment_method),
          'receipt'::text,0::numeric(14,2),r.amount::numeric(14,2),2
        FROM fee_receipts r WHERE r.school_id=$1 AND r.student_id=$2 AND r.status='posted'
        UNION ALL
        SELECT w.id,w.waived_on::date,w.waiver_number,w.reason,'waiver'::text,0::numeric(14,2),w.amount::numeric(14,2),3
        FROM fee_waivers w JOIN fee_invoices i ON i.id=w.invoice_id AND i.school_id=w.school_id
        WHERE w.school_id=$1 AND i.student_id=$2 AND w.status='posted'
      ), balances AS (
        SELECT *,SUM(debit-credit) OVER(ORDER BY transaction_date,sort_order,reference,transaction_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
        FROM events
      )
      SELECT transaction_id,transaction_date,reference,description,transaction_type,debit::text,credit::text,
        running_balance::numeric(14,2)::text AS running_balance
      FROM balances ORDER BY transaction_date,sort_order,reference,transaction_id`, [auth.schoolId,studentId]);
    const totals = await client.query(
      `SELECT COALESCE(sum(debit),0)::numeric(14,2)::text AS billed,
        COALESCE(sum(credit),0)::numeric(14,2)::text AS credits,
        COALESCE(sum(debit-credit),0)::numeric(14,2)::text AS balance
       FROM (
         SELECT i.amount::numeric AS debit,0::numeric AS credit FROM fee_invoices i WHERE i.school_id=$1 AND i.student_id=$2 AND i.status<>'void'
         UNION ALL SELECT 0::numeric,r.amount::numeric FROM fee_receipts r WHERE r.school_id=$1 AND r.student_id=$2 AND r.status='posted'
         UNION ALL SELECT 0::numeric,w.amount::numeric FROM fee_waivers w JOIN fee_invoices i ON i.id=w.invoice_id AND i.school_id=w.school_id WHERE w.school_id=$1 AND i.student_id=$2 AND w.status='posted'
       ) t`, [auth.schoolId,studentId]);
    return {student:student.rows[0],transactions:transactions.rows,totals:totals.rows[0]};
  });
  if (!result) { res.status(404).json({error:'Student not found in this school.'}); return; }
  res.json(result);
}));
