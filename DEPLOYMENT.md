# JobConnect deployment guide

## Attach a custom domain on Render

1. Deploy the service from this repository using the root `render.yaml` Blueprint, or open the existing JobConnect web service in the Render dashboard.
2. Open the web service's **Settings** page and find **Custom Domains**.
3. Choose **Add Custom Domain** and enter the domain you want to use, for example `jobconnect.in`. Add `www.jobconnect.in` separately if you want both names to work.
4. Render displays the DNS records required for that service. Keep this page open; use the record name and target shown there as the source of truth.
5. Sign in to the domain registrar or DNS provider and add the requested records (examples below).
6. Return to Render and wait for domain verification and TLS certificate provisioning. Once the domain is marked verified and HTTPS is active, test both the root page and API, for example `https://www.jobconnect.in/` and `https://www.jobconnect.in/api/health`.
7. If using both the apex domain and `www`, choose one canonical address and configure a redirect at the DNS/CDN/provider layer. DNS records alone do not redirect HTTP requests.

DNS updates can take time to propagate. Remove conflicting records for the same hostname, and do not publish an `A` and a `CNAME` for the same name.

## DNS record examples

Use the exact target Render shows under **Custom Domains**. Render may change or provide a service-specific target; do not assume the example hostname below is the target for your service.

| Hostname | Type | Name / Host | Value / Target |
| --- | --- | --- | --- |
| `www.jobconnect.in` | CNAME | `www` | The target shown by Render, commonly the service's `*.onrender.com` hostname |
| `jobconnect.in` (apex/root) | A | `@` | `216.24.57.1` if Render requests this apex A record; follow the value shown in your Render dashboard |

Some DNS providers support ALIAS, ANAME, or CNAME flattening for apex domains. Use that only if Render's instructions and your DNS provider support it. If your provider cannot point the apex to Render as instructed, use `www` as the primary hostname and configure an HTTP redirect from the apex.

## Environment variables

Set production values in the Render web service's **Environment** settings, not in a committed file. When using the supplied Blueprint, Render connects its PostgreSQL database to `DATABASE_URL`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Yes | Set to `production`. |
| `PORT` | Render-managed | The server listens on this port. Let Render supply it; do not hard-code a local port in production. |
| `DATABASE_URL` | Yes for persistent production storage | PostgreSQL connection string. Attach the Render database or set the connection string securely. If absent, the app falls back to `data/db.json`, which is not recommended on an ephemeral service filesystem. |
| `BOOTSTRAP_ADMIN_MOBILE` | Required to bootstrap admin | Owner admin's 10-digit mobile number. |
| `BOOTSTRAP_ADMIN_PASSWORD` | Required to bootstrap admin | Strong password with at least 8 characters, including letters and digits. Store as a secret. At startup the app creates or updates this admin. |
| `BOOTSTRAP_ADMIN_NAME` | Optional | Display name for the owner admin. |
| `BOOTSTRAP_ADMIN_EMAIL` | Optional | Email for the owner admin; use a valid address if set. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Optional, required for production password-reset email | SMTP connection and sender settings. Configure all five to enable email OTP delivery. Keep credentials secret. |

Do not commit `.env` or paste database URLs, admin passwords, or SMTP credentials into source control, logs, or support requests. If a secret is exposed, rotate it in Render and update any affected services.

## Production backups

### PostgreSQL (recommended)

1. Schedule regular backups and keep copies outside Render. For important production data, use the database provider's managed backup/PITR options where available as well as periodic exports.
2. Obtain the database's **External Database URL** from the Render PostgreSQL dashboard for a backup tool running outside Render. Treat the URL as a password.
3. With PostgreSQL client tools installed, create a compressed custom-format dump:

   ```sh
   pg_dump --format=custom --no-owner --file=jobconnect-$(date +%F).dump "$DATABASE_URL"
   ```

   In PowerShell, set the URL in the current process without putting it in the command history, then run `pg_dump`:

   ```powershell
   $env:DATABASE_URL = Read-Host "Paste the PostgreSQL URL"
   pg_dump --format=custom --no-owner --file="jobconnect-backup.dump" $env:DATABASE_URL
   ```

4. Store backup files in access-controlled, encrypted storage, restrict access, and periodically test restoring a dump to a separate database.
5. To restore into an empty or disposable PostgreSQL database, use:

   ```sh
   pg_restore --no-owner --clean --if-exists --dbname="$RESTORE_DATABASE_URL" jobconnect-backup.dump
   ```

   Review the target database carefully before using `--clean`; it drops objects being restored. Never test a restore against the live production database.

### Local JSON fallback

If running locally without `DATABASE_URL`, the application stores its data in `data/db.json` (or the path specified by `DB_FILE`). Stop the server before copying the file so the backup is consistent. Keep the copy private because it contains account data and password hashes. Restore by stopping the server and replacing the active JSON file with the chosen backup.

The JSON fallback on Render is not durable across service replacement or filesystem loss. Configure PostgreSQL for production persistence.
