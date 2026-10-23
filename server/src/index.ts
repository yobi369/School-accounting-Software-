import express from 'express';
import { z } from 'zod';
import { formatMinorUnitsKes, parseKesToMinorUnits, validateJournal } from './domain/ledger.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'shuleledger-api', mode: 'foundation-only' });
});

app.get('/api/v1/status', (_req, res) => {
  res.status(200).json({
    name: 'ShuleLedger API',
    readiness: 'development-foundation',
    productionReady: false,
    enabled: ['health-check', 'journal-domain-validation'],
    notYetEnabled: ['authentication', 'database-persistence', 'school-tenancy', 'financial-posting', 'fees', 'expenses', 'offline-sync'],
  });
});

const journalSchema = z.object({
  schoolId: z.string().min(1).max(100),
  currency: z.literal('KES'),
  lines: z.array(z.object({
    accountId: z.string().min(1).max(100),
    debit: z.string().default('0.00'),
    credit: z.string().default('0.00'),
    memo: z.string().max(500).optional(),
  })).min(2).max(500),
});

app.post('/api/v1/dev/validate-journal', (req, res) => {
  // Development-only validator: does not persist or post entries.
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const parsed = journalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  try {
    const lines = parsed.data.lines.map(line => ({
      accountId: line.accountId,
      debitMinor: parseKesToMinorUnits(line.debit),
      creditMinor: parseKesToMinorUnits(line.credit),
      memo: line.memo,
    }));
    const result = validateJournal({ schoolId: parsed.data.schoolId, currency: parsed.data.currency, lines });
    res.status(200).json({ valid: true, total: formatMinorUnitsKes(result.totalMinor), lineCount: result.lineCount, posted: false });
  } catch (error) {
    res.status(422).json({ valid: false, error: error instanceof Error ? error.message : 'Journal validation failed', posted: false });
  }
});

const port = Number(process.env.PORT ?? 3001);
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    process.stdout.write(`ShuleLedger foundation API listening on port ${port}\n`);
  });
}
export default app;