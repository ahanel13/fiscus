# Exposing only Plaid's webhooks

How to let Plaid reach your server for webhooks while the rest of Fiscus stays on your network.
Design: [ADR 0008](../adr/0008-plaid-credentials-and-webhooks.md) §Sync, [aggregation](../design/aggregation.md)
§6b (#84, #85). Threat model: T10, T32 and T33 ([threat model](../design/threat-model.md)).

Webhooks are optional. Without them, Fiscus checks each bank on a schedule, which works on any
network. With them, Plaid tells Fiscus when a bank has new transactions, so they show up sooner.

## What has to be public

One path and one method: **`POST /api/v1/webhooks/plaid`**. Nothing else. Every other path, and
every other method on this one, should get a 404 from your proxy, so the internet never reaches the
app, the sign-in page or the rest of the api.

The receiver checks every request itself: each one has to carry Plaid's signed
`Plaid-Verification` header, or it's refused with 401 and nothing happens. The proxy's job is to
keep everything else off the internet.

What the receiver answers:

| Status | When |
|---|---|
| 200 | A verified webhook, queued or ignored |
| 401 | Not signed by Plaid, or the signature doesn't check out |
| 404 | Webhooks are off (`PLAID_WEBHOOK_URL` unset) |
| 413 | A body over 16 KB |
| 429 | Over 120 requests a minute from one client address (Plaid retries) |
| 503 | Plaid's verification key can't be fetched right now (Plaid retries) |

## Before you start

- **A public hostname with HTTPS.** Plaid only sends webhooks to `https` URLs. Use a name of its own,
  such as `hooks.example.com`. Every proxy below gets its certificate for it (Caddy and Traefik from
  Let's Encrypt on their own, nginx from certbot, Cloudflare from Cloudflare).
- **Keep the LAN site off the public listener.** A client can send any `Host` header, so a public
  port that also serves your LAN hostname serves it to the internet too. Serve the full Fiscus on
  another port, or another proxy, that your router doesn't forward.
- **Where to send it.** Each example proxies to the Fiscus web container, `http://192.168.1.20:8080`
  here: use your server's address and `FISCUS_PORT`. On the same machine it's
  `http://127.0.0.1:8080`. The web container passes `/api/` on to the api.
- **Turn webhooks on.** Set `PLAID_WEBHOOK_URL` in `.env` to the hostname alone, with no path, such
  as `https://hooks.example.com`. Fiscus adds `/api/v1/webhooks/plaid` to it. Then
  `docker compose up -d`. Until it's set, the receiver answers 404, and the checks below give 404
  where they'd give 401.

Three things each proxy below keeps:

- **The 16 KB body limit.** The api refuses bigger bodies (413) anyway. Refusing them at the proxy
  keeps them off your network.
- **The client's address, set by the proxy.** The api counts its rate limit per client address. In
  the compose stack it takes that address from `X-Forwarded-For` (`TRUST_PROXY` is on for the api,
  which only the web container reaches). The proxy should set `X-Forwarded-For` to the address the
  request came from, and drop any value the caller sent, or a caller can make one up for every
  request. The Caddy, nginx and Traefik examples do; Cloudflare Tunnel needs one more step.
- **HTTPS at the proxy.** The proxy talks plain HTTP to Fiscus on your network, as the LAN does.

The `curl` checks at the end of each section send an unsigned request. The receiver counts it as a
refused webhook, like a forged one, so for the next 24 hours polling stays at its normal interval
(aggregation §6b). Nothing else changes.

## Caddy

In your `Caddyfile`:

```caddyfile
hooks.example.com {
	# The one public path: Plaid's webhooks, POST only.
	@plaid {
		method POST
		path /api/v1/webhooks/plaid
	}
	handle @plaid {
		request_body {
			max_size 16KB
		}
		# Caddy's path match ignores case; send the path as Fiscus spells it.
		rewrite * /api/v1/webhooks/plaid
		reverse_proxy 192.168.1.20:8080
	}

	# Everything else.
	handle {
		respond 404
	}
}
```

Caddy gets the certificate itself. It sets `X-Forwarded-For` to the caller's address and ignores
the one the caller sent, unless you list that caller in `trusted_proxies`, so don't.

Check it (from outside your network, or anywhere that resolves the name to the proxy):

```sh
H=https://hooks.example.com
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' $H/api/v1/webhooks/plaid  # 401
curl -s -o /dev/null -w '%{http_code}\n' $H/api/v1/webhooks/plaid                                                     # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' $H/api/v1/auth/login     # 404
curl -s -o /dev/null -w '%{http_code}\n' $H/                                                                          # 404
```

## nginx

A server block of its own, with the certificate from certbot:

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name hooks.example.com;
  ssl_certificate     /etc/letsencrypt/live/hooks.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/hooks.example.com/privkey.pem;

  # The one public path: Plaid's webhooks, POST only.
  location = /api/v1/webhooks/plaid {
    if ($request_method != POST) {
      return 404;
    }
    client_max_body_size 16k;
    # With a path here, Fiscus always gets exactly this one.
    proxy_pass http://192.168.1.20:8080/api/v1/webhooks/plaid;
    proxy_set_header Host $host;
    # The caller's address only, never what the caller sent.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }

  # Everything else.
  location / {
    return 404;
  }
}
```

`location =` matches the path exactly, so `/api/v1/webhooks/plaid/` and the rest get the 404. Use
`return 404` for other methods, not `limit_except`, which answers 403.

Check it:

```sh
H=https://hooks.example.com
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' $H/api/v1/webhooks/plaid  # 401
curl -s -o /dev/null -w '%{http_code}\n' $H/api/v1/webhooks/plaid                                                     # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' $H/api/v1/auth/login     # 404
curl -s -o /dev/null -w '%{http_code}\n' $H/                                                                          # 404
```

## Traefik

In a file the file provider reads (dynamic configuration), with a `websecure` entry point on 443
and a certificate resolver named `letsencrypt` in the static configuration:

```yaml
http:
  routers:
    # The one public path: Plaid's webhooks, POST only.
    fiscus-plaid-webhooks:
      rule: Host(`hooks.example.com`) && Method(`POST`) && Path(`/api/v1/webhooks/plaid`)
      entryPoints: [websecure]
      middlewares: [fiscus-webhook-body]
      service: fiscus
      tls:
        certResolver: letsencrypt

  middlewares:
    fiscus-webhook-body:
      buffering:
        maxRequestBodyBytes: 16384

  services:
    fiscus:
      loadBalancer:
        servers:
          - url: http://192.168.1.20:8080
```

There's no catch-all to write: Traefik answers 404 to anything no router matches. That holds only
while no other router serves this entry point, so give the LAN site its own entry point.

Traefik replaces `X-Forwarded-For` with the caller's address unless the entry point's
`forwardedHeaders.trustedIPs` includes the caller. Leave it unset on the public entry point.

Check it:

```sh
H=https://hooks.example.com
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' $H/api/v1/webhooks/plaid  # 401
curl -s -o /dev/null -w '%{http_code}\n' $H/api/v1/webhooks/plaid                                                     # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' $H/api/v1/auth/login     # 404
curl -s -o /dev/null -w '%{http_code}\n' $H/                                                                          # 404
```

## Cloudflare Tunnel

No port forwarded at all: `cloudflared` runs on your network and connects out to Cloudflare. In its
`config.yml`:

```yaml
tunnel: <tunnel id>
credentials-file: /etc/cloudflared/<tunnel id>.json

ingress:
  # The one public path: Plaid's webhooks.
  - hostname: hooks.example.com
    path: ^/api/v1/webhooks/plaid$
    service: http://192.168.1.20:8080
  # Everything else.
  - service: http_status:404
```

Then `cloudflared tunnel route dns <tunnel id> hooks.example.com`. Cloudflare holds the
certificate.

An ingress rule matches the hostname and path only, not the method. Other methods on this path
still get 404, from the api: it has no other route there.

Two things the tunnel doesn't do:

- **No body limit of its own.** The api still refuses anything over 16 KB (413), as it arrives.
- **The client's address isn't set.** Cloudflare puts the caller's address in `CF-Connecting-IP`,
  but adds it to the end of any `X-Forwarded-For` the caller sent, and the api reads the first. So
  the per-address limit counts whatever callers claim. To count the real address, point the tunnel
  at the nginx block above (on a port only `cloudflared` reaches, without `ssl`) and set
  `proxy_set_header X-Forwarded-For $http_cf_connecting_ip;` there instead of `$remote_addr`.

Check it:

```sh
H=https://hooks.example.com
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' $H/api/v1/webhooks/plaid  # 401
curl -s -o /dev/null -w '%{http_code}\n' $H/api/v1/webhooks/plaid                                                     # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' $H/api/v1/auth/login     # 404
curl -s -o /dev/null -w '%{http_code}\n' $H/                                                                          # 404
```

## Once it works

New bank connections get the webhook URL when they're made. Existing ones are moved to it by the
worker, about 20 a minute (aggregation §6b). Webhook health in Server → Bank connections comes
with #85.

If the checks give 404 where you expect 401, `PLAID_WEBHOOK_URL` isn't set, or the api hasn't been
restarted since. If they give 200, or a page, for any other path, the proxy is passing more than
the one path: fix that before telling Plaid the URL.
