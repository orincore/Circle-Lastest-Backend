# Postgres backups

`k8s/base/backup-cronjob.yaml` runs `pg_dump` nightly at 20:00 UTC (01:30 IST)
and uploads to `s3://$AWS_S3_BUCKET/postgres-backups/`, reusing the same AWS
credentials already in `circle-backend-secrets`.

## One-time setup: S3 lifecycle rule (retention)

The CronJob never deletes old dumps itself -- set an expiry rule on the
bucket/prefix instead, once:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket <your-bucket> \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-postgres-backups",
      "Filter": {"Prefix": "postgres-backups/"},
      "Status": "Enabled",
      "Expiration": {"Days": 30}
    }]
  }'
```

Adjust the 30-day window to whatever retention you actually want.

## Verify it works

```bash
kubectl -n circle-prod create job --from=cronjob/postgres-backup test-backup
kubectl -n circle-prod logs job/test-backup -f
aws s3 ls s3://<your-bucket>/postgres-backups/
kubectl -n circle-prod delete job test-backup
```

## Restore (manual -- not automated)

```bash
# Download the dump
aws s3 cp s3://<your-bucket>/postgres-backups/<file>.dump ./restore.dump

# Restore into a running postgres pod (or a throwaway one for testing first!)
kubectl -n circle-prod port-forward svc/postgres 5433:5432 &
pg_restore --clean --if-exists -d "postgresql://circle:<password>@localhost:5433/circle" ./restore.dump
```

Test this restore path against a scratch database at least once before you
need it for real.
