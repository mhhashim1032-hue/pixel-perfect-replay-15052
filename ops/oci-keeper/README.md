# Forge Oracle background keeper

This is a small, outbound-only stream relay for a user-owned Oracle Cloud Always Free VM. It replaces the paid E2B keeper when **FORGE_KEEPER_URL** and **FORGE_KEEPER_SECRET** are configured in the Forge app.

The keeper:
- Holds the authenticated **/api/agent** stream open when the user's phone/browser disconnects.
- Does not clone repositories, execute project commands, or run untrusted GitHub Actions.
- Keeps the request and session token in memory only while the stream is active; it does not write them to disk or log them.
- Accepts traffic only with a 256-bit shared secret and only calls exact HTTPS app origins in its allowlist.
- Binds to **127.0.0.1:8787**; it must be exposed through Cloudflare Tunnel, not a public inbound firewall rule.
- Supports at most four concurrent keeper streams by default.

The VM is a relay, not a GPU machine or model-training host. Hosted model APIs still perform inference.

## 1. Prepare the Oracle VM

Use an Ubuntu 24.04 ARM64 Ampere A1 Always Free instance in your home region. A 2 OCPU / 12 GB shape is a sensible first allocation, subject to your account's free-tier quota and regional capacity.

Keep the OCI security list / network security group limited to SSH (TCP 22) from your IP. Do not open 8787, 3000, 443, or database ports on the VM.

Install Node.js 20 or newer, then clone this repository or copy the **ops/oci-keeper** folder onto the VM. From the repository root run:

~~~bash
sudo bash ops/oci-keeper/install.sh
~~~

The installer creates a locked-down **forge-keeper** system user, installs the service under **/opt/forge-keeper**, creates **/etc/forge-keeper.env** with a random 256-bit secret, and enables the systemd service. It does not install Cloudflare Tunnel, open ports, deploy Forge, or provision the VM.

Edit **/etc/forge-keeper.env**:

- Set **FORGE_KEEPER_ALLOWED_ORIGINS** to the exact HTTPS origin of your Forge application, for example **https://app.example.com**. Do not include a path or trailing slash. Multiple origins may be comma-separated.
- Keep **FORGE_KEEPER_SECRET** unchanged unless you intentionally rotate it.
- Leave **FORGE_KEEPER_PORT=8787**.

Then restart and verify:

~~~bash
sudo systemctl restart forge-keeper
sudo systemctl status forge-keeper --no-pager
curl -fsS http://127.0.0.1:8787/health
~~~

## 2. Expose it through Cloudflare Tunnel

In Cloudflare Zero Trust, create a named Tunnel and install the **cloudflared** connector on this VM using the commands Cloudflare provides. Add one public hostname, such as **keeper.example.com**, with service target:

~~~text
http://127.0.0.1:8787
~~~

Use Cloudflare's generated tunnel credentials and systemd service. Do not expose the VM's port 8787 directly and do not add an OCI ingress rule for it.

Check **https://keeper.example.com/health**. It should return only **{ "ok": true, "service": "forge-keeper" }**.

## 3. Configure the Forge app

In the Forge app's server-only environment settings (for example Vercel Project → Settings → Environment Variables), add:

- **FORGE_KEEPER_URL=https://keeper.example.com**
- **FORGE_KEEPER_SECRET=** the value of **FORGE_KEEPER_SECRET** from **/etc/forge-keeper.env**

Redeploy the Forge app after changing environment variables. Never put the shared secret in a VITE_ or NEXT_PUBLIC_ variable, browser code, GitHub repository, or chat message.

When configured, Forge prefers this keeper over E2B. If **FORGE_KEEPER_URL** is absent, the existing optional E2B behavior remains unchanged. If a remote URL is configured but unreachable or misconfigured, Forge fails closed to direct mode rather than silently sending the session token to another provider.

## 4. Operations

~~~bash
sudo systemctl status forge-keeper --no-pager
sudo journalctl -u forge-keeper -n 100 --no-pager
sudo systemctl restart forge-keeper
~~~

The service logs lifecycle errors only; it must never log request bodies, bearer tokens, or the shared secret. The keeper keeps jobs in memory, so a VM reboot interrupts active streams. Forge's existing stale-run recovery can restart eligible runs after the app sees them as interrupted.

## Security boundaries

- The shared secret is compared in constant time and is required for every non-health endpoint.
- The worker origin must exactly match **FORGE_KEEPER_ALLOWED_ORIGINS**.
- Redirects from the Forge API are rejected, preventing the bearer token from being forwarded to another host.
- Request size is capped at 32 MiB and token/task identifiers are validated.
- The keeper has no GitHub, Supabase, Vercel, model-provider, or internal-ledger credentials.
- The service does not run repository code and is not a self-hosted GitHub Actions runner.
- The VM remains user-owned. No instance, tunnel, DNS record, environment variable, or database migration is provisioned automatically by this repository.

This is a best-effort background stream relay, not an uptime SLA. Oracle Always Free capacity and Cloudflare account limits apply.
