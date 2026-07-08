# Circle Backend on k3s

Overview of the new deployment stack for the Hostinger KVM 2 VPS (2 vCPU / 8GB
RAM). Read in this order:

1. **[PROVISIONING.md](./PROVISIONING.md)** -- install k3s, apply the secrets
   and base manifests, baseline the DB migration tracker.
2. **[BACKUPS.md](./BACKUPS.md)** -- verify the nightly backup + S3 lifecycle rule.
3. **[CUTOVER.md](./CUTOVER.md)** -- switching live traffic from the old
   Docker Compose stack to k3s.

## What's here

| Path | Purpose |
|---|---|
| `k8s/base/*.yaml` | Namespace, ConfigMap, Postgres, Redis, api/socket/matchmaking/cron/ml-matching Deployments+Services, Traefik IngressRoute+ACME config, nightly backup CronJob |
| `k8s/jobs/migrate-job-template.yaml` | Template CI fills in per-deploy to run `scripts/run-migrations.js` before rolling out new images |
| `scripts/run-migrations.js` | Tracked SQL migration runner (creates `schema_migrations`, applies untracked files transactionally) |
| `docker/Dockerfile.migrate`, `docker/Dockerfile.pg-backup` | New images added for this project (migration runner, backup runner) |
| `.github/workflows/deploy.yml` | Builds all 7 images, pushes to GHCR, SSHes in to apply manifests + migrate + roll out |

## Secrets (never committed to git)

Two Kubernetes Secrets, created once by hand on the VPS after k3s is up:

```bash
kubectl create namespace circle-prod

# App secrets -- reuses your existing .env.production wholesale
kubectl -n circle-prod create secret generic circle-backend-secrets \
  --from-env-file=.env.production

# Postgres's own credentials (kept separate so the DB container doesn't see
# unrelated app secrets like JWT_SECRET, third-party API keys, etc.)
kubectl -n circle-prod create secret generic postgres-credentials \
  --from-literal=POSTGRES_USER=circle \
  --from-literal=POSTGRES_PASSWORD='<pick a strong password>' \
  --from-literal=POSTGRES_DB=circle

# Make sure .env.production's DATABASE_URL matches those same values, e.g.:
#   postgresql://circle:<same password>@postgres:5432/circle
```

If GHCR packages are private (default), pods also need pull credentials once:

```bash
kubectl -n circle-prod create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=<your-github-username> \
  --docker-password=<a GitHub PAT with read:packages> \
  --docker-email=you@example.com

kubectl -n circle-prod patch serviceaccount default \
  -p '{"imagePullSecrets": [{"name": "ghcr-pull-secret"}]}'
```

(Or simplest: make the GHCR packages public after the first push, and skip this entirely.)

## Required GitHub Secrets (for `.github/workflows/deploy.yml`)

- `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` -- SSH access to the VPS (same key pattern the old Jenkins pipeline used)
- `GITHUB_TOKEN` is automatic, used to push to GHCR

## Before any of this touches production

Replace every `ghcr.io/OWNER/...` placeholder in `k8s/base/*.yaml` and
`k8s/jobs/migrate-job-template.yaml` with your real GitHub org/user, and the
placeholder email in `k8s/base/traefik-acme-config.yaml` with a real address
(Let's Encrypt uses it for expiry notices).
