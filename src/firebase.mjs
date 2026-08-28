import fs from 'node:fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.mjs';

let firestore;
const projectFirestores = new Map();

export function getFirebaseDb() {
  if (firestore) return firestore;
  if (!config.firebase.projectId || !config.firebase.credentialsFile) {
    const error = new Error('Firebase project and credential reference are required');
    error.code = 'firebase_credentials_missing';
    throw error;
  }
  if (!fs.existsSync(config.firebase.credentialsFile)) {
    const error = new Error('Firebase credential file is not readable');
    error.code = 'firebase_credentials_missing';
    throw error;
  }
  const app = getApps()[0] ?? initializeApp({
    credential: cert(JSON.parse(fs.readFileSync(config.firebase.credentialsFile, 'utf8'))),
    projectId: config.firebase.projectId
  });
  firestore = getFirestore(app);
  return firestore;
}

export function getFirebaseDbForProject(project) {
  const cacheKey = String(project?.xId ?? '');
  if (!cacheKey) return getFirebaseDb();
  if (projectFirestores.has(cacheKey)) return projectFirestores.get(cacheKey);
  if (!project.firebase_project_id || !project.credential_ref || !fs.existsSync(project.credential_ref)) {
    const error = new Error('registered_project_firebase_configuration_missing');
    error.code = 'registered_project_firebase_configuration_missing';
    throw error;
  }
  const app = getApps().find((candidate) => candidate.name === `traversex-${cacheKey}`) ?? initializeApp({
    credential: cert(JSON.parse(fs.readFileSync(project.credential_ref, 'utf8'))),
    projectId: project.firebase_project_id
  }, `traversex-${cacheKey}`);
  const projectFirestore = getFirestore(app);
  projectFirestores.set(cacheKey, projectFirestore);
  return projectFirestore;
}
