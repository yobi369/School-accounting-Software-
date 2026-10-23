import { readFile } from 'node:fs/promises';

const file = process.argv[2] ?? 'THIRD_PARTY_LICENSES.json';
const inventory = JSON.parse(await readFile(file, 'utf8'));
const entries = Object.entries(inventory).filter(([name]) => !name.startsWith('shuleledger@'));
if (entries.length === 0) {
  console.error('License inventory is empty; refusing to pass.');
  process.exit(1);
}

const problems = [];
const manualReview = [];
const licenseCounts = new Map();
for (const [name, metadata] of entries) {
  const license = metadata.licenses;
  if (!license || /^(unknown|unlicensed|undefined|n\/a)$/i.test(String(license).trim())) {
    problems.push({ name, license: license ?? '(missing)' });
    continue;
  }
  licenseCounts.set(license, (licenseCounts.get(license) ?? 0) + 1);
  if (/SEE LICENSE IN|SEE LICENSE FILE|CUSTOM|UNLICENSED/i.test(String(license))) {
    manualReview.push({ name, license });
  }
}

console.log('Resolved dependency packages:', entries.length);
console.log('License labels:', [...licenseCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([license, count]) => `${license}: ${count}`).join(' | '));
console.log('Packages requiring manual license-file review:', manualReview.length);
for (const item of manualReview) console.log(`REVIEW: ${item.name} | ${item.license}`);
if (problems.length) {
  for (const item of problems) console.error(`MISSING/UNKNOWN LICENSE: ${item.name} | ${item.license}`);
  process.exit(1);
}
console.log('Metadata check passed. This is not a compatibility determination; consult docs/THIRD_PARTY_LICENSE_REVIEW.md before release.');
