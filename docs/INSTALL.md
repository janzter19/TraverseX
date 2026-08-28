# TraverseX installation guide

This guide installs TraverseX on a fresh Ubuntu/Debian PC and starts the Admin
page plus one Firebase-to-MySQL worker. The commands assume:

- Ubuntu 22.04/24.04 or another Debian-based Linux PC;
- an account with `sudo` access;
- a private GitHub login for `janzter19/TraverseX`;
- a Firebase project and its service-account JSON file;
- a MySQL/MariaDB server for the TraverseX control database; and
- a separate MySQL database that will receive the registered project's
  projection.

The repository intentionally does **not** contain passwords, `.env`, Firebase
service-account keys, `node_modules`, or runtime data. Those are created or
provisioned locally by the steps below.

## 1. Install operating-system dependencies

Run this on the new PC:

```bash
sudo apt update
sudo apt install -y git gh curl ca-certificates mariadb-server openssl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

The Node.js version must be 20 or newer. If `node --version` prints an older
version, stop and install a newer Node.js version before continuing.

Create the restricted operating-system account and required directories:

```bash
sudo useradd --system --home /var/lib/traversex --shell /usr/sbin/nologin traversex 2>/dev/null || true
sudo install -d -o traversex -g traversex -m 0750 /var/lib/traversex
sudo install -d -o root -g traversex -m 0750 /etc/traversex/firebase
```

## 2. Clone the new repository

Authenticate to GitHub using GitHub CLI:

```bash
gh auth login
sudo mkdir -p /var/www/html/traverseX
sudo chown "$USER":"$USER" /var/www/html/traverseX
gh repo clone janzter19/TraverseX /var/www/html/traverseX
cd /var/www/html/traverseX
```

If the directory already contains this repository, do not clone over it. Run:

```bash
cd /var/www/html/traverseX
git pull --ff-only origin main
```

Install the production Node.js dependencies:

```bash
npm ci --omit=dev
```

The built Admin assets are already committed under `public/dashboard`. Only
run the UI build when you intentionally change the React source:

```bash
npm --prefix ui ci
npm run build
```

## 3. Create the TraverseX control database

Choose a new password for the dedicated database account. It must not be the
Linux password or a Firebase password. Open the MariaDB administrator prompt:

```bash
sudo mariadb
```

Paste the following SQL, replacing `CHANGE_THIS_DB_PASSWORD` before pressing
Enter:

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

Load the TraverseX schema:

```bash
sudo mariadb < database/schema.sql
```

## 4. Create the local environment file

Copy the safe template and edit it:

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
nano .env
```

Set these values in `.env`:

```text
SESSION_SECRET=<the output of openssl rand -hex 32>
DATABASE_HOST=127.0.0.1
DATABASE_PORT=3306
DATABASE_NAME=traversex
DATABASE_USER=traversex
DATABASE_PASSWORD=<the database password used in Step 3>
FIREBASE_PROJECT_ID=<your Firebase project ID>
FIREBASE_CREDENTIALS_FILE=/etc/traversex/firebase/project-a.json
TRAVERSEX_INSTANCE_ID=project-a
```

For the RBMSv4 sample setup, replace the corresponding values with:

```text
FIREBASE_PROJECT_ID=rbmsv4-vrp
FIREBASE_CREDENTIALS_FILE=/etc/traversex/firebase/rbmsv4.json
TRAVERSEX_INSTANCE_ID=rbmsv4-local
```

Do not commit `.env`. The repository `.gitignore` already excludes it.

## 5. Provision the Firebase credential file

Obtain the service-account JSON from the Firebase project administrator using
an approved secure transfer. Do not paste it into GitHub, the browser, chat,
or a public folder.

If the downloaded file is `/home/your-user/Downloads/firebase-service-account.json`,
install it with restricted permissions:

```bash
sudo install -o root -g traversex -m 0640 \
  /home/your-user/Downloads/firebase-service-account.json \
  /etc/traversex/firebase/project-a.json
sudo -u traversex test -r /etc/traversex/firebase/project-a.json
```

The last command must finish without output or error. Use the exact path in
`FIREBASE_CREDENTIALS_FILE` and in the Admin project's credential reference.

## 6. Create the first Admin account

Load the local environment and bootstrap an Admin password. The password is
used only for this command and is not written to the repository:

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

Use a password of at least 8 characters. Change it immediately after the
first login.

## 7. Register the project and collections

For the RBMSv4 sample registry, run:

```bash
set -a
. ./.env
set +a
npm run seed-rbmsv4
```

For a different Firebase project, skip that command and register the project
and collections from the Admin page.

Start the web page temporarily for configuration:

```bash
set -a
. ./.env
set +a
npm start
```

Open `http://127.0.0.1:8085/admin/login`, sign in, and edit the registered
project. Enter all of the following:

1. the Firebase project ID;
2. the credential reference, for example
   `/etc/traversex/firebase/rbmsv4.json`;
3. the **separate target MySQL** host, port, database, username, and password;
4. the collections that this worker is allowed to monitor.

The TraverseX control database is only for registry, authentication, runtime,
and event reports. It must not be used as the registered project's projection
target. Stop the temporary web process with `Ctrl+C` after saving the project.

## 8. Install the persistent systemd services

Copy the local `.env` into root-owned environment files. The worker instance
name must match `TRAVERSEX_INSTANCE_ID` and the `project_key` in the Admin
registry:

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

The service units use `/usr/bin/env node`, so they work whether Node.js is
installed at `/usr/bin/node` or `/usr/local/bin/node`.

For a custom project, replace every `rbmsv4-local` in this section with the
same project key used in `TRAVERSEX_INSTANCE_ID` and in the Admin registry.

## 9. Verify the installation

Run each check and confirm the expected result:

```bash
curl --fail http://127.0.0.1:8085/healthz
systemctl is-active traversex-web.service
systemctl is-active traversex@rbmsv4-local.service
sudo journalctl -u traversex-web.service -n 30 --no-pager
sudo journalctl -u traversex@rbmsv4-local.service -n 50 --no-pager
```

The health check should return JSON containing `"ok":true`. Both services
should report `active`. The worker log should say that it is ready for the
registered project and should report its active listener count.

Run the repository checks when validating a code update:

```bash
npm run check
npm --prefix ui run lint
git diff --check
```

A running service alone is not proof of a successful projection. For a real
Firebase document, verify the complete lifecycle in Admin activity and in the
registered target database:

```text
Firebase PENDING -> worker receives change -> target MySQL row -> exact
read-back -> Firebase SYNCED -> target mysql_sync_status=SYNCED
```

## 10. Troubleshooting

### `registered_project_not_found`

`TRAVERSEX_INSTANCE_ID` does not match an ACTIVE `project_key` in the
`traversex_project` table. Correct the instance environment file and restart
only that worker:

```bash
sudo systemctl restart traversex@rbmsv4-local.service
```

### `registered_project_mysql_configuration_missing`

The registered project's target MySQL fields are incomplete. Open Admin,
edit the project, and save the target host, port, database, username, and
password. TraverseX must never fall back to the control database.

### `firebase_credentials_missing`

The credential file does not exist or is unreadable by `traversex`. Check:

```bash
sudo ls -l /etc/traversex/firebase/project-a.json
sudo -u traversex test -r /etc/traversex/firebase/project-a.json
```

### `ER_ACCESS_DENIED_ERROR` or `ER_BAD_DB_ERROR`

Check `DATABASE_*` in `/etc/traversex/web.env` and the target MySQL settings
stored for the registered project. Do not put a database password in a Git
commit or command-line argument.

### Admin restart button says `restart_not_permitted`

The service can still run normally. The button needs a narrowly scoped
root-owned sudoers rule for the exact worker instance. Create a new rule for
the new PC's web-service account and instance; do not grant general sudo.

## Security and data boundaries

- Firebase is authoritative for application mutations.
- Registered project MySQL databases are projections; the TraverseX control
  database is not a projection fallback.
- Firebase document IDs and matching `*_key` fields must remain consistent.
- Do not upload `.env`, service-account JSON, passwords, tokens, logs with
  private document IDs, or `node_modules`.
- Schema healing creates a recoverable backup before a rebuild. Never drop a
  production table or Firebase collection as an installation shortcut.
