// Guardian gate #1. Runs before every build and on every pull request.
// If any spec file is malformed, the build fails and nothing ships.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = new URL('..', import.meta.url).pathname;
const schema = JSON.parse(readFileSync(join(ROOT, 'schema/spec.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') ? [p] : [];
  });
}

const files = walk(join(ROOT, 'data/specs'));
const errors = [];
const ids = new Map();
const routes = new Map();

for (const file of files) {
  const rel = relative(ROOT, file);
  let spec;
  try {
    spec = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${rel}: not valid JSON (${e.message})`);
    continue;
  }
  if (!validate(spec)) {
    for (const err of validate.errors) errors.push(`${rel}: ${err.instancePath || '(root)'} ${err.message}`);
    continue;
  }
  const folder = relative(join(ROOT, 'data/specs'), file).split(sep)[0];
  if (folder !== spec.platform.slug) errors.push(`${rel}: lives in "${folder}/" but platform.slug is "${spec.platform.slug}"`);
  if (spec.id !== `${spec.platform.slug}-${spec.slug}`) errors.push(`${rel}: id must be "${spec.platform.slug}-${spec.slug}"`);
  if (ids.has(spec.id)) errors.push(`${rel}: duplicate id, also in ${ids.get(spec.id)}`);
  ids.set(spec.id, rel);
  const route = `${spec.platform.slug}/${spec.slug}`;
  if (routes.has(route)) errors.push(`${rel}: duplicate page URL /${route}/`);
  routes.set(route, rel);
  const v = spec.video;
  if (v && v.min_duration_s != null && v.max_duration_s != null && v.min_duration_s > v.max_duration_s)
    errors.push(`${rel}: video.min_duration_s is greater than max_duration_s`);
}

if (errors.length) {
  console.error(`\n✖ ${errors.length} problem(s) in spec data:\n`);
  for (const e of errors) console.error('  - ' + e);
  console.error('');
  process.exit(1);
}
console.log(`✔ ${files.length} spec file(s) valid.`);
