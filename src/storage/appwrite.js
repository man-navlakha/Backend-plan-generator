/**
 * Appwrite Storage: where a generated plan goes once it exists.
 *
 * The workbook is uploaded from memory, never from disk. On Vercel the
 * filesystem is read-only, and a plan that only exists in `output/` is a plan
 * nobody else can open.
 *
 * Configuration is read at call time, not at require time, so the module can be
 * imported in a process that has no Appwrite credentials — `isConfigured()`
 * tells a caller whether an upload is possible before it builds one.
 *
 *   APPWRITE_ENDPOINT           https://<region>.cloud.appwrite.io/v1
 *   APPWRITE_PROJECT_ID         project the bucket lives in
 *   APPWRITE_API_KEY            server key with storage.write on that bucket
 *   APPWRITE_PLANS_BUCKET_ID    bucket the plan workbooks land in
 */

const { Client, Storage, ID } = require('node-appwrite');
const { InputFile } = require('node-appwrite/file');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const REQUIRED = {
  endpoint: 'APPWRITE_ENDPOINT',
  projectId: 'APPWRITE_PROJECT_ID',
  apiKey: 'APPWRITE_API_KEY',
  bucketId: 'APPWRITE_PLANS_BUCKET_ID'
};

let cached = null;

function config() {
  return {
    endpoint: process.env.APPWRITE_ENDPOINT,
    projectId: process.env.APPWRITE_PROJECT_ID,
    apiKey: process.env.APPWRITE_API_KEY,
    bucketId: process.env.APPWRITE_PLANS_BUCKET_ID
  };
}

/** Environment variables that are missing, in the order they are documented. */
function missingConfig() {
  const current = config();
  return Object.entries(REQUIRED)
    .filter(([key]) => !current[key])
    .map(([, envName]) => envName);
}

function isConfigured() {
  return missingConfig().length === 0;
}

/**
 * The Storage client, built once and rebuilt if the environment changes under
 * it (a key rotation in a long-running process, a test swapping credentials).
 */
function storage() {
  const current = config();
  const missing = missingConfig();
  if (missing.length) {
    throw new Error(`Appwrite storage is not configured. Missing: ${missing.join(', ')}`);
  }

  const signature = `${current.endpoint}|${current.projectId}|${current.apiKey}`;
  if (!cached || cached.signature !== signature) {
    const client = new Client()
      .setEndpoint(current.endpoint)
      .setProject(current.projectId)
      .setKey(current.apiKey);
    cached = { signature, storage: new Storage(client) };
  }
  return { storage: cached.storage, ...current };
}

/**
 * A filename the desk can recognise in the bucket listing:
 * `DEAL-1042-awadh-foods-20260922-1431.xlsx`.
 */
function planFileName(plan = {}, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 12).replace(/^(\d{8})(\d{4})$/, '$1-$2');
  const parts = [plan.deal_id, plan.client_name]
    .filter(Boolean)
    .map((part) => String(part).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean);
  const base = [...(parts.length ? parts : ['plan']), stamp].join('-').slice(0, 96);
  return `${base}.xlsx`;
}

/**
 * Uploads a rendered plan workbook.
 *
 * `permissions` is passed straight through to Appwrite. Left out, the file
 * takes the bucket's own permissions, which is what you want for a bucket the
 * desk reads through the console or an authenticated app.
 *
 * Returns the stored file plus the two URLs. Those URLs answer only to a role
 * the file grants read to — a private bucket needs the API key, a session or a
 * file token, so do not paste them into an email and expect them to open.
 */
async function uploadPlan(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new TypeError('uploadPlan expects the workbook as a Buffer');
  }

  const { storage: service, bucketId, endpoint, projectId } = storage();
  const name = options.filename || planFileName(options.plan);
  const fileId = options.fileId || ID.unique();

  let file;
  try {
    file = await service.createFile({
      bucketId,
      fileId,
      file: InputFile.fromBuffer(buffer, name),
      ...(options.permissions ? { permissions: options.permissions } : {}),
      ...(options.folder ? { folder: options.folder } : {})
    });
  } catch (error) {
    // AppwriteException carries the useful part in `type` and `code`; the bare
    // message alone ("Storage bucket with the requested ID could not be found")
    // loses which bucket and which project were asked for.
    const detail = [error.type, error.code].filter(Boolean).join(' ');
    throw new Error(
      `Appwrite upload failed for bucket "${bucketId}"${detail ? ` (${detail})` : ''}: ${error.message}`,
      { cause: error }
    );
  }

  const base = `${endpoint.replace(/\/$/, '')}/storage/buckets/${bucketId}/files/${file.$id}`;
  return {
    fileId: file.$id,
    bucketId,
    name: file.name,
    size: file.sizeOriginal,
    mimeType: file.mimeType || XLSX_MIME,
    uploadedAt: file.$createdAt,
    downloadUrl: `${base}/download?project=${projectId}`,
    viewUrl: `${base}/view?project=${projectId}`
  };
}

/**
 * Fetches a stored plan back as bytes.
 *
 * The `/download` URL Appwrite returns answers only to a role the file grants
 * read to. This bucket does not grant read to anyone, which is the right
 * default for client quotations -- so the API serves the file itself, through
 * the server key, and hands out a URL of its own. The workbook never becomes
 * readable to whoever guesses a file id.
 *
 * The REST endpoint is called directly rather than through the SDK because the
 * SDK's return type for binary payloads differs across versions, and a
 * quotation arriving as a mangled string is a failure that only shows up when
 * someone opens it.
 */
async function downloadPlan(fileId) {
  const { bucketId, endpoint, projectId, apiKey } = storage();
  const url = `${endpoint.replace(/\/$/, '')}/storage/buckets/${bucketId}/files/${fileId}/download`;

  const response = await fetch(url, {
    headers: {
      'X-Appwrite-Project': projectId,
      'X-Appwrite-Key': apiKey,
      'X-Appwrite-Response-Format': '1.4.0'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Appwrite download failed for file "${fileId}" (HTTP ${response.status}): ${body.slice(0, 200)}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Bucket reachability, for the readiness probe: proves the endpoint answers,
 * the key is accepted and the bucket exists, without writing anything.
 */
async function ping() {
  const { storage: service, bucketId } = storage();
  const bucket = await service.getBucket({ bucketId });
  return { bucketId: bucket.$id, name: bucket.name, fileSecurity: bucket.fileSecurity };
}

module.exports = { uploadPlan, downloadPlan, planFileName, isConfigured, missingConfig, ping, XLSX_MIME };
