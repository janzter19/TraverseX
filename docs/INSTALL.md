# TraverseX installation

TraverseX is a standalone, multi-project Firebase-to-MySQL monitoring and projection service. It does not import or depend on `/var/www/html/traverse` or RBMSv4. The admin page configures projects and collection names. The portal displays MySQL runtime metrics, so viewing analytics does not read Firestore.

## 1. Prepare the OS account and application

```bash
sudo useradd --system --home /var/lib/traversex --shell /usr/sbin/nologin traversex
sudo mkdir -p /etc/traversex/firebase /var/lib/traversex
sudo chown -R traversex:traversex /var/lib/traversex
cd /var/www/html/traverseX
npm install --omit=dev
cp .env.example .env
```

Never commit `.env` or a Firebase service-account JSON file. Keep the credential file readable only by `traversex` (`chmod 640`, root:traversex).

## 2. Create the dedicated MySQL database

Use a dedicated least-privilege MySQL account. Do not use root from the running service. Run `database/schema.sql` with an administrator account, then set `DATABASE_*` in the environment file. The schema uses `xId INT(10) AUTO_INCREMENT PRIMARY KEY` for its own control tables; Firebase document IDs remain strings in worker projection tables that are added per contract.

## 3. Bootstrap the first admin safely

Generate a password hash locally without placing the password in source or Git:

```bash
export TRAVERSEX_BOOTSTRAP_USERNAME=admin
export TRAVERSEX_BOOTSTRAP_PASSWORD='[SET_LOCALLY_ONLY]'
npm run bootstrap-admin
unset TRAVERSEX_BOOTSTRAP_PASSWORD
```

The script stores only a scrypt hash and sets `must_change_password=1`; the password is never recorded in this repository. Change the initial password immediately after first login.

## 4. Configure Firebase

Place the service-account JSON at the protected path in `FIREBASE_CREDENTIALS_FILE` for the initial control setup. Set `FIREBASE_PROJECT_ID` to the intended Firebase project. Each registered project is then configured from Admin with its own Firebase project ID and credential reference; browser pages never receive a service-account key.

## 5. Register the project's own MySQL target

The TraverseX database (`DATABASE_*`) is the control database only. It stores the project registry, collection registry, authentication records, and operational reports. It is not the projection target for a registered project.

In **Active registered projects**, use the edit action and provide the registered project's:

- Firebase project ID and service-account file reference;
- MySQL host and port;
- MySQL database name;
- MySQL username and password.

TraverseX encrypts the registered MySQL password with AES-256-GCM using the local `SESSION_SECRET`; only ciphertext is stored in `traversex_project`. The password is never rendered in the project table, returned by the API, or written to logs. During worker startup, TraverseX loads the active project by `TRAVERSEX_INSTANCE_ID`, verifies a connection to that registered MySQL database, and opens Firebase using that project's Firebase configuration. If any target setting is missing or invalid, the worker is not ready and does not fall back to the control database.

## 6. Run the web portal/admin

```bash
set -a; . ./.env; set +a
npm start
```

Open `/admin/login` for configuration and `/portal` for analytics. The global top loading bar and modal header status are driven by the real request lifecycle and clear in `finally` on success or error.

## 7. Install one worker per project

Copy `systemd/traversex@.service` to `/etc/systemd/system/`, create `/etc/traversex/project-a.env`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now traversex@project-a
systemctl status traversex@project-a
```

The Admin restart button calls `systemctl restart traversex@<instance>`. For a web process to use that button, install a narrowly scoped root-owned sudoers rule for the web service account (or run Admin behind a local operator proxy). Do not grant general sudo access and do not put a sudo password in PHP/JavaScript. Without that rule the button returns the safe technical code `restart_not_permitted`.

For the local sample instance, install `systemd/traversex-sudoers` only after confirming the web process account is `janzter`. It permits only restart and status checks for `traversex@rbmsv4-local.service`.

The worker contract is intentionally conservative: registry is loaded at startup/manual reload/recovery; no 30-second full Firestore rescan. Every active Collection Monitor entry uses the same generic projection engine. A missing target table is created from the current Firebase document, and a schema change is healed by the backup/rebuild process documented in `docs/AUTO-SCHEMA-HEALING.md`. There is no `NOT_CONFIGURED` projection branch.

For a persistent install, copy `systemd/traversex-web.service` and `systemd/traversex@.service` to `/etc/systemd/system/`, create `/etc/traversex/web.env` and one environment file per worker, then enable both the web service and the worker instance. The restart button is deliberately least-privilege: it needs a root-owned sudoers rule allowing only `systemctl restart traversex@<approved-instance>.service` for the web service account. Never grant general sudo and never put a sudo password in the web application.

## Operational rules

- Firebase is authoritative; MySQL is a projection and report store.
- New Firebase documents use the real Firestore document ID and matching `*_key`.
- Only `PENDING` mutations are eligible for projection; acknowledge only after exact MySQL read-back.
- Keep retries and dead letters in MySQL reports; never store passwords, service-account JSON, or tokens in logs.
- Schema healing is additive and reviewable. Never silently drop production tables or collections.

Each worker instance is one registered project (`TRAVERSEX_INSTANCE_ID` matches `traversex_project.project_key`). This prevents a worker from projecting one Firebase project into another project's database. The worker listens only to the registered project's `PENDING` documents and acknowledges only after the generic projection has completed an exact MySQL read-back. A registered collection does not need a separately coded adapter.

## 8. Seed the RBMSv4 sample registry

After the schema and admin bootstrap are complete, run `npm run seed-rbmsv4` from the TraverseX directory. This adds the verified RBMSv4 Firebase project ID and curated collection monitor list to TraverseX's own MySQL database. It stores only a credential path reference (`/etc/traversex/firebase/rbmsv4.json` by default); it does not copy a service-account key or read Firebase documents. Override `RBMSV4_FIREBASE_PROJECT_ID`, `RBMSV4_PROJECT_KEY`, or `RBMSV4_CREDENTIAL_REF` for another instance.

The seeded runtime remains `NOT_READY` until the credential file is provisioned separately and the worker preflight succeeds. Once the worker starts, it writes `STARTING` and then `RUNNING` plus `last_heartbeat_at` to `traversex_runtime`; listener snapshots update the Firebase-read and pending counters, successful projections update `processed_count`, and projection/listener failures write `ERROR` with a safe code and description. Registry and portal pages read TraverseX MySQL only, so viewing them performs zero Firestore reads. Collections are loaded at worker startup or manual reload/recovery, not by a periodic full scan.
