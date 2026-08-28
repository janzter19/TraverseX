import 'node:process';

const required = ['SESSION_SECRET', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HTTP_HOST ?? '127.0.0.1',
  port: Number(process.env.HTTP_PORT ?? 8085),
  sessionSecret: process.env.SESSION_SECRET,
  db: {
    host: process.env.DATABASE_HOST ?? '127.0.0.1',
    port: Number(process.env.DATABASE_PORT ?? 3306),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? '',
    credentialsFile: process.env.FIREBASE_CREDENTIALS_FILE ?? ''
  },
  instanceId: process.env.TRAVERSEX_INSTANCE_ID ?? 'project-a'
});
