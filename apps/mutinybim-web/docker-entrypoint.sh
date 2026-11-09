#!/bin/sh
# A new Fly or Docker volume is mounted owned by root, and files an operator makes over `fly ssh console`
# are root's too. Hand /data to the app's user, then drop root: the app and its script box never run as root.
set -eu
if [ "$(id -u)" = "0" ]; then
  find /data ! -user mutinybim -exec chown mutinybim:mutinybim {} +
  export HOME=/tmp
  exec setpriv --reuid=10001 --regid=10001 --clear-groups -- "$@"
fi
exec "$@"
