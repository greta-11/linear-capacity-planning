import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { diffOoo, parseOooCsv } from '../server/ooo/csv';
import { currentOoo, ensureSnapshot } from '../server/service';
import { store } from '../server/store';

// Usage: npm run import:ooo -- ./path/to/ooo.csv [--dry-run]
// Validates the CSV against the people in the current Linear snapshot, prints the
// changes, and replaces the planner's OOO data. Rows with errors are skipped and
// reported; the command exits non-zero only when nothing could be imported.

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run import:ooo -- ./path/to/ooo.csv [--dry-run]');
  console.error('Columns: email,start_date,end_date,type,fraction,note (see samples/ooo-template.csv)');
  process.exit(2);
}
const filePath = path.resolve(file);
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(2);
}

const csv = fs.readFileSync(filePath, 'utf8');
const snapshot = await ensureSnapshot();
if (!snapshot) console.warn('! No Linear snapshot yet, so emails cannot be matched. Run the app and sync first.');
const fileName = path.basename(filePath);
const dataset = parseOooCsv(csv, fileName, snapshot?.people ?? []);
const diff = diffOoo(currentOoo(snapshot), dataset);

const errors = dataset.problems.filter((p) => p.severity === 'error');
const warnings = dataset.problems.filter((p) => p.severity === 'warning');
console.log(`${fileName}: ${dataset.entries.length} rows read (${snapshot ? `matched against ${snapshot.people.length} people from ${snapshot.organizationName}` : 'unmatched'})`);
console.log(`  +${diff.added.length} new, −${diff.removed.length} removed, ${diff.unchanged} unchanged vs the current OOO data`);
for (const p of errors) console.log(`  ✗ ${p.message}`);
for (const p of warnings) console.log(`  ! ${p.message}`);

const unusable = dataset.problems.some((p) => p.row === 0) || (dataset.entries.length === 0 && errors.length > 0);
if (unusable) {
  console.error('\n✗ Nothing imported: fix the file and try again.');
  process.exit(1);
}
if (dryRun) {
  console.log('\nDry run: nothing saved.');
  process.exit(0);
}
store.saveOoo({ fileName, uploadedAt: dataset.uploadedAt, csv });
console.log(`\n✓ Imported. ${errors.length ? `${errors.length} row(s) were skipped — they show up as "Update via CSV" recommendations. ` : ''}Reload the app to see it.`);
