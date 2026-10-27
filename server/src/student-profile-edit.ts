import { Router, type Request, type Response, type NextFunction } from 'express';
import { authContext, requireAuth, requirePermission } from './auth.js';
import { withSchoolTransaction } from './db.js';
import { studentSchema } from './operations.js';

export const studentProfileEditRouter = Router();
studentProfileEditRouter.use(requireAuth);
function wrap(handler:(req:Request,res:Response,next:NextFunction)=>Promise<void>){
  return (req:Request,res:Response,next:NextFunction)=>{void handler(req,res,next).catch(next);};
}
studentProfileEditRouter.patch('/students/:studentId',requirePermission('students.manage'),wrap(async(req,res)=>{
  const studentId=String(req.params.studentId);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(studentId)){res.status(400).json({error:'Invalid student ID.'});return;}
  const parsed=studentSchema.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:'Invalid student details.',details:parsed.error.flatten()});return;}
  const auth=authContext(req);const d=parsed.data;
  const updated=await withSchoolTransaction(auth.schoolId,async c=>{
    const result=await c.query(
      'UPDATE students SET admission_number=$3,full_name=$4,class_name=$5,sex=$6,date_of_birth=$7::date,guardian_name=$8,guardian_relationship=$9,guardian_phone=$10,guardian_alternate_phone=$11,home_address=$12,emergency_contact_name=$13,emergency_contact_phone=$14 WHERE school_id=$1 AND id=$2 RETURNING id,admission_number,full_name,class_name,sex,date_of_birth,guardian_name,guardian_relationship,guardian_phone,guardian_alternate_phone,home_address,emergency_contact_name,emergency_contact_phone,status,created_at',
      [auth.schoolId,studentId,d.admissionNumber,d.fullName,d.className||null,d.sex||null,d.dateOfBirth||null,d.guardianName||null,d.guardianRelationship||null,d.guardianPhone||null,d.guardianAlternatePhone||null,d.homeAddress||null,d.emergencyContactName||null,d.emergencyContactPhone||null]);
    if(!result.rowCount)return null;
    await c.query(
      'INSERT INTO audit_events (school_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [auth.schoolId,auth.userId,'student.update','student',studentId,JSON.stringify({fields:Object.keys(d)})]);
    return result.rows[0];
  });
  if(!updated){res.status(404).json({error:'Student not found in this school.'});return;}
  res.json({student:updated});
}));
