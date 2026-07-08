# Cutting over from Docker Compose to k3s

This is one VPS. The current `docker-compose.production.yml` stack already
holds ports 80/443 and most of the RAM, so this is a real cutover, not a
parallel blue-green between the old and new stacks. **Do not run the DNS/
traffic-switch step without explicit confirmation** -- everything up to that
point is reversible; that step is the one that isn't (briefly, for real
users).

## 1. Validate internally first, old stack still serving live traffic

- All pods `Running`/`Ready`: `kubectl -n circle-prod get pods`
- Hit health endpoints directly, bypassing DNS:
  ```bash
  kubectl -n circle-prod port-forward svc/api 8080:8080 &
  curl localhost:8080/health
  kubectl -n circle-prod port-forward svc/socket 8081:8081 &
  curl localhost:8081/health
  ```
- Test the Traefik ingress with a Host header override (before DNS points here):
  ```bash
  curl -H "Host: api.circle.orincore.com" https://<vps-ip>/health -k
  ```
- Confirm the migration baseline (docs/PROVISIONING.md step 7) is complete and
  `npm run migrate` is a no-op against this DB.
- Kill a pod and confirm k8s replaces it automatically:
  ```bash
  kubectl -n circle-prod delete pod <api-pod-name>
  kubectl -n circle-prod get pods -w
  ```

## 2. Maintenance window

1. Announce/schedule a short window.
2. Confirm the nightly backup ran successfully at least once against the new
   self-hosted Postgres (not Supabase) -- see [BACKUPS.md](./BACKUPS.md).
3. Stop writes hitting the old stack briefly if you need a clean final data
   sync from Supabase (only relevant if the new Postgres wasn't already the
   system of record for all in-flight data).
4. Flip DNS (or, if DNS already points at this VPS's IP, this is just: stop
   the old nginx/docker-compose stack so port 80/443 free up for Traefik,
   then confirm Traefik took over):
   ```bash
   cd /root/Circle-Lastest-Backend   # old compose checkout
   docker-compose -f docker-compose.production.yml down
   ```
5. Verify from outside the VPS:
   ```bash
   curl https://api.circle.orincore.com/health
   ```
6. Watch logs/error rates for 15-30 minutes before declaring it done.

## 3. Decommission the old stack

Only after the above has been stable for a few days:

```bash
docker system prune -af --volumes   # careful: removes old containers/images/volumes
```

Keep `docker-compose.production.yml` and the Jenkinsfile in git history for
reference, but they're no longer the deploy path once GitHub Actions +
k3s are confirmed stable.
