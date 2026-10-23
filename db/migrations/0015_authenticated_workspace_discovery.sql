-- Allow an authenticated user to discover only schools they actively belong to.
-- app.user_id is set only by the authenticated API inside a transaction.
DROP POLICY memberships_tenant_isolation ON school_memberships;
CREATE POLICY memberships_tenant_isolation ON school_memberships
  USING (school_id=shuleledger_current_school_id()
    OR user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (school_id=shuleledger_current_school_id());

CREATE POLICY schools_user_membership_read ON schools FOR SELECT
  USING (id=shuleledger_current_school_id() OR EXISTS (
    SELECT 1 FROM school_memberships m
    WHERE m.school_id=schools.id
      AND m.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
      AND m.status='active'
  ));

CREATE POLICY roles_user_membership_read ON roles FOR SELECT
  USING (school_id=shuleledger_current_school_id() OR EXISTS (
    SELECT 1 FROM school_memberships m
    WHERE m.school_id=roles.school_id AND m.role_id=roles.id
      AND m.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
      AND m.status='active'
  ));
