#!/bin/sh
# Nightly Postgres backup -> S3. Run as a k8s CronJob (see k8s/base/backup-cronjob.yaml).
set -eu

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="circle-backup-${TIMESTAMP}.dump"
TMP="/tmp/${FILE}"

echo "Dumping database to ${TMP}..."
pg_dump "${DATABASE_URL}" --format=custom --file="${TMP}"

echo "Uploading to s3://${AWS_S3_BUCKET}/postgres-backups/${FILE}..."
aws s3 cp "${TMP}" "s3://${AWS_S3_BUCKET}/postgres-backups/${FILE}"

rm -f "${TMP}"
echo "Backup ${FILE} complete."
