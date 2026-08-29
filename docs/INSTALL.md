# TraverseX installation guide

This guide installs TraverseX on a fresh Ubuntu/Debian PC and makes the Admin
dashboard plus a Firebase-to-MySQL worker available. TraverseX is a Node.js
service; Apache is not required. Apache or Nginx may be added later as a
reverse proxy, but it is outside this repository's required setup.

## Before you start

Prepare the following:

- Ubuntu 22.04/24.04 or a compatible Debian-based Linux PC;
- a Linux account with `sudo` access;
- access to the Git repository;
- a Firebase service-account JSON file and its Firebase project ID;
- a MariaDB/MySQL server for the `traversex` control database; and
- a separate target database where the registered project's projection tables
  will be created.

The control database and target database may be on the same MySQL server, but
they must remain separate databases. The repository excludes `.env`, keys,
runtime logs, and `node_modules`.

## 1. Install system dependencies

```bash
sudo apt update
sudo apt install -y git curl ca-certificates mariadb-server openssl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

Node.js must be version 20 or newer. Confirm that MariaDB is available:

```bash
sudo systemctl enable --now mariadb
sudo mariadb -e 'SELECT VERSION();'
```

Create the restricted service account and local directories:

```bash
sudo useradd --system --home /var/lib/traversex --shell /usr/sbin/nologin traversex 2>/dev/null || true
sudo install -d -o traversex -g traversex -m 0750 /var/lib/traversex
sudo install -d -o root -g traversex -m 0750 /etc/traversex/firebase
```

## 2. Clone the repository and install dependencies

For a public repository:

```bash
sudo mkdir -p /var/www/html
sudo chown "$USER":"$USER" /var/www/html
git clone https://github.com/janzter19/TraverseX.git /var/www/html/traverseX
cd /var/www/html/traverseX
```

For a private repository, authenticate first with GitHub CLI or use an
approved SSH/HTTPS credential method, then clone the same repository. Never
put a GitHub token in `.env` or a service file.

Install the server dependencies:

```bash
npm ci --omit=dev
```

The production Admin bundle is committed under `public/dashboard`. Only when
the React source changes, install UI dependencies and rebuild it:

```bash
npm --prefix ui ci
npm run build
```

## 3. Create the control database

Choose a dedicated password and replace the placeholder before running this
SQL. Do not reuse a Firebase or Linux password.

```bash
sudo mariadb
```

```sql
CREATE DATABASE IF NOT EXISTS `traversex`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'traversex'@'localhost'
  IDENTIFIED BY 'CHANGE_THIS_DB_PASSWORD';
ALTER USER 'traversex'@'localhost'
  IDENTIFIED BY 'CHANGE_THIS_DB_PASSWORD';
GRANT ALL PRIVILEGES ON `traversex`.* TO 'traversex'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

For a fresh database, load the complete current schema once:

```bash
sudo mariadb < database/schema.sql
```

`database/schema.sql` creates the Admin, project, collection, runtime, event,
pending-queue, and schema-audit tables. It intentionally does not create
projection tables in the control database; those are created in the
registered target database from Firebase document fields.

### Existing older TraverseX database

Do not blindly run every migration after loading `database/schema.sql`. First
back up and inspect the current schema. The numbered files in
`database/migrations/` are an upgrade path for older installations:

```bash
sudo mariadb-dump --single-transaction --routines --triggers traversex > /var/backups/traversex-$(date +%F-%H%M%S).sql
sudo mariadb -e 'SHOW TABLES FROM traversex;'
```

Apply only missing migrations, in numeric order, with a backup and a read-back
after each change. Migration `004-schema-healing-audit.sql` does not contain
`USE traversex;`, so invoke it with the database selected:

```bash
sudo mariadb traversex < database/migrations/004-schema-healing-audit.sql
```

## 4. Create the environment file

```bash
cd /var/www/html/traverseX
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
nano .env
```

At minimum, set:

```text
NODE_ENV=production
HTTP_HOST=127.0.0.1
HTTP_PORT=8085
SESSION_SECRET=<the random value from openssl>
DATABASE_HOST=127.0.0.1
DATABASE_PORT=3306
DATABASE_NAME=traversex
DATABASE_USER=traversex
DATABASE_PASSWORD=<the control DB password>
TRAVERSEX_INSTANCE_ID=rbmsv4-local
TRAVERSEX_SOURCE_PROJECT_KEY=*
```

`TRAVERSEX_SOURCE_PROJECT_KEY=*` means the worker accepts every document
`project_key` in the registered Firebase project. Set one exact key instead
when the worker must be restricted to one application project. Firebase ID
and credential path are stored per registered project in Admin; the legacy
`FIREBASE_*` values in `.env.example` are optional compatibility/reference
defaults and are not a substitute for an Admin registry entry.

## 5. Install the Firebase service-account file

Transfer the JSON through an approved private channel. Do not commit or paste
it into GitHub, chat, or a public web directory.

```bash
sudo install -o root -g traversex -m 0640 \
  /home/your-user/Downloads/firebase-service-account.json \
  /etc/traversex/firebase/rbmsv4.json
sudo -u traversex test -r /etc/traversex/firebase/rbmsv4.json
```

The Admin registry's **Credential reference** must exactly match this path.
The service account needs Firestore access to the source Firebase project. Use
one credential file per Firebase project when multiple projects are registered.

## 6. Create the first Admin account

Load `.env`, then provide the bootstrap password only to this process:

```bash
set -a
. ./.env
set +a
export TRAVERSEX_BOOTSTRAP_USERNAME=admin
read -rsp "TraverseX Admin password: " TRAVERSEX_BOOTSTRAP_PASSWORD
printf '\n'
npm run bootstrap-admin
unset TRAVERSEX_BOOTSTRAP_USERNAME TRAVERSEX_BOOTSTRAP_PASSWORD
```

The password must be at least 8 characters. The script creates or resets the
user with `must_change_password=1`. Never save the password in the repository.

## 7. Register the Firebase project and target database

For the included RBMSv4 sample registry:

```bash
set -a
. ./.env
set +a
npm run seed-rbmsv4
```

The seed defaults are `RBMSV4_FIREBASE_PROJECT_ID=rbmsv4-vrp`,
`RBMSV4_CREDENTIAL_REF=/etc/traversex/firebase/rbmsv4.json`, and
`RBMSV4_PROJECT_KEY=rbmsv4-local`. It seeds the control registry and
collections only; it does not create or configure the target MySQL database.

Start the web server temporarily:

```bash
set -a; . ./.env; set +a
npm start
```

Open `http://127.0.0.1:8085/admin/login`, sign in, and edit the registered
project. Enter:

1. Firebase project ID;
2. credential reference, for example `/etc/traversex/firebase/rbmsv4.json`;
3. target MySQL host, port, database, username, and password; and
4. the collection list to monitor.

The target MySQL account must be able to create and evolve projection tables
and read/write projected rows. In practice it needs `SELECT`, `INSERT`,
`UPDATE`, `CREATE`, `ALTER`, `RENAME`, and `DROP` on the target database.
Use the narrowest database scope possible. Stop the temporary server with
`Ctrl+C` after configuration.

## 8. Install and start systemd services

The web service serves the Admin UI and API. The templated worker service runs
one isolated worker instance per project key:

```bash
sudo install -o root -g traversex -m 0640 .env /etc/traversex/web.env
sudo install -o root -g traversex -m 0640 .env /etc/traversex/rbmsv4-local.env
sudo chown -R traversex:traversex /var/www/html/traverseX
sudo install -o root -g root -m 0644 \
  systemd/traversex-web.service /etc/systemd/system/traversex-web.service
sudo install -o root -g root -m 0644 \
  systemd/traversex@.service /etc/systemd/system/traversex@.service
sudo systemctl daemon-reload
sudo systemctl enable --now traversex-web.service
sudo systemctl enable --now traversex@rbmsv4-local.service
```

The instance suffix must match both `TRAVERSEX_INSTANCE_ID` and the active
registry `project_key`. For another project, copy a separate env file and
start `traversex@<project-key>.service`.

The optional Admin **Restart** control requires a narrowly scoped sudoers rule
for the actual web-service Linux account and exact instance. Review and
customize `systemd/traversex-sudoers`; do not grant general `systemctl` sudo.

## 9. Verify the installation

```bash
curl --fail http://127.0.0.1:8085/healthz
systemctl is-active traversex-web.service
systemctl is-active traversex@rbmsv4-local.service
sudo journalctl -u traversex-web.service -n 30 --no-pager
sudo journalctl -u traversex@rbmsv4-local.service -n 50 --no-pager
```

Expected results:

- health returns JSON containing `"ok":true`;
- both services report `active`;
- the worker reports the registered project and active listener count; and
- the worker reports PENDING-only listeners, not a periodic full scan.

Open these routes locally:

- `/admin/login` — sign in;
- `/admin` — project, collection, metrics, and service controls;
- `/portal` — optional MySQL-only runtime summary; and
- `/healthz` — unauthenticated process health check.

For source/build validation:

```bash
npm run check
npm --prefix ui run lint
npm --prefix ui run build
git diff --check
```

Build success is not projection proof. Verify an actual document through the
full lifecycle described in [Architecture](ARCHITECTURE.md), including the
target MySQL row read-back and Firebase `SYNCED` status.

## 10. Updating an existing installation

Back up the control database, then update the named checkout:

```bash
cd /var/www/html/traverseX
git status --short
git pull --ff-only origin main
npm ci --omit=dev
sudo systemctl restart traversex-web.service
sudo systemctl restart traversex@rbmsv4-local.service
```

If the UI source changed, run `npm --prefix ui ci && npm run build` before the
restarts. Review migrations before applying them; do not replace `.env` or
credential files from Git. Use the exact worker instance name for each active
project.

## Troubleshooting

### `registered_project_not_found`

`TRAVERSEX_INSTANCE_ID` does not match an ACTIVE `project_key` in
`traversex_project`. Fix the relevant `/etc/traversex/<instance>.env` file and
restart only that worker.

### `registered_project_mysql_configuration_missing`

The registered project's target host, port, database, username, or password
is incomplete. Configure it in Admin. TraverseX never falls back to the
control database as a projection target.

### `firebase_credentials_missing`

The credential reference is missing, points to the wrong file, or is not
readable by `traversex`:

```bash
sudo ls -l /etc/traversex/firebase/rbmsv4.json
sudo -u traversex test -r /etc/traversex/firebase/rbmsv4.json
```

### `ER_ACCESS_DENIED_ERROR` or `ER_BAD_DB_ERROR`

Check `DATABASE_*` in the service env file and the target MySQL values stored
for the registered project. Do not pass passwords on the command line.

### Admin displays `internal_error`

Check the web journal and browser request status, then verify the control DB
is reachable with the same values used by the service:

```bash
sudo journalctl -u traversex-web.service -n 100 --no-pager
systemctl status traversex-web.service --no-pager
```

### Admin Restart displays `restart_not_permitted`

The application is still usable. The optional button needs the exact scoped
sudoers rule described above; create it for the new PC's real account and
worker instance.

### Dashboard data is empty after logout/restart

Logout clears the browser session only. Restart does not delete the project
registry. If the API cannot read the control DB, the UI can show no projects
and an error badge; inspect the web journal before changing data.
