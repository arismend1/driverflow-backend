# Data Safety: Backups & Restore

This directory contains utility scripts to manage database snapshots manually.

## 1. Create Backup

Run the following command to create a timestamped snapshot of `driverflow.db`:

```bash
node backup_db.js
```

- **Output**: Creates a new file in `./backups/` (e.g., `driverflow_20260117_045500.db`).
- **Configuration**: Set `BACKUP_DIR` env var to change destination.

## 2. Restore Backup

**WARNING**: This operation overwrites the current database. Stop the server before running this.

```bash
node restore_db.js ./backups/YOUR_BACKUP_FILE.db --confirm
```

## 3. Automation
These scripts are designed for manual use or simple cron scheduling.
- **Do not** run restore while the server is accepting writes.
- Backup can usually be run while server is active (SQLite), but stopping the server guarantees a fully consistent checkpoint.
