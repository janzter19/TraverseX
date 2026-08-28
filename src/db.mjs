import mysql from 'mysql2/promise';
import { config } from './config.mjs';
import { decryptSecret } from './security.mjs';
export const pool = mysql.createPool({ ...config.db, waitForConnections: true, connectionLimit: 8, decimalNumbers: true });
export async function query(sql, params = []) { const [rows] = await pool.execute(sql, params); return rows; }
export function createProjectPool(project) {
  if (!project?.mysql_host || !project?.mysql_port || !project?.mysql_database || !project?.mysql_username || !project?.mysql_password_ciphertext) {
    const error = new Error('registered_project_mysql_configuration_missing');
    error.code = 'registered_project_mysql_configuration_missing';
    throw error;
  }
  return mysql.createPool({
    host: project.mysql_host,
    port: Number(project.mysql_port),
    database: project.mysql_database,
    user: project.mysql_username,
    password: decryptSecret(project.mysql_password_ciphertext),
    waitForConnections: true,
    connectionLimit: 8,
    decimalNumbers: true
  });
}
