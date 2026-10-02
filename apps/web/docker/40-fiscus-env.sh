#!/bin/sh
# Writes the SPA's runtime config from container env, so one image works behind any proxy
# layout (ADR 0003). Served at /env.js by nginx.conf.
#
# If API_UPSTREAM is set (e.g. http://api:3000), nginx also proxies /api/ to it, so a single
# port serves both the app and the API from the same origin.
set -eu

json_escape() {
  printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

printf 'window.__FISCUS_CONFIG__ = {"apiUrl":"%s"};\n' "$(json_escape "${API_URL:-}")" \
  > /tmp/fiscus-env.js

rm -f /tmp/fiscus-proxy.conf
if [ -n "${API_UPSTREAM:-}" ]; then
  # Strict format check: the value is written into nginx config.
  if ! printf '%s' "$API_UPSTREAM" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'; then
    echo "API_UPSTREAM must look like http://host:port (got an invalid value)" >&2
    exit 1
  fi
  cat > /tmp/fiscus-proxy.conf <<CONF
location /api/ {
  proxy_pass $API_UPSTREAM;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_buffering off;
  proxy_read_timeout 1h;
  client_max_body_size 25m;
}
CONF
fi
