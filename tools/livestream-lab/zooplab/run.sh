#!/bin/sh
# Rebuild and (re)start zooplab in the background, logging to logs/zooplab.log.
#   ./run.sh [zooplab flags...]   rebuild (zooplab + labclient), vet, restart
#   ./run.sh stop                 stop the running zooplab
# It advertises LAB_IP from ../lab.env in ICE candidates; -media-ip overrides it.
set -e
cd "$(dirname "$0")"
. ../lab.env
PATH=/usr/local/go/bin:$PATH
PIDFILE=zooplab.pid

stop() {
  [ -f "$PIDFILE" ] || return 0
  pid=$(cat "$PIDFILE")
  # Only signal the process if it really is our zooplab (PIDs get reused).
  if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o comm= | grep -q zooplab; then
    kill "$pid"
    i=0
    while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid"; fi
    echo "stopped zooplab (pid $pid)"
  fi
  rm -f "$PIDFILE"
}

if [ "$1" = "stop" ]; then
  stop
  exit 0
fi

# pion/interceptor with the lab's two fixes (third_party/interceptor.patch), made once from the
# upstream module. Keep the version in step with go.mod.
if [ ! -f third_party/interceptor/go.mod ]; then
  src=$(go mod download -json github.com/pion/interceptor@v0.1.49 | sed -n 's/^[[:space:]]*"Dir": "\(.*\)",$/\1/p')
  mkdir -p third_party/interceptor
  cp -R "$src"/. third_party/interceptor/
  chmod -R u+w third_party/interceptor
  patch -s -p1 -d third_party/interceptor < third_party/interceptor.patch
fi

go build -o zooplab .
go build -o labclient ./cmd/labclient
go vet ./...
stop
mkdir -p logs
echo "==== $(date '+%Y-%m-%d %H:%M:%S') starting zooplab $*" >> logs/zooplab.log
nohup ./zooplab -media-ip "$LAB_IP" "$@" >> logs/zooplab.log 2>&1 &
pid=$!
echo $pid > "$PIDFILE"
# Wait until the HTTP API answers (a freshly built binary can take ~1 s to
# start on macOS while it is scanned).
i=0
while [ $i -lt 100 ]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "zooplab failed to start:"
    tail -20 logs/zooplab.log
    exit 1
  fi
  if grep -q "zooplab started (pid $pid)" logs/zooplab.log 2>/dev/null; then
    echo "zooplab running (pid $pid), log: $(pwd)/logs/zooplab.log"
    exit 0
  fi
  sleep 0.1
  i=$((i + 1))
done
echo "zooplab (pid $pid) did not report ready within 10 s; see logs/zooplab.log"
exit 1
