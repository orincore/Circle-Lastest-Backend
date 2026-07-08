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

# Start cron daemon in foreground. Deliberately NOT `exec`'d: as PID 1, this
# script is the session leader, and busybox crond's `-f` mode still calls
# setpgid() on itself during startup -- which POSIX forbids a session leader
# from doing to itself, so it crash-loops forever if it replaces PID 1
# directly. Keeping the shell as PID 1 and crond as a child avoids that.
crond -f -l 2
wait $!
