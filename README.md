# TraverseX

Standalone multi-project Firebase-to-MySQL traversal platform.

- Admin: project and Firebase collection registry, ACTIVE/INACTIVE status.
- Portal: per-project analytics from MySQL only.
- Worker: Firebase Admin SDK entry point with isolated systemd instances.
- Database: dedicated `traversex` control/report schema.

Start with [docs/INSTALL.md](/var/www/html/traverseX/docs/INSTALL.md). This repository contains no credentials and does not include the legacy `/var/www/html/traverse` tree.
