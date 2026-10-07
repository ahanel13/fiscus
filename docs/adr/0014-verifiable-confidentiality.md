# ADR 0014: Earning users' trust: verifiable confidentiality

- Status: Proposed
- Date: 2026-10-07
- Amends: [ADR 0005](0005-tenancy-and-trust-model.md) §3 (what is encrypted), §5 (what we tell
  users), and §6 (the sealed household)
- Related: [ADR 0013](0013-tamper-evident-activity-history.md) (activity history),
  [encryption](../security/encryption.md)

## Context
ADR 0005 chose a **trusted operator**: whoever runs an instance can technically read its data,
and we say so. That is honest, and fine for a family running its own server. It is not enough
to offer Fiscus to people who don't run the server themselves. They need reasons to trust it
that don't come down to "trust us".

The feature that matters most here is **notifications**: email and, later, push alerts such as
"Costco charged $412 on the joint card" or "checking dropped below $500". Like scheduled bank
sync, investment prices, rules on arrival, and net-worth snapshots, they need the server to
**read data while nobody is logged in**. Whatever we choose has to keep that working.

### What is and isn't possible
Computing on data needs a key at that moment. The real choice is **where the key lives while
nobody is logged in**:

| Key held by | Background work | Who can read | Example |
|---|---|---|---|
| The server | All of it, any time | Whoever controls the running server | Fiscus today (ADR 0005) |
| The server, inside a confidential VM | All of it, any time | Only the attested, published code; not the host or cloud staff | This ADR, hosted |
| Nobody (member-held keys) | Data can arrive (encrypted to a public key); processing and detailed alerts wait for a sign-in | Members while signed in | The "sealed household" (ADR 0005 §6) |
| The user's device | Whatever the device does | The device | Actual Budget (local-first) |

Three limits hold whatever we choose:

- **Whoever ships the code can read the data the next time it runs.** The server sends the web
  app's JavaScript, so even end-to-end encryption in the browser trusts the publisher. The
  defence is to make a malicious release **visible**, not impossible.
- **Plaid, SimpleFIN, and banks see what they send.** So do email providers: anything in an email
  is readable by the sender's and recipient's mail services.
- **Metadata** (that you use Fiscus, when, and how much data you have) is visible to whoever runs
  the network and hardware.

### Threat model

| Who | Example | Protected by |
|---|---|---|
| Thief of disks, backups, or database dumps | A leaked backup bucket | Tier 1 |
| Database or backup administrator | Someone with `psql` access | Tier 1 (fields encrypted), Tier 2 (database inside the VM) |
| Host, hypervisor, or cloud provider staff | Root on the machine, a memory dump | Tier 2 |
| The instance operator | Whoever deploys and runs the hosted service | Tier 2 (they start it but never hold the key) |
| Whoever signs releases or sets the key policy | A malicious or coerced maintainer | Made **visible** by Tier 2: public release log, two-person signing, separate key policy |
| Anyone with a seized server while nobody is signed in | A subpoena, a stolen server | Tier 3 (optional) |
| Other household members | A partner reading a private account | Already: row-level security (ADR 0005/0006) |
| Plaid, banks, email providers | | Not protectable; disclosed |

## Decision

### 1. The server keeps computing; we limit who can read and make it verifiable
We keep server-side processing, so background sync, rules, prices, and notifications work for
every household. Instead of blinding the server, we (a) encrypt more of what it stores, (b) make
sure only verified code ever holds the keys in hosted deployments, and (c) let users check
those claims for themselves. We say plainly what remains trusted.

### 2. Tier 1: foundations, every deployment (self-hosted too)
1. **Encrypt the text that identifies spending.** In addition to ADR 0005 §3, encrypt
   transaction descriptions and names (`original_description`, `display_name`), merchant names,
   and import file names with the household key. Amounts, dates, and category and account ids
   stay plaintext so totals, ranges, and budgets stay in SQL.
   - Search and rule matching on that text move from SQL into the app, over a household's
     decrypted rows. That is fast enough at household scale (tens of thousands of rows); a
     benchmark gates it.
   - Exact matching that must stay in SQL (import dedupe keys) uses keyed hashes (HMAC with a
     per-household key).
2. **Keys stay out of the database and the image.** `KeyProvider` (ADR 0005 §3) gains a file or
   secret backend for self-hosting and a KMS backend.
3. **No financial data in logs, errors, or metrics.** Enforced by a test that runs the suite with
   seeded values and fails if any appear in captured output.
4. **Verifiable releases.** Reproducible images (base images pinned by digest, frozen lockfile,
   no timestamps); signed with cosign; an SBOM; recorded in the public Sigstore log; the image
   digest in the release notes. CI builds twice and fails if the digests differ.
5. **A public security page** in the repo: this threat model, a diagram of what data goes where
   (Plaid, email, AI providers), what isn't protected, how to report vulnerabilities
   (`security.txt`), and how dependencies are kept up to date.
6. **Leaving is always possible:** full data export (#254) and household deletion that destroys
   the household key (HH-07). AGPL means anyone can take their data to a self-hosted instance.

### 3. Tier 2: hosted deployments (a gate before hosting anyone else's money)
1. **Confidential VMs** (AMD SEV-SNP or Intel TDX). The CPU encrypts the VM's memory with a key
   that never leaves the chip; the host sees only encrypted bytes.
2. **Keys released only to attested code.** At boot, the CPU measures what it loads and signs an
   attestation report ("genuine chip, running code with fingerprint H"). The key service releases
   the household master key only to a VM whose report shows an image signed by the Fiscus release
   key. The operator **starts** the VM but never handles the key: an image with any change, such
   as a shell or a backdoor, has another fingerprint and gets no key.
3. **The whole plaintext path is inside the VM:** API, worker, Postgres (on a disk encrypted with
   a VM-held key), Valkey, the web server, and **TLS termination**.
4. **A confidential mode that can't be weakened by configuration.** Settings that could leak data
   (debug logging, consoles, plain HTTP) are rejected, because configuration isn't part of the
   measured fingerprint.
5. **No back doors for operators.** No SSH, `docker exec`, or database console in production.
   Migrations, backups, and restores run inside the VM; backups leave already encrypted.
6. **"Verify this server":** an endpoint and page that return the attestation report, with a
   guide and tool to check that it is signed by a genuine chip and that its fingerprint matches a
   published release that anyone can rebuild from source.
7. **Separation of duties.** Releases need **two signatures**. The key-release policy is held by
   someone other than the person who runs the servers, and can be held by the customer
   (customer-managed keys).
8. **Operator actions are visible to households.** Restarts, restores, and support access are
   written to the affected household's activity history (ADR 0013). Support never sees data
   without the household's consent.
9. **Independently audited** before launch, with the report published. A public status page, and
   a commitment to publish an incident report for any security incident.

### 4. Tier 3: optional, for the most cautious users
1. **Sealed household** (ADR 0005 §6, now designed): the household key is wrapped by each member's
   passkey or password and unlocked only while someone is signed in. New bank data is encrypted
   with the household's **public** key, which can lock data but not unlock it, so sync continues
   unattended. Processing and detailed alerts wait for the next sign-in. A recovery kit is
   required: without it, a forgotten password loses the data.
2. **On-device notifications** in a native app: the server sends a content-free "something
   changed" push; the app wakes, decrypts with a key only it holds, evaluates alert rules, and
   shows the detailed notification itself.

### 5. Notifications are designed for this from the start (M4)
- **Per-person detail level:** *full* ("$412.18 at Costco on Joint Visa"), *summary* ("3 new
  transactions, 1 over budget"), or *minimal* ("You have new activity in Fiscus").
- **Email defaults to summary or minimal**, because email is readable along the way. Push
  notifications can be full.
- Alert evaluation and payloads are written so that they can run on the server today and on a
  device (Tier 3) later.

### 6. What we tell users (amends ADR 0005 §5)
We only claim what the deployment actually does:

| Deployment | Claim |
|---|---|
| Self-hosted | "You run the server, so only you can read your data. Backups and disks are encrypted with keys kept separately." |
| Hosted, Tier 1 only | "Your data is encrypted at rest. The service's operators can technically access it while it's running." (ADR 0005's wording) |
| Hosted, Tier 2 | "Your data is only ever read by the published, independently verifiable Fiscus code, on hardware that encrypts it from the host. Our staff and our cloud provider can't read it. Releases are signed by two people and publicly logged; verify the server yourself." |
| Tier 3 household | "While nobody in your household is signed in, nobody can read your data, including us. New transactions wait, encrypted, until you sign in." |

Every claim lists its exceptions: Plaid and banks, email contents, and metadata.

### 7. Development impact
Little changes in day-to-day development. About a tenth of the work is code (key providers, the
locked confidential mode, the log check, the verify endpoint); half is the build and release
pipeline; the rest is operating practice (debugging without shells, from scrubbed logs and local
reproductions) and documentation. Local development, tests, and self-hosting run as they do today.
Confidential mode needs supported AMD EPYC or Intel Xeon hardware, so a CI or staging job on a
cloud confidential VM checks key release and startup on real hardware.

## Rejected alternatives
- **Computing on encrypted data** (homomorphic, order-preserving, or searchable encryption): sums
  are possible, but text matching, sorting, and categorization are orders of magnitude slower or
  leak the data they protect.
- **Process enclaves** (Intel SGX, AWS Nitro Enclaves): no direct disk or network access, so the
  app would have to be split into a small trusted core and an untrusted rest. Confidential VMs give
  the same protection from the host with almost no code change.
- **Local-first, end-to-end encrypted** (Actual Budget's model): it would move rules, reports,
  alerts, and bank sync into the client, which is a rewrite, and it still trusts whoever serves
  the web app's code. ADR 0005's reasons still apply.
- **Doing nothing beyond ADR 0005:** honest, but not enough to host anyone else's finances.

## Consequences
- Background features, including notifications, keep working for every household.
- Self-hosters gain encrypted text, keys outside the database, clean logs, and verifiable builds.
- A hosted service can make a strong, checkable claim, but needs confidential-VM hardware, a key
  service, two release signers, and an audit before launch. That is a launch gate, not a
  prerequisite for M2–M10.
- Moving search and rule matching out of SQL costs some speed on large households; the benchmark
  in Tier 1 decides whether it needs work (for example, a per-household in-memory index).
- Operators lose shells and consoles in hosted production. Debugging relies on scrubbed logs,
  metrics, traces, and local reproductions.
- The sealed household trades convenience (alerts wait for a sign-in) and recoverability (a
  recovery kit is required) for protection while away. That is why it's opt-in.

## Follow-up work
To be filed as an epic, with tickets in these milestones:

| Work | Milestone |
|---|---|
| Encrypt descriptions, names, merchants; app-side search and rule matching; HMAC dedupe keys; benchmark | M1.5 |
| `KeyProvider` file/secret and KMS backends | M2 |
| No financial data in logs (test) | M2 |
| Reproducible builds, cosign signing, SBOM, Sigstore, digest in release notes | M2 |
| Security page, threat model, data-flow diagram, `security.txt` | M2 |
| Notification detail levels; email defaults (with notifications) | M4 |
| Data export (#254), crypto-shred household deletion (HH-07) | existing tickets |
| Confidential mode: attested key release, locked configuration, TLS inside, no shells | M11 |
| "Verify this server" endpoint, page, and verification guide | M11 |
| Two-person release signing; separate key policy; customer-managed keys | M11 |
| Operator actions in household activity; consent-based support access | M11 |
| Independent security audit; status page; incident disclosure policy | M11 |
| Sealed household with public-key ingest and recovery kit | After v1.0 |
| On-device notifications in a native app | After v1.0 |
