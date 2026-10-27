import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { authContext, requireAuth, requirePermission } from './auth.js';
import { withSchoolTransaction } from './db.js';

export const academicTermsRouter = Router();
academicTermsRouter.use(requireAuth);

const yearSchema = z.object({
  name: z.string().trim().min(2).max(80),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const termSchema = z.object({
  academicYearId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export function isValidDateRange(start: string, end: string): boolean {
  const s = Date.parse(start + 'T00:00:00Z');
  const e = Date.parse(end + 'T00:00:00Z');
  return Number.isFinite(s) && Number.isFinite(e) && start <= end &&
    new Date(s).toISOString().slice(0, 10) === start &&
    new Date(e).toISOString().slice(0, 10) === end;
}
function writeAudit(client: PoolClient, schoolId: string, userId: string, action: string, type: string, id: string, metadata: Record<string, unknown>) {
  return client.query(
    'INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [schoolId,userId,action,type,id,JSON.stringify(metadata)],
  );
}

academicTermsRouter.get('/academic-years', requirePermission('ledger.read'), async (req,res,next) => {
  try {
    const auth = authContext(req);
    const result = await withSchoolTransaction(auth.schoolId, c => c.query(
      \`SELECT y.id,y.name,y.starts_on,y.ends_on,y.status,y.created_at,y.closed_at,
        COALESCE(json_agg(json_build_object('id',t.id,'name',t.name,'starts_on',t.starts_on,'ends_on',t.ends_on,'status',t.status)
          ORDER BY t.starts_on) FILTER (WHERE t.id IS NOT NULL),'[]'::json) AS terms
       FROM academic_years y LEFT JOIN academic_terms t
         ON t.school_id=y.school_id AND t.academic_year_id=y.id
       WHERE y.school_id=$1 GROUP BY y.id ORDER BY y.starts_on DESC\`,
      [auth.schoolId],
    ));
    res.json({academicYears:result.rows});
  } catch (error) { next(error); }
});

academicTermsRouter.post('/academic-years', requirePermission('periods.manage'), async (req,res,next) => {
  try {
    const parsed = yearSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({error:'Invalid academic-year details.',details:parsed.error.flatten()}); return; }
    const d = parsed.data;
    if (!isValidDateRange(d.startsOn,d.endsOn)) { res.status(422).json({error:'Academic-year start must be on or before its end and both must be real calendar dates.'}); return; }
    const auth = authContext(req);
    const year = await withSchoolTransaction(auth.schoolId, async c => {
      const overlap = await c.query(
        \`SELECT id FROM academic_years WHERE school_id=$1 AND daterange(starts_on,ends_on,'[]') && daterange($2::date,$3::date,'[]') LIMIT 1\`,
        [auth.schoolId,d.startsOn,d.endsOn],
      );
      if (overlap.rowCount) throw Object.assign(new Error('Academic years cannot overlap.'),{statusCode:409});
      const inserted = await c.query(
        'INSERT INTO academic_years(school_id,name,starts_on,ends_on,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,starts_on,ends_on,status',
        [auth.schoolId,d.name,d.startsOn,d.endsOn,auth.userId],
      );
      await writeAudit(c,auth.schoolId,auth.userId,'academic_year.create','academic_year',inserted.rows[0].id,{name:d.name,startsOn:d.startsOn,endsOn:d.endsOn});
      return inserted.rows[0];
    });
    res.status(201).json({academicYear:year});
  } catch (error) { next(error); }
});

academicTermsRouter.post('/academic-terms', requirePermission('periods.manage'), async (req,res,next) => {
  try {
    const parsed = termSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({error:'Invalid academic-term details.',details:parsed.error.flatten()}); return; }
    const d = parsed.data;
    if (!validRange(d.startsOn,d.endsOn)) { res.status(422).json({error:'Term start must be on or before its end and both must be real calendar dates.'}); return; }
    const auth = authContext(req);
    const term = await withSchoolTransaction(auth.schoolId, async c => {
      const year = await c.query(
        'SELECT id,starts_on,ends_on,status FROM academic_years WHERE school_id=$1 AND id=$2 FOR UPDATE',
        [auth.schoolId,d.academicYearId],
      );
      if (!year.rowCount) throw Object.assign(new Error('Academic year not found.'),{statusCode:404});
      const y = year.rows[0] as {starts_on:string;ends_on:string;status:string};
      const ys = String(y.starts_on).slice(0,10), ye = String(y.ends_on).slice(0,10);
      if (y.status !== 'open') throw Object.assign(new Error('Cannot add a term to a closed academic year.'),{statusCode:409});
      if (d.startsOn < ys || d.endsOn > ye) throw Object.assign(new Error('Term dates must be within the academic year.'),{statusCode:422});
      const overlap = await c.query(
        \`SELECT id FROM academic_terms WHERE school_id=$1 AND academic_year_id=$2 AND daterange(starts_on,ends_on,'[]') && daterange($3::date,$4::date,'[]') LIMIT 1\`,
        [auth.schoolId,d.academicYearId,d.startsOn,d.endsOn],
      );
      if (overlap.rowCount) throw Object.assign(new Error('Terms within an academic year cannot overlap.'),{statusCode:409});
      const inserted = await c.query(
        'INSERT INTO academic_terms(school_id,academic_year_id,name,starts_on,ends_on,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,academic_year_id,name,starts_on,ends_on,status',
        [auth.schoolId,d.academicYearId,d.name,d.startsOn,d.endsOn,auth.userId],
      );
      await writeAudit(c,auth.schoolId,auth.userId,'academic_term.create','academic_term',inserted.rows[0].id,{academicYearId:d.academicYearId,name:d.name,startsOn:d.startsOn,endsOn:d.endsOn});
      return inserted.rows[0];
    });
    res.status(201).json({academicTerm:term});
  } catch (error) { next(error); }
});

academicTermsRouter.post('/academic-terms/:id/close', requirePermission('periods.manage'), async (req,res,next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({reason:z.string().trim().min(8).max(500)}).safeParse(req.body);
    if (!id.success || !body.success) { res.status(400).json({error:'A valid term ID and closure reason of at least 8 characters are required.'}); return; }
    const auth = authContext(req);
    const term = await withSchoolTransaction(auth.schoolId, async c => {
      const found = await c.query('SELECT id,status FROM academic_terms WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,id.data]);
      if (!found.rowCount) throw Object.assign(new Error('Academic term not found.'),{statusCode:404});
      if (found.rows[0].status === 'closed') throw Object.assign(new Error('Academic term is already closed.'),{statusCode:409});
      const updated = await c.query(
        \`UPDATE academic_terms SET status='closed',closed_at=now(),closed_by=$3
         WHERE school_id=$1 AND id=$2 RETURNING id,name,status,closed_at\`,
        [auth.schoolId,id.data,auth.userId],
      );
      await writeAudit(c,auth.schoolId,auth.userId,'academic_term.close','academic_term',id.data,{reason:body.data.reason});
      return updated.rows[0];
    });
    res.json({academicTerm:term});
  } catch (error) { next(error); }
});
