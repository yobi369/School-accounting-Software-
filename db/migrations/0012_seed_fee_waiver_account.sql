-- Seed the contra-income ledger account used for approved fee waivers.
INSERT INTO accounts (school_id,code,name,account_type)
SELECT id,'4200','Fee waivers (contra-income)','income' FROM schools
ON CONFLICT (school_id,code) DO NOTHING;
