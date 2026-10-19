# Backups and encrypted storage

How Fiscus backs up its database, how to keep those backups and the disk under them unreadable to
whoever gets hold of them, and how to restore. Design: [ADR 0014](../adr/0014-verifiable-confidentiality.md)
Tier 1.1 (#306). Code: `packages/db/src/backup.ts`, `backup-cli.ts`.

## What it protects, and what it doesn't

| Protected | Not protected |
|---|---|
| A stolen or discarded disk, or a copy of the database volume | Someone who can log in to the running server, or to its containers |
| A leaked backup: a copied file, an exposed bucket, an old USB drive | Someone with the backup **and** its private key |
| | A compromised Fiscus or Postgres process (it reads the data decrypted) |

While Fiscus runs, the data is decrypted in memory and on the unlocked volume; that's what Tier 2
(confidential VMs, #312) is for. Field-level encryption ([encryption](encryption.md)) adds to this
for notes, account numbers, and bank tokens.

## Backups

The compose stack takes two kinds of `pg_dump` (custom format) into the `db-backups` volume:

| Kind | When | Kept | Name |
|---|---|---|---|
| **Scheduled** (`backup` service) | Every `BACKUP_INTERVAL_HOURS` (24) | `BACKUP_KEEP` (7) | `fiscus-<UTC time>-scheduled.dump.age` |
| **Before an upgrade** (`migrate`, [upgrades](../design/upgrades.md) §5) | When migrations are pending | `MIGRATE_BACKUP_KEEP` (5) | `fiscus-<UTC time>-before-<migration>.dump.age` |

- The schedule survives restarts: on start, the `backup` service waits for the rest of the interval
  since its newest dump. A failed backup is retried an hour later, and logged.
- A dump is written under a temporary name and renamed when complete, so a failed one never
  counts. With encryption, `pg_dump`'s output goes straight into `age`: the dump is never on disk
  unencrypted.
- `BACKUP_INTERVAL_HOURS=0` takes one backup and exits, with the exit code saying whether it
  worked, for running it from cron instead.

### Encrypting them

Backups are encrypted with [age](https://age-encryption.org) to one or more **public keys**
(`BACKUP_AGE_RECIPIENTS`). The server only ever has the public key, so it can write backups but
can't read them; restoring needs the **private key**, which never goes on the server.

1. **On your own computer** (not the server), make a key pair with
   [age](https://github.com/FiloSottile/age#installation):

   ```bash
   age-keygen -o fiscus-backup-key.txt
   # Public key: age1…
   ```

2. **Keep `fiscus-backup-key.txt` off the server**: in a password manager, and a second copy
   somewhere safe (printed, or on a USB drive in a drawer). Without it, every backup is
   unreadable, so losing it is as bad as having no backups.
3. On the server, put the **public** key in the stack's `.env` and restart:

   ```bash
   BACKUP_AGE_RECIPIENTS=age1…
   docker compose up -d
   ```

   Several keys, separated by spaces or commas, each restore on its own: a second person's, or a
   spare kept offline.
4. Without `BACKUP_AGE_RECIPIENTS`, backups are written **unencrypted** (`.dump`), and the
   `backup` service says so in its log every time it starts. Once it's set, remove the old ones:

   ```bash
   docker compose run --rm --no-deps --entrypoint sh backup -c 'rm -v /backups/*.dump'
   ```

### Copying them off the server

A backup on the server's own disk doesn't survive the disk. The `.age` files are safe to copy
anywhere (another machine, a NAS, cloud storage), because they can't be read without the private
key:

```bash
docker compose cp backup:/backups ./fiscus-backups      # or rsync/rclone/restic from the volume
```

`APP_ENCRYPTION_KEY` isn't in the dumps. Keep it apart from them, as [encryption](encryption.md)
says: a restored database needs it to decrypt notes, account numbers, and bank connections.

### Restoring

Into an **empty** database, as with a pre-upgrade dump ([upgrades](../design/upgrades.md) §5). The
private key is mounted for the one command and removed with the container:

```bash
C="docker compose -f deploy/compose/docker-compose.yml"
$C run --rm --no-deps --entrypoint ls backup -l /backups        # pick the backup
$C stop api worker web backup                                   # nothing writing meanwhile
$C exec db dropdb -U fiscus_owner --force fiscus
$C exec db createdb -U fiscus_owner fiscus
$C run --rm --no-deps -v ~/fiscus-backup-key.txt:/run/key.txt:ro --entrypoint sh backup -c \
  'age -d -i /run/key.txt /backups/<file>.dump.age | pg_restore --exit-on-error --dbname "$MIGRATION_DATABASE_URL"'
$C up -d
```

For an unencrypted `.dump`, leave out `age -d …|` and give `pg_restore` the file. Restore with the
release that took the backup, or a newer one: its migrations bring the schema up to date.

### The restore drill

A backup nobody has restored is a hope, not a backup. `scripts/backup-drill.sh` runs one against a
running stack: a throwaway key pair, an encrypted backup with `fiscus-backup`, a check that it
can't be read without the key, a restore into an empty database, and a comparison with the live
one, every table's rows and a checksum of the transactions. CI runs it after the end-to-end tests,
on the data they leave. Run it on your own server now and then:

```bash
scripts/backup-drill.sh       # COMPOSE="docker compose -p <project> …" for another stack
```

## Encrypting the database volume

The other half: the disk Postgres writes to. Fiscus doesn't do this itself; it's set up on the
host, below Docker, once. Either way, the key is the host's: it's never in the database, the
image, or the stack's `.env`.

### Docker Compose on Linux: LUKS

Put Docker's data on an encrypted partition or disk, so every volume (`db-data`, `db-backups`) is
on it:

```bash
cryptsetup luksFormat /dev/sdX                  # asks for the passphrase; this erases the disk
cryptsetup open /dev/sdX fiscus
mkfs.ext4 /dev/mapper/fiscus
systemctl stop docker
mount /dev/mapper/fiscus /mnt/fiscus && rsync -a /var/lib/docker/ /mnt/fiscus/docker/
# Point Docker at it: "data-root": "/mnt/fiscus/docker" in /etc/docker/daemon.json
systemctl start docker
```

Add it to `/etc/crypttab` and `/etc/fstab`, and make Docker wait for the mount
(`systemctl edit docker`: `RequiresMountsFor=/mnt/fiscus`), so the stack never starts on an
empty, unencrypted directory.

### Proxmox: ZFS native encryption

Keep the VM's or container's disk on an encrypted dataset:

```bash
zfs create -o encryption=on -o keyformat=passphrase rpool/fiscus
pvesm add zfspool fiscus-encrypted --pool rpool/fiscus
```

Then create (or move) the Fiscus VM's disk on `fiscus-encrypted`.

### Unlocking after a reboot

An encrypted volume has to be unlocked before Postgres can start, so decide how:

- **By hand** (a passphrase over SSH or the console): the strongest, but Fiscus stays down after
  an unattended reboot until someone unlocks it.
- **Automatically, from a key elsewhere**: the machine's TPM (`systemd-cryptenroll --tpm2-device`),
  a key file on a USB drive that isn't kept with the machine, or a network key server
  (Clevis/Tang). Protects a disk taken away on its own, not the whole machine.

A key file on the same disk protects nothing.

## Keys, kept apart

| Key | Where it lives | Not in |
|---|---|---|
| `APP_ENCRYPTION_KEY` (field encryption) | The server's `.env` or a Docker/Proxmox secret (`_FILE`); a copy in your password manager | The database, the image, the backups |
| Backup **private** key | Your password manager, and an offline copy | The server, anywhere near the backups |
| Backup **public** key (`BACKUP_AGE_RECIPIENTS`) | The server's `.env` | Nothing secret about it |
| Volume key (LUKS/ZFS) | The host: typed, TPM, or a separate USB key | The volume itself, the stack, the backups |

Anyone with a backup needs the backup private key to read it, and `APP_ENCRYPTION_KEY` for its
encrypted fields. Keeping each away from the others is what makes a leak of one harmless.
