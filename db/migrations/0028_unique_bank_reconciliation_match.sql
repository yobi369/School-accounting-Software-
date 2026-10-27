-- A posted ledger line may reconcile to at most one statement line per school.
-- Keep unmatched rows unconstrained while enforcing one-to-one ledger matching.
CREATE UNIQUE INDEX bank_statement_single_ledger_match_idx
  ON bank_statement_lines (school_id, matched_journal_line_id)
  WHERE matched_journal_line_id IS NOT NULL;
