#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Writes the SPA's runtime config from container env, so one image works behind any proxy
# layout (ADR 0003). Served at /env.js by nginx.conf.
#
# If API_UPSTREAM is set (e.g. http://api:3000), nginx also proxies /api/ to it, so a single
# port serves both the app and the API from the same origin.
set -eu

json_escape() {
  printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# SOURCE_URL: where users can get this server's source (AGPL-3.0 §13). Set it if you run a
# modified Fiscus; the app links to upstream otherwise.
printf 'window.__FISCUS_CONFIG__ = {"apiUrl":"%s","sourceUrl":"%s"};\n' \
  "$(json_escape "${API_URL:-}")" "$(json_escape "${SOURCE_URL:-}")" > /tmp/fiscus-env.js

# The Content-Security-Policy lets the app call this origin; when API_URL is on another one, it
# needs that origin too (nginx.conf). Only scheme, host, and port are written into nginx config,
# after a strict format check.
api_origin=''
case "${API_URL:-}" in
  '' | /*) ;;
  *)
    api_origin=$(printf '%s' "$API_URL" | sed -nE 's#^(https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?)(/.*)?$#\1#p')
    # One line only: sed would otherwise pass along each line that matches.
    if [ -z "$api_origin" ] || [ "$(printf '%s' "$API_URL" | wc -l)" -ne 0 ]; then
      echo "API_URL must be a path or look like https://host[:port][/path] (got an invalid value)" >&2
      exit 1
    fi
    api_origin=" $api_origin"
    ;;
esac
# shellcheck disable=SC2016 # an nginx variable, not a shell one
printf 'set $fiscus_api_origin "%s";\n' "$api_origin" > /tmp/fiscus-csp.conf

rm -f /tmp/fiscus-proxy.conf
if [ -n "${API_UPSTREAM:-}" ]; then
  # Strict format check: the value is written into nginx config.
  if ! printf '%s' "$API_UPSTREAM" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'; then
    echo "API_UPSTREAM must look like http://host:port (got an invalid value)" >&2
    exit 1
  fi
  # Resolve the API's name per request (cached 10 s), not once at start: nginx otherwise keeps the
  # address it found then, and every request fails (502) after the api container is recreated
  # with a new one. The resolver is the container's own DNS server (Docker's, on compose).
  resolver=$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf 2>/dev/null || true)
  case "$resolver" in *:*) resolver="[$resolver]" ;; esac
  if [ -n "$resolver" ]; then
    resolve="resolver $resolver valid=10s;
  set \$fiscus_api $API_UPSTREAM;"
    # shellcheck disable=SC2016 # an nginx variable, not a shell one
    target='$fiscus_api'
  else
    resolve=''
    target="$API_UPSTREAM"
  fi
  cat > /tmp/fiscus-proxy.conf <<CONF
location /api/ {
  $resolve
  proxy_pass $target;
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
