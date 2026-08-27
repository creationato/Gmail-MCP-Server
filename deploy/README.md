# Gmail MCP Ubuntu Deployment

This directory is a self-contained deployment bundle for Ubuntu 24.04 and
26.04. It installs this checkout as versioned releases, runs it under a
dedicated system account, and keeps all portable data below these roots:

- Releases: `/opt/gmail-mcp`
- State and Gmail account tokens: `/var/lib/gmail-mcp`
- Configuration and secrets: `/etc/gmail-mcp`
- Deployment control state and migration fence: `/var/lib/gmail-mcp-deploy`

The bundle does not require another repository or service. Nginx and a fixed
ngrok endpoint are optional.

## Clean installation

Run from a fresh clone:

```bash
sudo ./deploy/install.sh \
  --public-origin https://mcp.example.com \
  --no-start
```

The installer is idempotent. It installs Node.js 24 when Node.js 24 or newer is
not already available, builds from `package-lock.json`, activates a content-
addressed release, generates a random MCP authorization key, and preserves
existing configuration and state on repeat runs. `--no-start` writes a unique
staging guard and leaves the application, scheduler, and tunnel stopped and
disabled, so they cannot start on reboot. The installer prints the exact later
`activate.sh --staging-id ...` command.
Production systemd deployment intentionally uses the documented roots and the
`gmail-mcp`/`gmail-mcp-ingress` identities. Test-only alternate roots and users
are rejected outside the isolated deployment test mode, because the managed
unit files contain explicit security boundaries for those paths and identities.

Provision the Google OAuth client file separately:

```bash
sudo install -o root -g gmail-mcp -m 0640 \
  ./gcp-oauth.keys.json /etc/gmail-mcp/gcp-oauth.keys.json
sudo /opt/gmail-mcp/current/deploy/activate.sh --staging-id ID_FROM_INSTALL
sudo /opt/gmail-mcp/current/deploy/doctor.sh --local-only
```

The Google OAuth redirect URI for remote account authorization is:

```text
${PUBLIC_ORIGIN}${BASE_PATH}/oauth2callback
```

Add the concrete URI to the Google OAuth client's allowed redirect URIs. The
Claude/Cowork connector URL is `${PUBLIC_ORIGIN}${BASE_PATH}/mcp`.

## Public origin and base path

`/etc/gmail-mcp/gmail-mcp.env` defines two independent values:

```dotenv
PUBLIC_ORIGIN=https://mcp.example.com
BASE_PATH=
GMAIL_MCP_OAUTH_CALLBACKS=https://claude.ai/api/mcp/auth_callback
```

`PUBLIC_ORIGIN` must contain only scheme, host, and optional port. Set
`BASE_PATH=/gmail` when sharing a hostname. The service wrapper exports the
combined value through the application's supported `GMAIL_MCP_PUBLIC_URL`
setting.

Environment files use a strict `KEY=VALUE` allowlist. They are atomically
canonicalized to root ownership, mode `0600`, and one hard link. Shell
expressions, command substitutions, duplicate keys, unknown keys, and paths
outside the managed configuration and state roots are rejected before a
service starts. The isolated Python precheck uses a fixed command and runs
before the application process.

The application serves the configured prefix natively. The shared Nginx
template preserves that prefix and routes its path-aware OAuth metadata.

## Nginx

For a dedicated local gateway, install and activate a standalone server:

```bash
sudo ./deploy/install.sh \
  --public-origin https://mcp.example.com \
  --nginx-mode standalone \
  --nginx-listen 127.0.0.1:8088
```

For an existing shared server, choose a prefix when Gmail should be
namespaced:

```bash
sudo ./deploy/install.sh \
  --public-origin https://mcp.example.com \
  --base-path /gmail \
  --nginx-mode shared
```

This writes `/etc/gmail-mcp/nginx-shared-locations.conf`. Include that file
inside the operator-owned `server {}` block, run `nginx -t`, and reload Nginx.
The encrypted Gmail backup includes the generated fragment, but it does not
include the operator-owned server block or a shared multi-service gateway.
Keep that host-level configuration in a separate root-only backup or
configuration-management system when migrating a combined gateway.
An empty `BASE_PATH` is also supported in shared mode; it installs Gmail as the
fallback `location /` so more-specific routes from another MCP, such as
`/adloop/mcp`, can coexist in the same server block.
Both Nginx templates cap request bodies at 32 MiB, matching the application
transport envelope.
The source templates are generic and may also be rendered directly:

```bash
sudo ./deploy/render-nginx.sh \
  --mode shared \
  --env /etc/gmail-mcp/gmail-mcp.env \
  --output /etc/gmail-mcp/nginx-shared-locations.conf
```

## Fixed ngrok ingress

Install the optional agent and unit:

```bash
sudo ./deploy/install.sh --with-ngrok --no-start
sudoedit /etc/gmail-mcp/ngrok.env
sudo /opt/gmail-mcp/current/deploy/activate.sh --staging-id ID_FROM_INSTALL
```

Use the assigned fixed ngrok domain for `PUBLIC_ORIGIN`. With an empty
`BASE_PATH`, point `NGROK_UPSTREAM` at `http://127.0.0.1:8080`. With a prefix or
shared ingress, point it at the Nginx listener, normally
`http://127.0.0.1:8088`. Request inspection is disabled by the launch wrapper.

The ngrok token remains only in the root-owned environment file. The tunnel
runs as `gmail-mcp-ingress`, receives no application environment or API key,
and cannot read `/var/lib/gmail-mcp`. Its only writable directory is
`/var/lib/gmail-mcp-ingress`.

## Host exposure

The service launcher binds the application to `127.0.0.1`; publish only Nginx
or ngrok. `doctor.sh` reports a warning if a modified deployment exposes a
wildcard listener.

## Upgrade and rollback

Build and atomically activate another checkout while preserving configuration
and state:

```bash
sudo ./deploy/upgrade.sh --source /path/to/new/clone
sudo /opt/gmail-mcp/current/deploy/doctor.sh
```

When an existing shared-Nginx fragment is present, `upgrade.sh` detects and
regenerates it from the new release automatically. The installer runs
`nginx -t` inside the upgrade transaction and reloads an active gateway; a
validation or reload failure restores and reloads the previous fragment. You
can also select the mode explicitly with `--nginx-mode shared`; standalone
deployments should pass `--nginx-mode standalone` together with their existing
`--nginx-listen` and `--server-name` values. Those two standalone-only options
are rejected in other modes. If the previous gateway cannot be validated or
reloaded during rollback, the command exits with an explicit warning and
retains its root-only transaction snapshots for operator recovery.

The installer automatically restores the previous release, generated files,
and service policy when an upgrade fails before completion. Old releases remain
in `/opt/gmail-mcp/releases` for a later operator-directed rollback.

Before a major upgrade, record the current symlink target and save root-only
copies of all three Gmail unit files, the generated Nginx fragment, and any
operator-owned shared server block. A symlink-only rollback is valid only when
the old and new releases use the same deployment wrapper and unit contract.
Across a deployment-format change, stop ngrok, the scheduler, and HTTP; restore
the old `current` target together with its matching units and Nginx files; run
`systemctl daemon-reload` and `nginx -t`; reload Nginx; then start HTTP, the
scheduler, and ngrok in that order. Verify the fixed public URL before resuming
connector workflows.

Never edit an activated release in place.

Install, upgrade, import, backup, restore, activation, and uninstall serialize
through one root-owned `flock`. Each operation snapshots the managed control
files and service policy it changes; failures restore prior enabled/active
state when the affected units can be stopped safely. Use `--no-start` on an
upgrade when rollout and activation must be separate.

## Encrypted backup and VM migration

Create an age identity on a secure administrative workstation and keep the
private identity off the MCP VM. Back up with its public recipient:

```bash
sudo ./deploy/backup.sh \
  --output /secure-transfer/gmail-mcp-$(date +%F).tar.age \
  --recipient age1REPLACE_WITH_PUBLIC_RECIPIENT
```

Backups stop the HTTP server, scheduler, and tunnel briefly so SQLite and queue
state are consistent, validate the trees again after writers stop, then restore
the exact previous enabled/active policy. Use this form for disaster recovery.

For a VM migration, create the archive on VM A with `--leave-stopped`:

```bash
sudo ./deploy/backup.sh \
  --leave-stopped \
  --output /secure-transfer/gmail-mcp-migration.tar.age \
  --recipient age1REPLACE_WITH_PUBLIC_RECIPIENT
```

This writes a persistent source fence, stops the HTTP server, scheduler, and
units are also disabled. The archive records a cryptographic random fence
identifier. That identifier is an operator-verifiable assertion from VM A, not
a distributed lease or proof that VM A remains stopped. Do not remove
`/var/lib/gmail-mcp-deploy/migration-fence.env` on VM A while VM B is active.

On VM B, install the same tagged source with `--no-start` and `--with-ngrok`
when the archive contains fixed-ingress configuration. Transfer the encrypted
archive and age identity through separate secure channels, verify VM A remains
fenced, then restore:

```bash
sudo ./deploy/install.sh \
  --public-origin https://mcp.example.com \
  --with-ngrok \
  --no-start
sudo ./deploy/restore.sh \
  --input /secure-transfer/gmail-mcp-migration.tar.age \
  --identity /secure-transfer/age-identity.txt
sudo /opt/gmail-mcp/current/deploy/activate.sh \
  --staging-id ID_FROM_RESTORE \
  --confirm-source-stopped \
  --source-fence-id ID_IN_SOURCE_FENCE
sudo /opt/gmail-mcp/current/deploy/doctor.sh
```

Restore validates every archive member, enforces release compatibility, builds
replacement state/config trees, and atomically swaps them while services are
stopped. It never enables or starts a unit. A release mismatch is rejected
unless an operator supplies `--allow-release-mismatch` after a compatibility
review. Activation is always a separate command. For restores, the operator
must assert that every source and peer scheduler is stopped; a recorded fence
ID must also match the independently observed VM A marker. Successful
activation writes a local consumed-staging record, so the same archive cannot
be activated twice on that target. The fixed ingress hostname should move to
VM B only after local verification passes.

The archive includes all configuration, Google OAuth keys, account tokens,
scheduled queue data, and state beneath the two portable roots. It does not
include release binaries; install the desired source release before restoring.

Connector clients, front-door OAuth tokens, callback state, schedules, and Gmail
account credentials are stored below the portable state root and included in
the encrypted backup.

### Import an existing source installation

To move an existing per-user installation into the service layout without an
intermediate archive, install with the explicit legacy directory:

```bash
sudo ./deploy/install.sh \
  --public-origin https://mcp.example.com \
  --import-legacy /path/to/legacy/.gmail-mcp \
  --no-start
```

The importer places `gcp-oauth.keys.json` under `/etc/gmail-mcp` and stages all
runtime files under `/var/lib/gmail-mcp` before replacing the state tree. It
rejects symbolic links, special files, hardlinks, and overlapping
source/destination roots. Existing destination files are preserved; use
`deploy/import-legacy.sh --source DIR --force` only when an intentional
replacement is required. Import always leaves every managed unit stopped and
disabled behind an activation guard; `--no-start` remains only as a compatibility
no-op.

## Diagnostics and tests

Run source-level deployment validation without root:

```bash
./deploy/verify.sh
```

Run installed checks locally or through the configured public ingress:

```bash
sudo /opt/gmail-mcp/current/deploy/doctor.sh --local-only
sudo /opt/gmail-mcp/current/deploy/doctor.sh
```

`verify.sh` performs Bash syntax checks, artifact and secret scans, systemd unit
validation when available, Nginx rendering tests, launch-wrapper tests, an
isolated backup/restore round trip, and a real temporary HTTP server test. The
HTTP test completes discovery, dynamic client registration, PKCE authorization,
token exchange, authenticated MCP initialization, and tool listing.
`doctor.sh` checks installed files, permissions, services, OAuth metadata, and
the unauthenticated MCP challenge.

The release gate used by CI is:

```bash
./deploy/verify.sh
./deploy/tests/run.sh
./deploy/tests/http-e2e.sh
./deploy/tests/clean-install.sh
```

`clean-install.sh` installs simulated VM A filesystem roots from this repository
alone, completes the
authenticated HTTP flow, creates an encrypted fenced migration archive,
installs a separate simulated VM B root, requires explicit activation after VM
A is stopped and fenced, deletes VM A's simulated filesystem, and repeats the
authenticated flow from the restored VM B release. The fake-systemd harness
does not prove real systemd boot ordering, unit sandboxing, account ownership,
Nginx/ngrok behavior, or reboot persistence. Those remain production-host E2E
gates: run `doctor.sh`, verify local and authenticated public ingress, restart
the application, scheduler, and owned tunnel, reboot, and repeat the connector
check without changing the fixed URL.

## Uninstall

The default keeps configuration and state for a later reinstall:

```bash
sudo ./deploy/uninstall.sh
```

Permanent removal requires an explicit destructive confirmation:

```bash
sudo ./deploy/uninstall.sh --purge --yes
```
