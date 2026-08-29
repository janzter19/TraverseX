import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.mjs';
import { createProjectPool, pool, query } from './db.mjs';
import { pendingQueueTableSql } from './pending-queue.mjs';
import { getFirebaseDbForProject } from './firebase.mjs';
import { FieldValue } from 'firebase-admin/firestore';
import { encryptSecret, hashPassword, verifyPassword, safeError } from './security.mjs';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(new URL('../public', import.meta.url).pathname));
const sessions = new Map();
const execFileAsync = promisify(execFile);
const pendingQueueReady = query(pendingQueueTableSql);
const html = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - TraverseX</title><link rel="stylesheet" href="/style.css"></head><body><div data-global-loading class="loading-bar" hidden></div>${body}<script src="/app.js"></script></body></html>`;
const page = (title, body) => html(title, `<header><strong>TraverseX</strong><span class="modal-spinner" data-modal-loading hidden>Working…</span></header><main>${body}</main>`);
const json = (res, status, value) => res.status(status).json(value);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const encoded = (value) => encodeURIComponent(String(value ?? ''));
const projectInput = (body, { passwordRequired = true } = {}) => {
  const project = {
    project_key: String(body.project_key ?? '').trim(),
    project_name: String(body.project_name ?? '').trim(),
    firebase_project_id: String(body.firebase_project_id ?? '').trim(),
    credential_ref: String(body.credential_ref ?? '').trim(),
    mysql_host: String(body.mysql_host ?? '').trim(),
    mysql_port: Number(body.mysql_port ?? 0),
    mysql_database: String(body.mysql_database ?? '').trim(),
    mysql_username: String(body.mysql_username ?? '').trim(),
    mysql_password: String(body.mysql_password ?? '')
  };
  const valid = project.project_key && project.project_key.length <= 255
    && project.project_name && project.project_name.length <= 150
    && project.firebase_project_id && project.firebase_project_id.length <= 150
    && project.credential_ref && project.credential_ref.length <= 255
    && project.mysql_host && project.mysql_host.length <= 255
    && Number.isInteger(project.mysql_port) && project.mysql_port >= 1 && project.mysql_port <= 65535
    && project.mysql_database && project.mysql_database.length <= 128
    && project.mysql_username && project.mysql_username.length <= 128
    && (!passwordRequired || project.mysql_password.length > 0);
  if (!valid || project.mysql_password.length > 512) {
    const error = new Error('invalid_project_payload');
    error.code = 'invalid_project_payload';
    throw error;
  }
  return project;
};
const registeredProject = async (projectKey) => {
  const rows = await query('SELECT xId, project_key, firebase_project_id, credential_ref, mysql_host, mysql_port, mysql_database, mysql_username, mysql_password_ciphertext FROM traversex_project WHERE project_key = ? AND project_status = \'ACTIVE\' LIMIT 1', [projectKey]);
  if (!rows[0]) {
    const error = new Error('registered_project_not_found');
    error.code = 'registered_project_not_found';
    throw error;
  }
  return rows[0];
};

const mysqlTestInput = (body) => {
  const target = {
    mysql_host: String(body.mysql_host ?? '').trim(),
    mysql_port: Number(body.mysql_port ?? 0),
    mysql_database: String(body.mysql_database ?? '').trim(),
    mysql_username: String(body.mysql_username ?? '').trim(),
    mysql_password: String(body.mysql_password ?? '')
  };
  const valid = target.mysql_host && target.mysql_host.length <= 255
    && Number.isInteger(target.mysql_port) && target.mysql_port >= 1 && target.mysql_port <= 65535
    && target.mysql_database && target.mysql_database.length <= 128
    && target.mysql_username && target.mysql_username.length <= 128
    && target.mysql_password.length > 0 && target.mysql_password.length <= 512;
  if (!valid) {
    const error = new Error('invalid_mysql_test_payload');
    error.code = 'invalid_mysql_test_payload';
    throw error;
  }
  return target;
};

const safeMysqlTestError = (error) => {
  const code = String(error?.code ?? 'connection_error').replace(/[^A-Z0-9_\-]/gi, '').slice(0, 64) || 'connection_error';
  const descriptions = {
    ECONNREFUSED: 'The MySQL server refused the connection.',
    ETIMEDOUT: 'The MySQL connection timed out.',
    ENOTFOUND: 'The MySQL host could not be found.',
    ER_ACCESS_DENIED_ERROR: 'MySQL rejected the supplied username or password.',
    ER_BAD_DB_ERROR: 'The configured MySQL database was not found.',
    PROTOCOL_CONNECTION_LOST: 'The MySQL connection closed unexpectedly.'
  };
  return { code, description: descriptions[code] ?? 'The MySQL connection test failed.' };
};

app.get('/healthz', (_req, res) => json(res, 200, { ok: true, service: 'TraverseX' }));
app.get('/admin/login', (_req, res) => res.send(page('Admin login', `<section class="card"><h1>TraverseX Admin</h1><p>Configure projects and Firebase collections.</p><form method="post" action="/admin/login" data-async><label>Username<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><p class="error" data-form-error></p><button>Sign in</button></form></section>`)));

app.post('/admin/login', async (req, res) => {
  try {
    const rows = await query('SELECT xId, username, password_hash, user_status FROM traversex_admin_user WHERE username = ? LIMIT 1', [String(req.body.username ?? '')]);
    const user = rows[0];
    if (!user || user.user_status !== 'ACTIVE' || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) return json(res, 401, { ok: false, error: 'invalid_credentials' });
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { xId: user.xId, csrfToken, expires: Date.now() + 8 * 60 * 60 * 1000 });
    res.setHeader('Set-Cookie', `tx_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`); return json(res, 200, { ok: true, redirect: '/admin' });
  } catch (error) { return json(res, 500, { ok: false, error: safeError(error) }); }
});

const auth = (req, res, next) => { const token = (req.headers.cookie ?? '').match(/(?:^|; )tx_session=([^;]+)/)?.[1]; const session = token && sessions.get(token); if (!session || session.expires < Date.now()) return res.redirect('/admin/login'); req.session = session; next(); };
const csrfMatches = (provided, expected) => {
  if (typeof provided !== 'string' || typeof expected !== 'string' || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
};
app.post('/admin/logout', (req, res) => {
  const token = (req.headers.cookie ?? '').match(/(?:^|; )tx_session=([^;]+)/)?.[1];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'tx_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return json(res, 200, { ok: true, redirect: '/admin/login' });
});
const dashboardPath = new URL('../public/dashboard/index.html', import.meta.url).pathname;
app.get('/admin', auth, (_req, res, next) => {
  if (fs.existsSync(dashboardPath)) return res.sendFile(dashboardPath);
  return next();
});
app.get('/admin/api/dashboard', auth, async (req, res) => {
  try {
    await pendingQueueReady;
    const [projects, collections, runtime] = await Promise.all([
      query('SELECT p.xId, p.project_key, p.project_name, p.firebase_project_id, p.credential_ref, p.mysql_host, p.mysql_port, p.mysql_database, p.mysql_username, p.project_status, r.last_restart_at FROM traversex_project p LEFT JOIN traversex_runtime r ON r.project_xId = p.xId ORDER BY p.xId DESC'),
      query(`SELECT c.xId, c.project_xId, p.project_name, c.firebase_collection, c.traverse_status, c.contract_version,
        c.last_event_xId, c.last_event_change_type, c.last_event_document_id, c.last_event_status,
        c.last_event_attempt_count, c.last_event_recorded_at
        FROM traversex_collection c JOIN traversex_project p ON p.xId=c.project_xId
        ORDER BY c.last_event_recorded_at IS NULL, c.last_event_recorded_at DESC, c.xId DESC`),
      query(`SELECT r.project_xId, r.service_status, r.firebase_reads,
        COALESCE(q.pending_queue, 0) AS pending_queue,
        r.processed_count, r.retry_count, r.dead_letter_count,
        r.active_collection_count, r.listener_count, r.last_heartbeat_at,
        r.last_restart_at, r.last_event_at, r.last_error_code, r.last_error_description
        FROM traversex_runtime r
        LEFT JOIN (
          SELECT project_xId, COUNT(*) AS pending_queue
          FROM traversex_pending_queue
          WHERE pending_state = 'PENDING'
          GROUP BY project_xId
        ) q ON q.project_xId = r.project_xId`)
    ]);
    return json(res, 200, { ok: true, projects, collections, runtime, instance_id: config.instanceId, csrf_token: req.session.csrfToken ?? null });
  } catch (error) {
    console.error('dashboard_load_failed', safeError(error));
    return json(res, 500, { ok: false, error: safeError(error) });
  }
});
app.get('/admin/api/pending-queue', auth, async (req, res) => {
  try {
    const projectXId = Number(req.query.project_xId);
    if (!Number.isInteger(projectXId) || projectXId < 1) return json(res, 400, { ok: false, error: 'invalid_project_id' });
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 200);
    await pendingQueueReady;
    const [countRows, rows] = await Promise.all([
      query(`SELECT COUNT(*) AS pending_queue
        FROM traversex_pending_queue
        WHERE project_xId = ? AND pending_state = 'PENDING'`, [projectXId]),
      query(`SELECT xId, project_xId, collection_xId, firebase_collection,
          firebase_document_id, pending_state, attempt_count, error_code,
          error_description, first_seen_at, updated_at
        FROM traversex_pending_queue
        WHERE project_xId = ? AND pending_state = 'PENDING'
        ORDER BY updated_at DESC, xId DESC LIMIT ${limit}`, [projectXId])
    ]);
    return json(res, 200, { ok: true, pending_queue: Number(countRows[0]?.pending_queue ?? 0), rows });
  } catch (error) {
    return json(res, 500, { ok: false, error: safeError(error) });
  }
});
app.get('/admin/api/read-events', auth, async (req, res) => {
  try {
    const projectXId = Number(req.query.project_xId);
    if (!Number.isInteger(projectXId) || projectXId < 1) return json(res, 400, { ok: false, error: 'invalid_project_id' });
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 200);
    const rows = await query(`SELECT e.xId, e.firebase_collection, e.firebase_document_id, e.firebase_change_type,
      e.event_status, e.attempt_count, e.error_code, e.error_description,
      e.firebase_event_at, e.traverse_recorded_at
      FROM traversex_collection_event e
      JOIN traversex_runtime r ON r.project_xId = e.project_xId
      WHERE e.project_xId = ?
        AND (r.last_restart_at IS NULL OR e.traverse_recorded_at >= r.last_restart_at)
      ORDER BY e.traverse_recorded_at DESC, e.xId DESC LIMIT ${limit}`, [projectXId]);
    return json(res, 200, { ok: true, rows });
  } catch (error) {
    return json(res, 500, { ok: false, error: safeError(error) });
  }
});
app.get('/admin/api/collection-logs', auth, async (req, res) => {
  try {
    const collectionXId = Number(req.query.collection_xId);
    if (!Number.isInteger(collectionXId) || collectionXId < 1) return json(res, 400, { ok: false, error: 'invalid_collection_id' });
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 200);
    const rows = await query(`SELECT e.xId, e.firebase_collection, e.firebase_document_id, e.firebase_change_type,
      e.event_status, e.attempt_count, e.error_code, e.error_description,
      e.firebase_event_at, e.traverse_recorded_at
      FROM traversex_collection_event e
      WHERE e.collection_xId = ?
      ORDER BY e.traverse_recorded_at DESC, e.xId DESC LIMIT ${limit}`, [collectionXId]);
    return json(res, 200, { ok: true, logs: rows });
  } catch (error) {
    return json(res, 500, { ok: false, error: safeError(error) });
  }
});
app.post('/admin/api/clear-logs', auth, async (req, res) => {
  if (!csrfMatches(String(req.headers['x-csrf-token'] ?? ''), req.session.csrfToken)) return json(res, 403, { ok: false, error: 'csrf_validation_failed' });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [collections] = await connection.execute(`UPDATE traversex_collection
      SET last_event_xId = NULL,
          last_event_change_type = NULL,
          last_event_document_id = NULL,
          last_event_status = NULL,
          last_event_attempt_count = NULL,
          last_event_recorded_at = NULL`);
    const [events] = await connection.execute('DELETE FROM traversex_collection_event');
    await connection.commit();
    return json(res, 200, {
      ok: true,
      cleared: {
        collection_events: Number(events.affectedRows ?? 0),
        collection_cache_rows: Number(collections.affectedRows ?? 0),
      },
    });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    return json(res, 500, { ok: false, error: safeError(error) });
  } finally {
    connection?.release();
  }
});
app.post('/admin/projects/test-mysql', auth, async (req, res) => {
  let connection;
  try {
    const projectXId = String(req.body.project_xId ?? '').trim();
    let target;
    if (projectXId) {
      const xId = Number(projectXId);
      if (!Number.isInteger(xId) || xId < 1) return json(res, 400, { ok: false, error: 'invalid_project_id' });
      const rows = await query('SELECT mysql_host, mysql_port, mysql_database, mysql_username, mysql_password_ciphertext FROM traversex_project WHERE xId = ? LIMIT 1', [xId]);
      if (!rows[0]) return json(res, 404, { ok: false, error: 'project_not_found' });
      target = {
        mysql_host: String(req.body.mysql_host ?? rows[0].mysql_host ?? '').trim(),
        mysql_port: Number(req.body.mysql_port ?? rows[0].mysql_port ?? 0),
        mysql_database: String(req.body.mysql_database ?? rows[0].mysql_database ?? '').trim(),
        mysql_username: String(req.body.mysql_username ?? rows[0].mysql_username ?? '').trim(),
        mysql_password: String(req.body.mysql_password ?? '')
      };
      if (!target.mysql_password) target.mysql_password = decryptSecret(rows[0].mysql_password_ciphertext);
      target = mysqlTestInput(target);
    } else {
      target = mysqlTestInput(req.body);
    }
    connection = await mysql.createConnection({
      host: target.mysql_host,
      port: target.mysql_port,
      database: target.mysql_database,
      user: target.mysql_username,
      password: target.mysql_password,
      connectTimeout: 5000,
      enableKeepAlive: false
    });
    await connection.query('SELECT 1 AS connection_ok');
    return json(res, 200, { ok: true, message: 'MySQL connection successful.' });
  } catch (error) {
    const safe = safeMysqlTestError(error);
    return json(res, 400, { ok: false, error: safe.code === 'invalid_mysql_test_payload' ? safe.code : 'mysql_connection_failed', detail: safe });
  } finally {
    if (connection) await connection.end().catch(() => {});
  }
});
app.get('/admin', auth, async (_req, res) => {
  try {
    const projects = await query('SELECT xId, project_key, project_name, firebase_project_id, credential_ref, mysql_host, mysql_port, mysql_database, mysql_username, project_status FROM traversex_project ORDER BY xId DESC');
    const collections = await query('SELECT c.xId, c.project_xId, p.project_name, c.firebase_collection, c.traverse_status, c.contract_version FROM traversex_collection c JOIN traversex_project p ON p.xId=c.project_xId ORDER BY c.xId DESC');
    const projectRows = projects.map((project) => `<tr data-project-edit="${project.xId}" data-project-key="${encoded(project.project_key)}" data-project-name="${encoded(project.project_name)}" data-firebase-project-id="${encoded(project.firebase_project_id)}" data-credential-ref="${encoded(project.credential_ref)}" data-mysql-host="${encoded(project.mysql_host ?? '')}" data-mysql-port="${encoded(project.mysql_port ?? 3306)}" data-mysql-database="${encoded(project.mysql_database ?? '')}" data-mysql-username="${encoded(project.mysql_username ?? '')}"><td>${project.xId}</td><td>${escapeHtml(project.project_name)}<br><small>${escapeHtml(project.project_key)}</small></td><td>${escapeHtml(project.firebase_project_id)}</td><td>${escapeHtml(project.project_status)}</td></tr>`).join('');
    const collectionRows = collections.map((collection) => `<tr><td>${collection.xId}</td><td>${escapeHtml(collection.project_name)}</td><td>${escapeHtml(collection.firebase_collection)}</td><td>${escapeHtml(collection.traverse_status)}</td><td><button type="button" class="circle-action collection-edit-action" data-collection-edit="${collection.xId}" data-project-xid="${collection.project_xId}" data-collection-name="${encoded(collection.firebase_collection)}" data-collection-status="${encoded(collection.traverse_status)}" title="Edit collection monitor" aria-label="Edit collection monitor">✎</button></td></tr>`).join('');
    res.send(page('Admin', `<h1>Admin</h1><p>Configure registered Firebase projects and their own MySQL projection databases.</p><div class="grid"><section class="card"><h2>Firebase project</h2><form method="post" action="/admin/projects" data-async><label>Project key<input name="project_key" maxlength="255" required></label><label>Name<input name="project_name" maxlength="150" required></label><label>Firebase project ID<input name="firebase_project_id" maxlength="150" required></label><label>Credential reference<input name="credential_ref" maxlength="255" placeholder="/etc/traversex/firebase/project-a.json" required></label><label>MySQL host<input name="mysql_host" value="127.0.0.1" maxlength="255" required></label><label>MySQL port<input name="mysql_port" type="number" min="1" max="65535" value="3306" required></label><label>MySQL database<input name="mysql_database" maxlength="128" required></label><label>MySQL username<input name="mysql_username" maxlength="128" required></label><label>MySQL password<input name="mysql_password" type="password" autocomplete="new-password" required></label><button>Add project</button><p class="error" data-form-error></p></form></section><section class="card"><h2>Collection monitor</h2><form method="post" action="/admin/collections" data-async><label>Project xId<input name="project_xId" type="number" required></label><label>Firebase collection<input name="firebase_collection" required></label><label>Status<select name="traverse_status"><option>ACTIVE</option><option>INACTIVE</option></select></label><button>Add collection</button><p class="error" data-form-error></p></section><section class="card"><h2>Service control</h2><p>Restart only the isolated TraverseX worker instance.</p><form method="post" action="/admin/restart" data-async><button>Restart TraverseX</button><p class="error" data-form-error></p></form><button type="button" data-open-test>Test Firebase projection</button></section></div><section class="card"><h2>Registered projects</h2><div class="table-scroll"><table><tr><th>xId</th><th>Project</th><th>Firebase</th><th>Status</th></tr>${projectRows || '<tr><td colspan="4">No projects.</td></tr>'}</table></div></section><section class="card"><h2>Collections</h2><div class="table-scroll"><table><tr><th>xId</th><th>Project</th><th>Collection</th><th>Status</th><th>Actions</th></tr>${collectionRows || '<tr><td colspan="5">No collections.</td></tr>'}</table></div></section><dialog class="test-modal" data-test-modal><form method="post" action="/admin/test" data-async data-keep-open><header><strong>Firebase projection test</strong><span class="modal-spinner" data-modal-loading hidden>Working…</span><button type="button" data-close-test aria-label="Close">×</button></header><label>Project key<input name="project_key" value="rbmsv4-local" required></label><label>Test name<input name="test_name" value="TraverseX test" maxlength="150" required></label><label>Message<textarea name="test_message" rows="4">Firebase-first projection test</textarea></label><button type="submit">Send test</button><div class="test-result" data-form-error role="status" aria-live="polite">Submit to create a Firebase project_test document.</div></form></dialog>`));
  } catch (error) {
    res.status(500).send(page('Error', `<section class="card"><h1>Database error</h1><p>${safeError(error)}</p></section>`));
  }
});
app.post('/admin/projects', auth, async (req, res) => {
  try {
    const project = projectInput(req.body);
    await query('INSERT INTO traversex_project (project_key, project_name, firebase_project_id, credential_ref, mysql_host, mysql_port, mysql_database, mysql_username, mysql_password_ciphertext) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [project.project_key, project.project_name, project.firebase_project_id, project.credential_ref, project.mysql_host, project.mysql_port, project.mysql_database, project.mysql_username, encryptSecret(project.mysql_password)]);
    return json(res, 200, { ok: true });
  } catch (error) {
    return json(res, 400, { ok: false, error: safeError(error) });
  }
});
app.post('/admin/projects/:xId', auth, async (req, res) => {
  try {
    const xId = Number(req.params.xId);
    if (!Number.isInteger(xId) || xId < 1) return json(res, 400, { ok: false, error: 'invalid_project_id' });
    const project = projectInput(req.body, { passwordRequired: false });
    const existingRows = await query('SELECT mysql_password_ciphertext FROM traversex_project WHERE xId = ? LIMIT 1', [xId]);
    const existing = existingRows[0];
    if (!existing) return json(res, 404, { ok: false, error: 'project_not_found' });
    const ciphertext = project.mysql_password ? encryptSecret(project.mysql_password) : existing.mysql_password_ciphertext;
    if (!ciphertext) return json(res, 400, { ok: false, error: 'mysql_password_required' });
    await query('UPDATE traversex_project SET project_key = ?, project_name = ?, firebase_project_id = ?, credential_ref = ?, mysql_host = ?, mysql_port = ?, mysql_database = ?, mysql_username = ?, mysql_password_ciphertext = ? WHERE xId = ?', [project.project_key, project.project_name, project.firebase_project_id, project.credential_ref, project.mysql_host, project.mysql_port, project.mysql_database, project.mysql_username, ciphertext, xId]);
    return json(res, 200, { ok: true });
  } catch (error) {
    return json(res, 400, { ok: false, error: safeError(error) });
  }
});
app.post('/admin/collections', auth, async (req,res)=>{ try { await query('INSERT INTO traversex_collection (project_xId,firebase_collection,traverse_status) VALUES (?,?,?)',[req.body.project_xId,req.body.firebase_collection,req.body.traverse_status]); return json(res,200,{ok:true}); } catch(e){ return json(res,400,{ok:false,error:safeError(e)}); } });
app.post('/admin/collections/:xId', auth, async (req,res)=>{ try { const xId = Number(req.params.xId); if (!Number.isInteger(xId) || xId < 1) return json(res,400,{ok:false,error:'invalid_collection_id'}); const project_xId = Number(req.body.project_xId); if (!Number.isInteger(project_xId) || project_xId < 1) return json(res,400,{ok:false,error:'invalid_project_id'}); const collection = String(req.body.firebase_collection ?? '').trim(); const status = String(req.body.traverse_status ?? ''); if (!collection || collection.length > 150 || !['ACTIVE','INACTIVE'].includes(status)) return json(res,400,{ok:false,error:'invalid_collection_payload'}); await query('UPDATE traversex_collection SET project_xId = ?, firebase_collection = ?, traverse_status = ? WHERE xId = ?',[project_xId,collection,status,xId]); return json(res,200,{ok:true}); } catch(e){ return json(res,400,{ok:false,error:safeError(e)}); } });
app.post('/admin/test', auth, async (req, res) => {
  try {
    const projectKey = String(req.body.project_key ?? config.instanceId).trim();
    const project = await registeredProject(projectKey);
    const db = getFirebaseDbForProject(project);
    const ref = db.collection('project_test').doc();
    const now = FieldValue.serverTimestamp();
    await ref.set({
      test_key: ref.id,
      project_key: project.project_key,
      test_name: String(req.body.test_name ?? 'TraverseX Firebase test').slice(0, 150),
      test_message: String(req.body.test_message ?? 'Firebase-first projection test'),
      test_status: 'ACTIVE',
      firebase_created_at: now,
      firebase_updated_at: now,
      firebase_deleted_at: null,
      mysql_sync_status: 'PENDING',
      mysql_created_at: null,
      mysql_updated_at: null,
      mysql_deleted_at: null,
      mysql_synced_at: null
    });
    const saved = await ref.get();
    if (!saved.exists || saved.id !== ref.id || saved.data().mysql_sync_status !== 'PENDING') {
      return json(res, 502, { ok: false, error: 'firebase_readback_mismatch' });
    }
    return json(res, 200, { ok: true, firebase: { acknowledged: true, collection: 'project_test', document_id: ref.id, sync_status: 'PENDING' }, traverse: { table: 'project_test', projection: 'awaiting_pending_listener' } });
  } catch (error) {
    return json(res, 503, { ok: false, error: error.code ?? 'firebase_test_failed' });
  }
});
const deleteProjectTestCollection = async (db) => {
  const references = await db.collection('project_test').listDocuments();
  for (let offset = 0; offset < references.length; offset += 400) {
    const batch = db.batch();
    references.slice(offset, offset + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  return references.length;
};
app.post('/admin/test-reset', auth, async (req, res) => {
  try {
    const projectKey = String(req.body.project_key ?? config.instanceId).trim();
    const project = await registeredProject(projectKey);
    const db = getFirebaseDbForProject(project);
    const deletedFirebaseDocuments = await deleteProjectTestCollection(db);
    const projectPool = createProjectPool(project);
    try {
      await projectPool.query('DROP TABLE IF EXISTS project_test');
    } finally {
      await projectPool.end();
    }
    const ref = db.collection('project_test').doc();
    const now = FieldValue.serverTimestamp();
    await ref.set({
      test_key: ref.id,
      project_key: project.project_key,
      test_name: String(req.body.test_name ?? 'TraverseX reset test').slice(0, 150),
      test_message: String(req.body.test_message ?? 'Fresh Firebase-first reset test'),
      test_status: 'ACTIVE',
      firebase_created_at: now,
      firebase_updated_at: now,
      firebase_deleted_at: null,
      mysql_sync_status: 'PENDING',
      mysql_created_at: null,
      mysql_updated_at: null,
      mysql_deleted_at: null,
      mysql_synced_at: null
    });
    const saved = await ref.get();
    if (!saved.exists || saved.id !== ref.id || saved.data().mysql_sync_status !== 'PENDING') {
      return json(res, 502, { ok: false, error: 'firebase_reset_readback_mismatch' });
    }
    return json(res, 200, { ok: true, reset: { firebase_collection: 'project_test', deleted_firebase_documents: deletedFirebaseDocuments, mysql_table_dropped: true }, firebase: { acknowledged: true, collection: 'project_test', document_id: ref.id, sync_status: 'PENDING' }, traverse: { table: 'project_test', projection: 'awaiting_pending_listener' } });
  } catch (error) {
    return json(res, 503, { ok: false, error: error.code ?? 'firebase_test_reset_failed' });
  }
});
app.post('/admin/restart', auth, async (_req, res) => {
  try {
    const unit = `traversex@${config.instanceId}.service`;
    if (!config.firebase.credentialsFile || !fs.existsSync(config.firebase.credentialsFile)) {
      return json(res, 503, { ok: false, error: 'firebase_credentials_missing' });
    }
    await execFileAsync('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'restart', unit]);
    await execFileAsync('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'is-active', '--quiet', unit]);
    return json(res, 200, { ok: true });
  } catch (error) {
    const code = error.code === 'ENOENT'
      ? 'restart_not_installed'
      : error.code === 'EACCES'
        ? 'restart_not_permitted'
        : error.status
          ? 'worker_start_failed'
          : 'restart_failed';
    return json(res, 503, { ok: false, error: code });
  }
});

app.get('/portal', async (_req, res) => { try { const rows = await query(`SELECT p.project_name, r.service_status, r.firebase_reads, r.pending_queue, r.processed_count, r.retry_count, r.dead_letter_count, r.last_heartbeat_at, r.last_error_code, r.last_error_description FROM traversex_project p LEFT JOIN traversex_runtime r ON r.project_xId=p.xId WHERE p.project_status='ACTIVE' ORDER BY p.project_name`); res.send(page('Portal analytics', `<h1>TraverseX Portal</h1><p>Analytics are served from MySQL runtime reports; opening this page performs zero Firebase reads.</p><div class="grid">${rows.map(r=>`<section class="card"><h2>${r.project_name}</h2><p>Status: <strong>${r.service_status ?? 'NOT_READY'}</strong></p><p>Firebase reads: ${r.firebase_reads ?? 0}<br>Pending: ${r.pending_queue ?? 0}<br>Processed: ${r.processed_count ?? 0}<br>Retries / dead letter: ${r.retry_count ?? 0} / ${r.dead_letter_count ?? 0}</p><p>Last heartbeat: ${r.last_heartbeat_at ?? '—'}<br>Last error: ${r.last_error_code ?? '—'}</p></section>`).join('') || '<section class="card"><p>No active projects.</p></section>'}</div>`)); } catch(e){ res.status(500).send(page('Error', `<section class="card"><h1>Database error</h1><p>${safeError(e)}</p></section>`)); } });

app.use((_req, res) => res.status(404).sendFile('404.html', { root: new URL('../public', import.meta.url).pathname }));

app.listen(config.port, config.host, () => console.log(`TraverseX listening on ${config.host}:${config.port}`));
