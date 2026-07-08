# Provisioning k3s on the Hostinger KVM 2 VPS

Run these directly on the VPS (SSH in first). None of this has been executed
for you -- verify each step's output before moving to the next, especially
since this is a live production box.

## 1. Install k3s (single-node, no separate etcd)

```bash
curl -sfL https://get.k3s.io | sh -s - \
  --write-kubeconfig-mode 644 \
  --disable metrics-server   # optional: skip if you want kubectl top later
```

This installs the k3s server with the bundled Traefik ingress controller and
the `local-path` storage class -- no extra ingress controller or CSI driver
needed for a single node.

Verify:
```bash
sudo systemctl status k3s
kubectl get nodes           # should show 1 Ready node
kubectl get storageclass    # should show "local-path (default)"
kubectl -n kube-system get pods | grep traefik
```

## 2. Point kubeconfig at it for convenience

```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config
```

## 3. Clone the repo (if not already present from the old Jenkins setup)

```bash
git clone <your-repo-url> /root/Circle-Lastest-Backend
cd /root/Circle-Lastest-Backend
```

## 4. Create secrets

Follow [README.md](./README.md#secrets-never-committed-to-git) -- do this
before applying any Deployment, since every pod references these Secret names.

## 5. Configure Traefik's Let's Encrypt resolver

Edit `k8s/base/traefik-acme-config.yaml`, replace the placeholder email, then:

```bash
kubectl apply -f k8s/base/traefik-acme-config.yaml
kubectl -n kube-system rollout status deploy/traefik
```

## 6. Apply the base manifests (everything except app Deployments -- those come from CI)

```bash
kubectl apply -f k8s/base/namespace.yaml
kubectl apply -n circle-prod -f k8s/base/configmap.yaml
kubectl apply -n circle-prod -f k8s/base/postgres-statefulset.yaml
kubectl apply -n circle-prod -f k8s/base/redis-deployment.yaml

kubectl -n circle-prod rollout status statefulset/postgres
kubectl -n circle-prod rollout status deployment/redis
```

## 7. Baseline the DB migration tracker

**Critical, one-time step.** The production DB already has years of manually
-applied migrations with no tracking table. If you skip this and let CI run
`npm run migrate` cold, it will try to re-run all 76 files against a schema
that already has them -- guaranteed errors, possibly worse.

From your local machine (or the VPS) with `DATABASE_URL` pointed at the
**real production Postgres** (via `kubectl port-forward` or directly if
you're on the VPS once the postgres Service exists):

```bash
kubectl -n circle-prod port-forward svc/postgres 5433:5432 &
DATABASE_URL="postgresql://circle:<password>@localhost:5433/circle" npm run migrate:baseline
```

Confirm it recorded ~76 rows and executed nothing:
```bash
DATABASE_URL="postgresql://circle:<password>@localhost:5433/circle" \
  psql "$DATABASE_URL" -c "SELECT count(*) FROM schema_migrations;"
```

Only after this succeeds should CI be allowed to run `npm run migrate` for real.

## 8. Apply the Traefik ingress routes

```bash
kubectl apply -n circle-prod -f k8s/base/ingressroute.yaml
```

DNS for `api.circle.orincore.com` should already point at this VPS's IP from
the current setup -- no change needed there.

## 9. First deploy

Push to `main` (or manually trigger `.github/workflows/deploy.yml`) once
GitHub Secrets (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`) are set. Watch:

```bash
kubectl -n circle-prod get pods -w
```

Do **not** point live traffic here yet -- see [CUTOVER.md](./CUTOVER.md).
