#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version — used by the release
// workflow (.github/workflows/release.yml) to fill in the GitHub release's
// notes automatically, which is also what UpdateDialog shows in the app's
// "update available" prompt (see services/updateCheck.ts).
//
// Usage: node scripts/extract-changelog.mjs 1.1.0
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('Usage: extract-changelog.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const heading = `## [${version}]`;
const lines = changelog.split('\n');

const start = lines.findIndex((line) => line.startsWith(heading));
if (start === -1) {
  console.error(`No CHANGELOG.md entry found for ${heading}`);
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith('## ['));
const section = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();

console.log(section);
