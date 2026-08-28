import { pool, query } from '../src/db.mjs'

// Safe sample metadata only. The service-account file is provisioned separately.
const firebaseProjectId = process.env.RBMSV4_FIREBASE_PROJECT_ID || 'rbmsv4-vrp'
const credentialRef = process.env.RBMSV4_CREDENTIAL_REF || '/etc/traversex/firebase/rbmsv4.json'
const projectKey = process.env.RBMSV4_PROJECT_KEY || 'rbmsv4-local'

const collections = [
  'project_bed', 'project_bed_analytics', 'project_bed_floor', 'project_bed_source',
  'project_bed_task', 'project_bed_task_log', 'project_bed_treatment',
  'project_building_floor', 'project_group', 'project_messenger_chat',
  'project_messenger_chat_attachment', 'project_messenger_chat_reaction',
  'project_position', 'project_task', 'project_task_stage', 'project_task_stage_response',
  'project_user', 'project_user_group', 'project_user_login_history',
]

await query(
  `INSERT INTO traversex_project
    (project_key, project_name, firebase_project_id, credential_ref, project_status)
   VALUES (?, ?, ?, ?, 'ACTIVE')
   ON DUPLICATE KEY UPDATE project_name = VALUES(project_name),
    firebase_project_id = VALUES(firebase_project_id), credential_ref = VALUES(credential_ref),
    project_status = 'ACTIVE'`,
  [projectKey, 'RBMSv4 Local', firebaseProjectId, credentialRef],
)
const rows = await query('SELECT xId FROM traversex_project WHERE project_key = ? LIMIT 1', [projectKey])
if (!rows[0]) throw new Error('rbmsv4_sample_project_not_found')
const projectId = rows[0].xId

for (const collection of collections) {
  await query(
    `INSERT INTO traversex_collection
      (project_xId, firebase_collection, traverse_status, contract_version)
     VALUES (?, ?, 'ACTIVE', 'rbmsv4-sample-v1')
     ON DUPLICATE KEY UPDATE traverse_status = 'ACTIVE', contract_version = 'rbmsv4-sample-v1'`,
    [projectId, collection],
  )
}
await query(
  `INSERT INTO traversex_runtime (project_xId, service_status) VALUES (?, 'NOT_READY')
   ON DUPLICATE KEY UPDATE service_status = IF(service_status = 'ERROR', 'NOT_READY', service_status)`,
  [projectId],
)
console.log(JSON.stringify({ ok: true, projectKey, firebaseProjectId, collections: collections.length }))
await pool.end()
