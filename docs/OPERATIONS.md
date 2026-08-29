# TraverseX operations

## Service commands

The web service and each worker instance are separate processes:

```bash
sudo systemctl status traversex-web.service --no-pager
sudo systemctl status traversex@rbmsv4-local.service --no-pager
sudo systemctl restart traversex-web.service
sudo systemctl restart traversex@rbmsv4-local.service
sudo systemctl stop traversex@rbmsv4-local.service
sudo systemctl start traversex@rbmsv4-local.service
```

Follow logs without writing a new operational log file containing document
IDs:

```bash
sudo journalctl -u traversex-web.service -f
sudo journalctl -u traversex@rbmsv4-local.service -f
```

The worker should report the registered project, source scope, and
PENDING-only listener count during startup.

## Admin routes

- `http://127.0.0.1:8085/admin/login` — login.
- `http://127.0.0.1:8085/admin` — dashboard.
- `http://127.0.0.1:8085/portal` — optional MySQL-only runtime summary.
- `http://127.0.0.1:8085/healthz` — process health.

The dashboard refresh icon reloads the current control-DB report. The logout
icon clears the browser session; it does not delete project data.

## Clear Logs

Use the Clear Logs action only for an intentional development reset. The UI
must show a confirmation before it sends the request. On confirmation it:

1. clears cached last-event fields in `traversex_collection`;
2. deletes `traversex_collection_event` activity rows; and
3. resets current-run Reads, Processed, Retries, Errors, last-event, and
   failure counters in `traversex_runtime`.

It does not clear Firebase, projection tables, the pending queue, registered
projects, registered collections, or Firebase application data. Afterward,
refresh the dashboard and verify the counters are zero before allowing new
test traffic.

## Update and redeploy

```bash
cd /var/www/html/traverseX
git status --short
git pull --ff-only origin main
npm ci --omit=dev
npm run check
sudo systemctl restart traversex-web.service
sudo systemctl restart traversex@rbmsv4-local.service
curl --fail http://127.0.0.1:8085/healthz
```

If `ui/src` changed, build before restarting the web service:

```bash
npm --prefix ui ci
npm run build
```

Keep local `.env`, `/etc/traversex/*.env`, credential JSON, database backups,
and runtime logs outside Git. Inspect migrations and back up the control DB
before applying an upgrade migration.

## Backup and recovery

Back up the control database before schema changes or destructive development
resets:

```bash
sudo install -d -m 0750 /var/backups/traversex
sudo mariadb-dump --single-transaction --routines --triggers traversex \
  | sudo tee /var/backups/traversex/control-$(date +%F-%H%M%S).sql >/dev/null
```

Back up target databases according to the owning application's policy. The
automatic schema-healing flow creates its own target-table backup before an
incompatible rebuild; see [AUTO-SCHEMA-HEALING.md](AUTO-SCHEMA-HEALING.md).

## Evidence-based health check

For a real Firebase document, check all layers:

```text
Firebase document has mysql_sync_status=PENDING
  -> worker listener receives it
  -> target MySQL row is inserted/updated
  -> worker reads the exact target row back
  -> control DB records SUCCESS
  -> Firebase document becomes SYNCED
```

An active systemd process, a successful build, or a dashboard refresh alone
does not prove this lifecycle.

## Common failures

| Symptom | First checks |
| --- | --- |
| Dashboard `internal_error` | `journalctl -u traversex-web.service`; verify control DB env and service status. |
| Empty project list | Confirm the control DB is readable and the project is ACTIVE; logout only clears session. |
| Worker stops at startup | Check instance key, Firebase credential path, and target MySQL fields. |
| `firebase_project_mismatch` | Confirm the registered Firebase project ID and credential JSON belong together; review source scope. |
| Pending count remains above zero | Inspect the pending modal, worker journal, target MySQL privileges, and exact document status. |
| Restart button denied | Install only the exact scoped rule in `systemd/traversex-sudoers`. |
| Two browser scrollbars | Rebuild/deploy the current `public/dashboard` bundle and verify the modal body, not the page, owns long-content scrolling. |
