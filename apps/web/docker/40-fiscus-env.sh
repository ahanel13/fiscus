#!/bin/sh
# Writes the SPA's runtime config from container env, so one image works behind any proxy
# layout (ADR 0003). Served at /env.js by nginx.conf.
set -eu

json_escape() {
  printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

printf 'window.__FISCUS_CONFIG__ = {"apiUrl":"%s"};\n' "$(json_escape "${API_URL:-}")" \
  > /tmp/fiscus-env.js
