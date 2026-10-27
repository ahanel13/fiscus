# Budgeting prototypes (#339)

Static HTML screens for the [budgeting walkthrough](../../budgeting.md). They use the app's
design tokens (`prototype.css`) but none of its code, and each is labeled as a prototype. Open
any of them in a browser.

To regenerate the PNGs after editing one, from the repository root (no local browsers needed):

```sh
version=$(sed -n "s/^ *'@playwright\/test': *//p" pnpm-workspace.yaml)
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:$PWD" -w "$PWD/apps/web" \
  "mcr.microsoft.com/playwright:v$version-noble" \
  node "$PWD/docs/design/walkthroughs/budgeting/prototypes/render.mjs"
```

When the features ship, the walkthrough switches to screenshots of the built app, and these can go.
