#!/bin/sh
# Circle Backend Cron Worker Entrypoint
# ============================================

set -e

# Create log directory
mkdir -p /var/log/cron

# Export environment variables for cron jobs
printenv | grep -v "no_proxy" >> /etc/environment

echo "Starting Circle Cron Worker..."
echo "Timezone: $(date +%Z)"
echo "Current time: $(date)"

# Start cron daemon in foreground
exec crond -f -l 2
