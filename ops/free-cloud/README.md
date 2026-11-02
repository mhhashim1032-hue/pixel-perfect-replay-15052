# Free cloud compute options for Forge

This guide separates three different jobs:

1. **Persistent Forge host / worker:** a server that stays available and can run a durable queue.
2. **Coding and CI compute:** short-lived CPU machines for installs, tests and builds.
3. **GPU compute:** useful only when running local models, training or GPU workloads. It does not make API-based GPT/Claude coding faster.

## Recommended zero-budget setup

| Use | First choice | Free allowance / limitation | Fit |
|---|---|---|---|
| Persistent VPS | Oracle Cloud Always Free Ampere A1 | Up to 2 OCPU + 12 GB RAM equivalent, 1,500 OCPU-hours and 9,000 GB-hours monthly; home-region capacity is not guaranteed and signup requires card verification | Best candidate for a persistent worker host |
| Short CI jobs | GitHub Actions | Free account currently includes 2,000 hosted minutes/month for private repos; standard hosted runner usage is free for public repos | Best for tests/builds, not a continuously running coding agent |
| Browser IDE / CPU | Lightning AI Free Studio | One free CPU Studio, with a 4-hour session limit/restart; persistent workspace/storage allowances apply | Good for remote development, not a guaranteed uninterrupted worker |
| GPU experiments | Kaggle Notebooks | Typically up to 30 GPU hours/week, quota/capacity dependent; notebook sessions are limited | GPU experiments only |
| GPU experiments | Google Colab Free | Dynamic GPU access; sessions can disconnect and are limited, so not a daemon/worker host | Temporary model tests only |
| Small always-free VM | Google Cloud e2-micro | One eligible VM in selected US regions, 30 GB standard disk and 1 GB outbound transfer; no free GPU | Too small for heavy coding builds |

Always re-check provider terms before provisioning; free tiers and eligibility can change. “Free” capacity is not an uptime SLA.

## Architecture for Forge

- Keep Forge's own internal ledger in a dedicated internal Supabase project (the new internal credential factory enforces this).
- Run the durable worker on a persistent host such as OCI A1 when available.
- Keep customer GitHub/Supabase/Vercel connections pinned per task. The worker must never use customer credentials as its own ledger credentials.
- Use GitHub-hosted Actions for ordinary CI when possible. Do not route untrusted pull-request code to a persistent self-hosted runner.
- Use a GPU only for local inference/training. When the model is called through an API, the model provider supplies the GPU; Forge's worker mostly needs CPU, RAM, disk and network.

**Current implementation status:** this repository now has the ledger schema, typed ledger adapter and dedicated internal-ledger client. The production queue consumer, provider execution adapters and worker health endpoint are still future work. The bootstrap script below only prepares an Ubuntu ARM64 host; it does not deploy Forge, configure secrets, apply migrations or enable a worker.

## Oracle Cloud Always Free setup

1. Create one OCI Free Tier account using accurate billing/identity details. Oracle requires a supported credit/debit card for verification; this is not a no-card offer.
2. Select the home region carefully. Always Free compute must be provisioned in that home region.
3. Create an Ubuntu 24.04 ARM64 Ampere A1 VM. Stay within the total Always Free allowance: 2 OCPUs and 12 GB RAM. Use a 50 GB boot volume and keep all volumes within the free 200 GB combined block-volume limit.
4. If the console reports `Out of host capacity`, try another availability domain if available or retry later. Do not upgrade to paid just to get capacity if your budget is zero.
5. Add an SSH key, allow SSH only, and connect from your phone using an SSH client.
6. Review this repo's `ops/free-cloud/oci-bootstrap.sh`, then run it on the new VM. It installs general host prerequisites and hardens basic access; it does not expose an app port or open a public service.
7. Do not paste GitHub PATs, Supabase service-role keys, Vercel tokens or model API keys into shell history or this repository. Use a secret manager or protected runtime environment after the worker design is complete.

## Lightning AI for browser-based coding and GPU trials

1. Create one free account and open a CPU Studio.
2. Clone the Forge repository into the Studio and work in a dedicated branch.
3. Save code to GitHub frequently; Studio sessions can restart every four hours.
4. Use the GPU only for local model inference or training. GPU credits are limited and may depend on signup verification/payment-card steps; do not assume a free GPU is always available.
5. Never leave customer secrets in notebook outputs or shared/public Studio artifacts.

## Important security warning about self-hosted GitHub runners

A persistent self-hosted Actions runner can be compromised by untrusted workflow code and retain access between jobs. GitHub explicitly warns against using self-hosted runners for public repositories and advises caution even with private repositories. This guide intentionally does **not** auto-register a self-hosted runner or change the repo's CI runner. A separate ephemeral/isolated execution design is required before giving arbitrary agent-generated code access to a persistent host.

## Official references

- Oracle Always Free resources: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Oracle Free Tier FAQ and card verification: https://www.oracle.com/cloud/free/faq/
- GitHub plans and included Actions minutes: https://github.com/pricing
- GitHub self-hosted runner security: https://docs.github.com/en/actions/reference/security/secure-use
- Lightning AI pricing: https://lightning.ai/pricing
- Kaggle GPU usage: https://www.kaggle.com/docs/efficient-gpu-usage
- Google Cloud Free Tier: https://docs.cloud.google.com/free/docs/free-cloud-features
- Google Colab: https://colab.research.google.com/
