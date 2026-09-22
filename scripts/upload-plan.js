/**
 * Uploads a workbook that already exists on disk to the Appwrite plans bucket.
 *
 * `plan:upload` re-renders the demo plan; this pushes a file you already have,
 * which is what you want when checking the bucket settings or handing the desk
 * a workbook that was built by hand.
 *
 *   node scripts/upload-plan.js output/awadh-foods-plan.xlsx
 *   node scripts/upload-plan.js <file> --name "Awadh Foods - Feb.xlsx" --public
 *
 * --public grants read to anyone, so the download URL opens in a browser
 * without a key. Use it for a test upload, not for a client's plan.
 */

const fs = require('fs');
const path = require('path');
const { Permission, Role } = require('node-appwrite');
const { uploadPlan, isConfigured, missingConfig } = require('../src/storage/appwrite');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--name');
const isPublic = args.includes('--public');

if (!file) {
  console.error('usage: node scripts/upload-plan.js <file.xlsx> [--name "Client.xlsx"] [--public]');
  process.exit(1);
}

const source = path.resolve(file);
if (!fs.existsSync(source)) {
  console.error(`no such file: ${source}`);
  process.exit(1);
}

if (!isConfigured()) {
  console.error(`Appwrite is not configured. Missing: ${missingConfig().join(', ')}`);
  console.error('Copy .env.example to .env, fill it in, then run with: node --env-file=.env scripts/upload-plan.js ' + file);
  process.exit(1);
}

(async () => {
  const buffer = fs.readFileSync(source);
  const stored = await uploadPlan(buffer, {
    filename: flag('name') || path.basename(source),
    ...(isPublic ? { permissions: [Permission.read(Role.any())] } : {})
  });

  console.log(`uploaded ${path.basename(source)} -> bucket ${stored.bucketId}`);
  console.log(`  file      ${stored.name}`);
  console.log(`  id        ${stored.fileId}`);
  console.log(`  size      ${(stored.size / 1024).toFixed(1)} KB`);
  console.log(`  type      ${stored.mimeType}`);
  console.log(`  read      ${isPublic ? 'anyone (public test upload)' : "the bucket's own permissions"}`);
  console.log(`  download  ${stored.downloadUrl}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
