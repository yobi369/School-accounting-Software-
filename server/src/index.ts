import express, { type NextFunction, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authContext, createSession, hashPassword, hashToken, requireAuth, requirePermission, safeSecretEquals, verifyPassword } from './auth.js';
import { pool, requirePool, withSchoolTransaction } from './db.js';
import { operationsRouter } from './operations.js';
import { formatMinorUnitsKes, parseKesToMinorUnits, validateJournal } from './domain/ledger.js';

const app = express();
const loginAttempts = new Map<string,{count:number;resetAt:number}>();
let lastLoginAttemptSweep = 0;
function sweepLoginAttempts(now:number):void {
  if(now-lastLoginAttemptSweep<60_000 && loginAttempts.size<10_000)return;
  lastLoginAttemptSweep=now;
  for(const [key,value] of loginAttempts) if(value.resetAt<=now) loginAttempts.delete(key);
  // Bound memory use even during distributed low-rate traffic.
  while(loginAttempts.size>10_000){const oldest=loginAttempts.keys().next().value as string|undefined;if(!oldest)break;loginAttempts.delete(oldest);}
}
const minorToDecimal = (amount:bigint) => (amount/100n).toString()+'.'+(amount%100n).toString().padStart(2,'0');
app.disable('x-powered-by');
app.use(express.json({ limit: '300kb', strict: true }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'shuleledger-api' });
});
app.get('/ready',async(_req,res)=>{
  try{await requirePool().query('SELECT 1');res.status(200).json({status:'ready'});}
  catch{res.status(503).json({status:'not_ready'});}
});

app.get('/api/v1/status', (_req, res) => {
  res.status(200).json({
    name: 'ShuleLedger API',
    readiness: 'development',
    productionReady: false,
    databaseConfigured: Boolean(pool),
    enabled: ['health-and-readiness-checks', 'exact-decimal-validation', 'database-authentication', 'tenant-context', 'role-permissions', 'fee-invoices-and-receipts', 'receipt-allocation', 'fee-waivers', 'expense-approval-and-payment', 'double-entry-journals', 'period-controls', 'budgets', 'bank-statement-import-and-reconciliation', '18-financial-reports', 'csv-xlsx-pdf-exports', 'offline-expense-drafts'],
    limitedOrOperationallyUnverified: ['offline-sync-is-limited-to-expense-drafts', 'production-provider-backup-and-restore', 'external-penetration-testing', 'production-hosting-configuration', 'mpesa-and-kra-etims-integrations', 'multi-factor-authentication', 'sms-and-email-delivery'],
  });
});

const bootstrapSchema = z.object({
  schoolName: z.string().trim().min(2).max(160),
  schoolCode: z.string().trim().min(2).max(24).regex(/^[a-zA-Z0-9_-]+$/),
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(200),
  financialYearStart: z.string().regex(/^\d{4}-01-01$/).optional(),
});
app.post('/api/v1/auth/bootstrap', async (req, res, next) => {
  try {
    const configured = process.env.BOOTSTRAP_TOKEN;
    const provided = req.header('x-bootstrap-token') ?? '';
    if (!configured || !safeSecretEquals(provided, configured)) {
      res.status(403).json({ error: 'Bootstrap is not authorized.' });
      return;
    }
    const parsed = bootstrapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid setup details.', details: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;
    const schoolId = randomUUID();
    const userId = randomUUID();
    const email = input.email.toLowerCase();
    const schoolCode = input.schoolCode.toUpperCase();
    const passwordHash = await hashPassword(input.password);
    const currentYear = Number((input.financialYearStart ?? `${new Date().getFullYear()}-01-01`).slice(0, 4));
    if (currentYear < 2000 || currentYear > 2200) {
      res.status(400).json({ error: 'Financial year must be a valid year.' });
      return;
    }

    await withSchoolTransaction(schoolId, async client => {
      await client.query(
        'INSERT INTO schools (id,name,code) VALUES ($1,$2,$3)',
        [schoolId, input.schoolName.trim(), schoolCode],
      );
      await client.query(
        'INSERT INTO users (id,email,password_hash,full_name,must_change_password) VALUES ($1,$2,$3,$4,true)',
        [userId, email, passwordHash, input.fullName.trim()],
      );
      const permissionCodes = [
        'school.manage','users.manage','bank.manage','students.read','students.create','students.manage','fees.read','fees.manage',
        'receipts.create','ledger.read','ledger.post','expenses.read','expenses.create',
        'expenses.approve','expenses.pay','bank.read','bank.reconcile','reports.read','reports.export',
        'periods.manage','audit.read',
      ];
      for (const code of permissionCodes) {
        await client.query('INSERT INTO permissions (code,description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', [code, code.replaceAll('.', ' ')]);
      }
      const rolePermissions: Record<string, string[]> = {
        school_admin: permissionCodes,
        bursar: ['students.read','fees.read','fees.manage','receipts.create','reports.read'],
        accountant: ['students.read','fees.read','receipts.create','ledger.read','ledger.post','expenses.read','expenses.create','bank.read','bank.reconcile','reports.read','reports.export','audit.read'],
        approver: ['expenses.read','expenses.approve','expenses.pay','reports.read'],
        auditor: ['students.read','fees.read','ledger.read','expenses.read','bank.read','reports.read','reports.export','audit.read'],
      };
      const roleIds: Record<string,string> = {};
      for (const [roleName, codes] of Object.entries(rolePermissions)) {
        const roleId = randomUUID();
        roleIds[roleName] = roleId;
        await client.query('INSERT INTO roles (id,school_id,name) VALUES ($1,$2,$3)', [roleId,schoolId,roleName]);
        for (const code of codes) {
          await client.query('INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [roleId,code]);
        }
      }
      await client.query('INSERT INTO school_memberships (school_id,user_id,role_id) VALUES ($1,$2,$3)', [schoolId,userId,roleIds.school_admin]);
      const yearId = randomUUID();
      const starts = `${currentYear}-01-01`;
      const ends = `${currentYear}-12-31`;
      await client.query('INSERT INTO financial_years (id,school_id,name,starts_on,ends_on) VALUES ($1,$2,$3,$4,$5)', [yearId,schoolId,String(currentYear),starts,ends]);
      for (let month=1; month<=12; month++) {
        const periodStart = `${currentYear}-${String(month).padStart(2,'0')}-01`;
        const periodEndDate = new Date(Date.UTC(currentYear,month,0));
        const periodEnd = `${currentYear}-${String(month).padStart(2,'0')}-${String(periodEndDate.getUTCDate()).padStart(2,'0')}`;
        await client.query('INSERT INTO accounting_periods (school_id,financial_year_id,starts_on,ends_on) VALUES ($1,$2,$3,$4)', [schoolId,yearId,periodStart,periodEnd]);
      }
      const accounts = [
        ['1000','Cash on hand','asset'],['1100','Bank account','asset'],['1200','Fees receivable','asset'],
        ['2000','Accounts payable','liability'],['3000','Opening fund balance','equity'],
        ['4000','School fee income','income'],['4100','Other income','income'],['4200','Fee waivers (contra-income)','income'],
        ['5000','Teaching and learning expenses','expense'],['5100','Administration expenses','expense'],
      ];
      for (const [code,name,type] of accounts) {
        await client.query('INSERT INTO accounts (school_id,code,name,account_type) VALUES ($1,$2,$3,$4)', [schoolId,code,name,type]);
      }
      await client.query(
        "INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,'school.bootstrap','school',$1,$3::jsonb)",
        [schoolId,userId,JSON.stringify({ schoolCode, email })],
      );
    });
    res.status(201).json({ created: true, schoolId, message: 'School workspace created. Sign in with its school ID and the administrator credentials.' });
  } catch (error) {
    next(error);
  }
});

const loginSchema = z.object({
  schoolId: z.string().uuid(),
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});
app.post('/api/v1/auth/login', async (req, res, next) => {
  try {
    const attemptKey=req.ip||'unknown';
    const now=Date.now();
    sweepLoginAttempts(now);
    const prior=loginAttempts.get(attemptKey);
    if(!prior||prior.resetAt<=now) loginAttempts.set(attemptKey,{count:1,resetAt:now+15*60*1000});
    else if(prior.count>=15){res.status(429).json({error:'Too many sign-in attempts. Try again in 15 minutes.'});return;}
    else prior.count+=1;
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter a valid school ID, email, and password.' });
      return;
    }
    const { schoolId, email, password } = parsed.data;
    const db = requirePool();
    const userResult = await db.query(
      "SELECT id,email,password_hash,full_name,status,must_change_password FROM users WHERE lower(email)=lower($1) LIMIT 1",
      [email],
    );
    if (userResult.rowCount !== 1) {
      res.status(401).json({ error: 'Invalid credentials or school membership.' });
      return;
    }
    const user = userResult.rows[0] as { id:string; email:string; password_hash:string; full_name:string; status:string; must_change_password:boolean };
    if (user.status !== 'active' || !(await verifyPassword(password,user.password_hash))) {
      res.status(401).json({ error: 'Invalid credentials or school membership.' });
      return;
    }
    const membership = await withSchoolTransaction(schoolId, async client => {
      const result = await client.query(
        "SELECT m.id, sc.name AS school_name FROM school_memberships m JOIN schools sc ON sc.id=m.school_id WHERE m.school_id=$1 AND m.user_id=$2 AND m.status='active' AND sc.status='active' LIMIT 1",
        [schoolId,user.id],
      );
      return result.rows[0] as {id:string; school_name:string} | undefined;
    });
    if (!membership) {
      res.status(401).json({ error: 'Invalid credentials or school membership.' });
      return;
    }
    loginAttempts.delete(attemptKey);
    const session = await createSession(user.id,schoolId);
    await withSchoolTransaction(schoolId, async client => {
      await client.query(
        "INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id) VALUES ($1,$2,'auth.login','user',$2)",
        [schoolId,user.id],
      );
    });
    res.status(200).json({
      token: session.token, tokenType: 'Bearer', expiresAt: session.expiresAt.toISOString(),
      user: { id:user.id,email:user.email,fullName:user.full_name,mustChangePassword:user.must_change_password },
      school: { id:schoolId,name:membership.school_name },
    });
  } catch (error) {
    next(error);
  }
});




app.post('/api/v1/auth/accept-invitation',requireAuth,async(req,res,next)=>{
  try{
    const p=z.object({token:z.string().min(60).max(200)}).safeParse(req.body);
    if(!p.success){res.status(400).json({error:'Provide a valid school invitation token.'});return;}
    const auth=authContext(req);const parts=p.data.token.split('.');
    if(parts.length!==2||! /^[0-9a-f-]{36}$/i.test(parts[0])||parts[1].length<32){res.status(400).json({error:'Invitation token format is invalid.'});return;}
    const targetSchoolId=parts[0];const tokenHash=hashToken(p.data.token);
    const membership=await withSchoolTransaction(targetSchoolId,async client=>{
      const result=await client.query(
        `SELECT i.id,i.email,i.role_id,i.expires_at,i.accepted_at,i.revoked_at,sc.name AS school_name,r.name AS role_name
         FROM school_invitations i JOIN schools sc ON sc.id=i.school_id
         JOIN roles r ON r.id=i.role_id AND r.school_id=i.school_id
         WHERE i.school_id=$1 AND i.token_hash=$2 FOR UPDATE OF i`,[targetSchoolId,tokenHash]);
      if(!result.rowCount)throw Object.assign(new Error('Invitation token is invalid.'),{statusCode:404});
      const invite=result.rows[0];
      if(String(invite.email).toLowerCase()!==auth.email.toLowerCase())throw Object.assign(new Error('Sign in with the email address this invitation was issued to.'),{statusCode:403});
      if(invite.accepted_at||invite.revoked_at)throw Object.assign(new Error('This invitation has already been used or revoked.'),{statusCode:409});
      if(new Date(invite.expires_at).getTime()<=Date.now())throw Object.assign(new Error('This invitation has expired. Ask the school administrator to issue a new one.'),{statusCode:410});
      const existing=await client.query('SELECT 1 FROM school_memberships WHERE school_id=$1 AND user_id=$2',[targetSchoolId,auth.userId]);
      if(existing.rowCount)throw Object.assign(new Error('You already have a membership in this school.'),{statusCode:409});
      await client.query("INSERT INTO school_memberships (school_id,user_id,role_id,status) VALUES ($1,$2,$3,'active')",[targetSchoolId,auth.userId,invite.role_id]);
      await client.query('UPDATE school_invitations SET accepted_at=now() WHERE school_id=$1 AND id=$2',[targetSchoolId,invite.id]);
      await client.query("INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,'user.invitation.accept','school_invitation',$3,$4::jsonb)",[targetSchoolId,auth.userId,invite.id,JSON.stringify({email:auth.email})]);
      return {schoolId:targetSchoolId,schoolName:String(invite.school_name),roleId:String(invite.role_id),roleName:String(invite.role_name)};
    });
    const rotated=await createSession(auth.userId,targetSchoolId);
    const permissions=await withSchoolTransaction(targetSchoolId,async client=>{
      const r=await client.query('SELECT permission_code FROM role_permissions WHERE role_id=$1 ORDER BY permission_code',[membership.roleId]);
      return r.rows.map(row=>String(row.permission_code));
    });
    await withSchoolTransaction(auth.schoolId,client=>client.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND school_id=$2 AND revoked_at IS NULL",[auth.sessionId,auth.schoolId]).then(()=>undefined));
    res.status(200).json({token:rotated.token,tokenType:'Bearer',expiresAt:rotated.expiresAt.toISOString(),user:{id:auth.userId,email:auth.email,fullName:auth.fullName,mustChangePassword:auth.mustChangePassword},school:{id:membership.schoolId,name:membership.schoolName},role:membership.roleName,permissions});
  }catch(error){next(error);}
});

app.get('/api/v1/auth/workspaces',requireAuth,async(req,res,next)=>{
  try{
    const auth=authContext(req);
    const workspaces=await withSchoolTransaction(auth.schoolId,async client=>{
      await client.query("SELECT set_config('app.user_id',$1,true)",[auth.userId]);
      const result=await client.query(
        `SELECT sc.id AS school_id,sc.name AS school_name,r.name AS role_name
         FROM school_memberships m JOIN schools sc ON sc.id=m.school_id
         JOIN roles r ON r.id=m.role_id AND r.school_id=m.school_id
         WHERE m.user_id=$1 AND m.status='active' AND sc.status='active'
         ORDER BY sc.name`,[auth.userId]);
      return result.rows;
    });
    res.json({workspaces});
  }catch(error){next(error);}
});
app.post('/api/v1/auth/switch-workspace',requireAuth,async(req,res,next)=>{
  try{
    const p=z.object({schoolId:z.string().uuid()}).safeParse(req.body);
    if(!p.success){res.status(400).json({error:'Provide a valid school ID.'});return;}
    const auth=authContext(req);const target=p.data.schoolId;
    const membership=await withSchoolTransaction(auth.schoolId,async client=>{
      await client.query("SELECT set_config('app.user_id',$1,true)",[auth.userId]);
      const result=await client.query(
        `SELECT sc.id AS school_id,sc.name AS school_name,r.id AS role_id,r.name AS role_name,u.email,u.full_name,u.must_change_password
         FROM school_memberships m JOIN schools sc ON sc.id=m.school_id
         JOIN roles r ON r.id=m.role_id AND r.school_id=m.school_id
         JOIN users u ON u.id=m.user_id
         WHERE m.school_id=$1 AND m.user_id=$2 AND m.status='active' AND sc.status='active' AND u.status='active'`,
        [target,auth.userId]);
      return result.rows[0] as {school_id:string;school_name:string;role_id:string;role_name:string;email:string;full_name:string;must_change_password:boolean}|undefined;
    });
    if(!membership){res.status(403).json({error:'You do not have active membership in that school.'});return;}
    const rotated=await createSession(auth.userId,target);
    const permissions=await withSchoolTransaction(target,async client=>{
      const r=await client.query('SELECT permission_code FROM role_permissions WHERE role_id=$1 ORDER BY permission_code',[membership.role_id]);
      await client.query(
        "INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,'auth.workspace.switch','school',$3,$4::jsonb)",
        [target,auth.userId,target,JSON.stringify({fromSchoolId:auth.schoolId})]);
      return r.rows.map(row=>String(row.permission_code));
    });
    await withSchoolTransaction(auth.schoolId,client=>client.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND school_id=$2 AND revoked_at IS NULL",[auth.sessionId,auth.schoolId]).then(()=>undefined));
    res.json({
      token:rotated.token,tokenType:'Bearer',expiresAt:rotated.expiresAt.toISOString(),
      user:{id:auth.userId,email:membership.email,fullName:membership.full_name,mustChangePassword:membership.must_change_password},
      school:{id:target,name:membership.school_name},role:membership.role_name,permissions,
    });
  }catch(error){next(error);}
});

app.post('/api/v1/auth/change-password', requireAuth, async (req,res,next) => {
  try {
    const parsed=z.object({currentPassword:z.string().min(1).max(200),newPassword:z.string().min(12).max(200)}).safeParse(req.body);
    if(!parsed.success){res.status(400).json({error:'New password must be at least 12 characters.',details:parsed.error.flatten()});return;}
    if(parsed.data.currentPassword===parsed.data.newPassword){res.status(422).json({error:'Choose a new password different from the current password.'});return;}
    const auth=authContext(req);
    const db=requirePool();
    const current=await db.query('SELECT password_hash FROM users WHERE id=$1 AND status=\'active\'',[auth.userId]);
    if(!current.rowCount||!(await verifyPassword(parsed.data.currentPassword,String(current.rows[0].password_hash)))){
      res.status(401).json({error:'Current password is incorrect.'});return;
    }
    const passwordHash=await hashPassword(parsed.data.newPassword);
    await withSchoolTransaction(auth.schoolId,async client=>{
      await client.query('UPDATE users SET password_hash=$2,must_change_password=false,password_changed_at=now() WHERE id=$1',[auth.userId,passwordHash]);
      await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND school_id=$2 AND id<>$3 AND revoked_at IS NULL',[auth.userId,auth.schoolId,auth.sessionId]);
      await client.query("INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id) VALUES ($1,$2,'auth.password.change','user',$2)",[auth.schoolId,auth.userId]);
    });
    const rotated=await createSession(auth.userId,auth.schoolId);
    res.json({changed:true,token:rotated.token,expiresAt:rotated.expiresAt.toISOString(),message:'Password updated. Previous sessions are no longer valid.'});
  }catch(error){next(error);}
});

app.post('/api/v1/auth/logout', requireAuth, async (req,res,next) => {
  try {
    const auth = authContext(req);
    await withSchoolTransaction(auth.schoolId, async client => {
      await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND school_id=$2 AND revoked_at IS NULL',[auth.sessionId,auth.schoolId]);
      await client.query(
        "INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id) VALUES ($1,$2,'auth.logout','user',$2)",
        [auth.schoolId,auth.userId],
      );
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/v1/auth/me', requireAuth, (req,res) => {
  const auth = authContext(req);
  res.json({ user:{id:auth.userId,email:auth.email,fullName:auth.fullName,mustChangePassword:auth.mustChangePassword},school:{id:auth.schoolId,name:auth.schoolName},role:auth.role,permissions:auth.permissions });
});

app.get('/api/v1/ledger/accounts', requireAuth, requirePermission('ledger.read'), async (req,res,next) => {
  try {
    const auth = authContext(req);
    const rows = await withSchoolTransaction(auth.schoolId, async client => client.query(
      'SELECT id,code,name,account_type,is_active FROM accounts WHERE school_id=$1 AND is_active=true ORDER BY code',[auth.schoolId],
    ));
    res.json({ accounts:rows.rows });
  } catch(error) { next(error); }
});

const journalSchema = z.object({
  financialYearId: z.string().uuid(),
  periodId: z.string().uuid(),
  postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().min(3).max(500),
  lines: z.array(z.object({
    accountId: z.string().uuid(),
    debit: z.string().default('0'),
    credit: z.string().default('0'),
    memo: z.string().max(500).optional(),
  })).min(2).max(200),
});
app.post('/api/v1/ledger/journals', requireAuth, requirePermission('ledger.post'), async (req,res,next) => {
  try {
    const auth = authContext(req);
    const idempotencyKey = req.header('idempotency-key')?.trim();
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      res.status(400).json({ error: 'An Idempotency-Key header of 8–200 characters is required.' });
      return;
    }
    const parsed = journalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid journal details.', details: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;
    const lines = input.lines.map(line => ({
      accountId: line.accountId,
      debitMinor: parseKesToMinorUnits(line.debit),
      creditMinor: parseKesToMinorUnits(line.credit),
      memo: line.memo,
    }));
    const totals = validateJournal({schoolId:auth.schoolId,currency:'KES',lines});
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const result = await withSchoolTransaction(auth.schoolId, async client => {
      const existing = await client.query(
        'SELECT request_hash,response_status,response_body,resource_id FROM idempotency_records WHERE school_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [auth.schoolId,idempotencyKey],
      );
      if (existing.rowCount) {
        const row = existing.rows[0] as {request_hash:string;response_status:number|null;response_body:unknown;resource_id:string|null};
        if (row.request_hash !== requestHash) return {status:409,body:{error:'Idempotency key was already used with different request content.'}};
        if (row.response_body) return {status:row.response_status ?? 200,body:row.response_body};
        return {status:409,body:{error:'A request with this idempotency key is still being processed. Retry shortly.'}};
      }
      await client.query(
        'INSERT INTO idempotency_records (school_id,idempotency_key,request_hash) VALUES ($1,$2,$3)',
        [auth.schoolId,idempotencyKey,requestHash],
      );
      await client.query('SELECT id FROM financial_years WHERE school_id=$1 AND id=$2 FOR UPDATE',[auth.schoolId,input.financialYearId]);
      const year = await client.query(
        "SELECT id FROM financial_years WHERE school_id=$1 AND id=$2 AND status='open' AND starts_on <= $3::date AND ends_on >= $3::date",
        [auth.schoolId,input.financialYearId,input.postingDate],
      );
      const period = await client.query(
        "SELECT id FROM accounting_periods WHERE school_id=$1 AND id=$2 AND financial_year_id=$3 AND status='open' AND starts_on <= $4::date AND ends_on >= $4::date",
        [auth.schoolId,input.periodId,input.financialYearId,input.postingDate],
      );
      if (!year.rowCount || !period.rowCount) {
        const body={error:'Posting date must fall within an open financial year and its open accounting period.'};
        await client.query('UPDATE idempotency_records SET response_status=422,response_body=$3::jsonb WHERE school_id=$1 AND idempotency_key=$2',[auth.schoolId,idempotencyKey,JSON.stringify(body)]);
        return {status:422,body};
      }
      const accountIds = [...new Set(lines.map(line => line.accountId))];
      const accounts = await client.query(
        'SELECT id FROM accounts WHERE school_id=$1 AND is_active=true AND id=ANY($2::uuid[])',
        [auth.schoolId,accountIds],
      );
      if (accounts.rowCount !== accountIds.length) {
        const body={error:'One or more accounts are missing, inactive, or outside this school.'};
        await client.query('UPDATE idempotency_records SET response_status=422,response_body=$3::jsonb WHERE school_id=$1 AND idempotency_key=$2',[auth.schoolId,idempotencyKey,JSON.stringify(body)]);
        return {status:422,body};
      }
      const numberResult = await client.query(
        'SELECT COALESCE(MAX(entry_number),0)+1 AS next_number FROM journal_entries WHERE school_id=$1 AND financial_year_id=$2',
        [auth.schoolId,input.financialYearId],
      );
      const entryId = randomUUID();
      const entryNumber = String(numberResult.rows[0].next_number);
      await client.query(
        "INSERT INTO journal_entries (id,school_id,financial_year_id,period_id,entry_number,posting_date,description,status,source_type,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft','manual',$8)",
        [entryId,auth.schoolId,input.financialYearId,input.periodId,entryNumber,input.postingDate,input.description,auth.userId],
      );
      for (const [index,line] of lines.entries()) {
        await client.query(
          'INSERT INTO journal_lines (school_id,journal_entry_id,account_id,line_number,debit,credit,memo) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [auth.schoolId,entryId,line.accountId,index+1,minorToDecimal(line.debitMinor),minorToDecimal(line.creditMinor),line.memo ?? null],
        );
      }
      await client.query("UPDATE journal_entries SET status='posted' WHERE id=$1 AND school_id=$2",[entryId,auth.schoolId]);
      const body = {id:entryId,entryNumber,postingDate:input.postingDate,status:'posted',currency:'KES',total:formatMinorUnitsKes(totals.totalMinor),lineCount:totals.lineCount};
      await client.query(
        'UPDATE idempotency_records SET response_status=201,response_body=$3::jsonb,resource_type=$4,resource_id=$5 WHERE school_id=$1 AND idempotency_key=$2',
        [auth.schoolId,idempotencyKey,JSON.stringify(body),'journal_entry',entryId],
      );
      await client.query(
        "INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id,request_id,metadata) VALUES ($1,$2,'ledger.journal.post','journal_entry',$3,$4,$5::jsonb)",
        [auth.schoolId,auth.userId,entryId,idempotencyKey,JSON.stringify({entryNumber,postingDate:input.postingDate,total:formatMinorUnitsKes(totals.totalMinor)})],
      );
      return {status:201,body};
    });
    res.status(result.status).json(result.body);
  } catch(error) { next(error); }
});

app.get('/api/v1/ledger/journals', requireAuth, requirePermission('ledger.read'), async (req,res,next) => {
  try {
    const auth = authContext(req);
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    const to = typeof req.query.to === 'string' ? req.query.to : null;
    const rows = await withSchoolTransaction(auth.schoolId, async client => client.query(
      `SELECT j.id,j.entry_number,j.posting_date,j.description,j.status,j.posted_at,
              COALESCE(sum(l.debit),0)::text AS total_debit,
              COALESCE(sum(l.credit),0)::text AS total_credit
       FROM journal_entries j LEFT JOIN journal_lines l ON l.school_id=j.school_id AND l.journal_entry_id=j.id
       WHERE j.school_id=$1 AND ($2::date IS NULL OR j.posting_date >= $2::date)
         AND ($3::date IS NULL OR j.posting_date <= $3::date)
       GROUP BY j.id ORDER BY j.posting_date DESC,j.entry_number DESC LIMIT 500`,
      [auth.schoolId,from,to],
    ));
    res.json({journals:rows.rows});
  } catch(error) { next(error); }
});

const devJournalSchema = z.object({
  schoolId: z.string().min(1).max(100),
  currency: z.literal('KES'),
  lines: z.array(z.object({accountId:z.string().min(1).max(100),debit:z.string().default('0.00'),credit:z.string().default('0.00'),memo:z.string().max(500).optional()})).min(2).max(500),
});
app.post('/api/v1/dev/validate-journal', (req,res) => {
  if (process.env.NODE_ENV === 'production') { res.status(404).json({error:'Not found'}); return; }
  const parsed = devJournalSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({error:'Invalid request',details:parsed.error.flatten()}); return; }
  try {
    const lines = parsed.data.lines.map(line=>({accountId:line.accountId,debitMinor:parseKesToMinorUnits(line.debit),creditMinor:parseKesToMinorUnits(line.credit),memo:line.memo}));
    const result = validateJournal({schoolId:parsed.data.schoolId,currency:parsed.data.currency,lines});
    res.status(200).json({valid:true,total:formatMinorUnitsKes(result.totalMinor),lineCount:result.lineCount,posted:false});
  } catch(error) { res.status(422).json({valid:false,error:error instanceof Error?error.message:'Journal validation failed',posted:false}); }
});

app.use('/api/v1', operationsRouter);
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve(process.cwd(), 'dist'), { index: false, maxAge: '1h' }));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) { next(); return; }
    res.sendFile(resolve(process.cwd(), 'dist', 'index.html'));
  });
}
app.use((_req,res) => { res.status(404).json({error:'Not found'}); });
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const code = (error as { code?: string })?.code;
  if (code === '23505') { res.status(409).json({error:'A record with these unique details already exists.'}); return; }
  if (code === '23503' || code === '23514' || code === '55000') { res.status(422).json({error:'The financial operation violates an accounting or data-integrity rule.'}); return; }
  if (error instanceof Error && error.name === 'DatabaseUnavailableError') { res.status(503).json({error:'Database is not configured.'}); return; }
  process.stderr.write(`ShuleLedger API error: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  res.status(500).json({error:'Internal server error.'});
});

const port = Number(process.env.PORT ?? 3001);
if (process.env.NODE_ENV !== 'test') app.listen(port, () => process.stdout.write(`ShuleLedger API listening on port ${port}\n`));
export default app;
