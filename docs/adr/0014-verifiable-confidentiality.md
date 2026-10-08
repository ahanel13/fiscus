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

A constraint shapes everything below: **no features are given up for it.** Search, reports,
rules, sync, prices, and notifications must work exactly as they do for a self-hosted household.

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
| Database or backup administrator | Someone with `psql` access | Tier 2 (the database runs inside the VM; no console) |
| Host, hypervisor, or cloud provider staff | Root on the machine, a memory dump | Tier 2 |
| The instance operator | Whoever deploys and runs the hosted service | Tier 2 (they start it but never hold the key) |
| Whoever signs releases or sets the key policy | A malicious or coerced maintainer | Made **visible** by Tier 2: public release log, two-person signing, separate key policy |
| Anyone who takes a running server, or one while nobody is signed in | A subpoena, a seizure | Tier 2 against the host; otherwise **not protected**, by choice (see "Considered, not planned") |
| Other household members | A partner reading a private account | Already: row-level security (ADR 0005/0006) |
| Plaid, banks, email providers | | Not protectable; disclosed |

## Decision

### 1. The server keeps computing; we limit who can read and make it verifiable
We keep server-side processing, so background sync, rules, prices, and notifications work for
every household, and **no feature is weakened** for confidentiality. Instead of blinding the
server, we (a) protect everything it stores at rest, (b) make sure only verified code ever holds
the keys in hosted deployments, and (c) let users check those claims for themselves. We say
plainly what remains trusted.

### 2. Tier 1: foundations, every deployment (self-hosted too)
1. **Everything at rest is encrypted, without changing how data is queried.** Database volumes
   are encrypted, and backups are encrypted before they leave the server, with keys kept apart
   from both. Field-level encryption stays as in ADR 0005 §3 (notes, account numbers, bank
   tokens): it costs no features. Descriptions, names, and merchants are **not** field-encrypted,
   because that would move search, rule matching, and merchant reports out of SQL; inside a
   confidential VM (Tier 2) nobody outside the published code can read them anyway.
2. **Keys stay out of the database and the image.** `KeyProvider` (ADR 0005 §3) gains a file or
   secret backend for self-hosting and a KMS backend, used for the master key, the volume key, and
   the backup key.
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

### 4. Considered, not planned: protection while nobody is signed in
Two designs would protect data even from a server that is taken while nobody is signed in. Both
cost features, so neither is planned; they are recorded here so they can be revisited.

1. **Sealed household** (ADR 0005 §6): the household key is wrapped by each member's passkey or
   password and unlocked only while someone is signed in. New bank data is encrypted with the
   household's **public** key (which can lock data but not unlock it), so sync continues, but
   rules, balances, and detailed alerts wait for the next sign-in, and a forgotten password
   without a recovery kit loses the data.
2. **On-device notifications** in a native app: the server sends a content-free "something
   changed" push; the app decrypts with a key only it holds, evaluates alerts, and shows the
   detail itself. It needs an installed app and fails when the phone defers background work.

### 5. Notifications are designed for this from the start (M4)
- Notifications are built on the server, with full detail by default.
- **Per-person detail level**, for those who want it: *full* ("$412.18 at Costco on Joint
  Visa"), *summary* ("3 new transactions, 1 over budget"), or *minimal* ("You have new activity
  in Fiscus"). The setting explains that email is readable by email providers along the way.

### 6. What we tell users (amends ADR 0005 §5)
We only claim what the deployment actually does:

| Deployment | Claim |
|---|---|
| Self-hosted | "You run the server, so only you can read your data. Disks and backups are encrypted with keys kept separately." |
| Hosted, Tier 1 only | "Your data is encrypted at rest and in backups. The service's operators can technically access it while it's running." (ADR 0005's wording) |
| Hosted, Tier 2 | "Your data is only ever read by the published, independently verifiable Fiscus code, on hardware that encrypts it from the host. Our staff and our cloud provider can't read it. Releases are signed by two people and publicly logged; verify the server yourself." |

Every claim lists its exceptions: Plaid and banks, email contents, and metadata.

### 7. Development impact
Little changes in day-to-day development, and no feature is designed differently. About a tenth
of the work is code (key providers, the locked confidential mode, the log check, the verify
endpoint); half is the build and release pipeline; the rest is operating practice (debugging
without shells, from scrubbed logs and local reproductions) and documentation. Local development, tests, and self-hosting run as they do today.
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
- **Field-level encryption of descriptions, names, and merchants:** protects data from a database
  reader, but moves search, rule matching, and merchant reports out of SQL. Volume and backup
  encryption cover thieves at no cost, and Tier 2 covers database readers in hosted deployments.
- **Doing nothing beyond ADR 0005:** honest, but not enough to host anyone else's finances.

## Consequences
- Background features, including notifications, keep working for every household.
- No feature is weakened: search, reports, rules, sync, prices, and notifications work the same in
  every deployment.
- Self-hosters gain encrypted volumes and backups, keys outside the database, clean logs, and
  verifiable builds.
- A hosted service can make a strong, checkable claim, but needs confidential-VM hardware, a key
  service, two release signers, and an audit before launch. That is a launch gate, not a
  prerequisite for M2–M10.
- Operators lose shells and consoles in hosted production. Debugging relies on scrubbed logs,
  metrics, traces, and local reproductions.
- Data on a server that is taken (rather than stolen as disks or backups) is readable by whoever
  then runs it outside a confidential VM. Accepted, and disclosed, to keep every feature.

## Follow-up work
To be filed as an epic, with tickets in these milestones:

| Work | Milestone |
|---|---|
| Encrypted volumes and encrypted backups, with keys kept apart (install docs and backup job) | M2 |
| `KeyProvider` file/secret and KMS backends | M2 |
| No financial data in logs (test) | M2 |
| Reproducible builds, cosign signing, SBOM, Sigstore, digest in release notes | M2 |
| Security page, threat model, data-flow diagram, `security.txt` | M2 |
| Notification detail levels (with notifications) | M4 |
| Data export (#254), crypto-shred household deletion (HH-07) | existing tickets |
| Confidential mode: attested key release, locked configuration, TLS inside, no shells | M11 |
| "Verify this server" endpoint, page, and verification guide | M11 |
| Two-person release signing; separate key policy; customer-managed keys | M11 |
| Operator actions in household activity; consent-based support access | M11 |
| Independent security audit; status page; incident disclosure policy | M11 |
