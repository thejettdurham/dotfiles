# Dotfiles

Clone this repo and symlink the files to their relevant locations ✨

## Workmode

Site blocker that redirects distracting domains to a local block page. Run with `sudo npm run workmode`.

**First-time setup:** Generate and trust the local CA:
```bash
CAROOT="$(pwd)/workmode" mkcert -install
```

**If you previously had the CA committed:** The old CA may be compromised. Remove it from your trust store:
```bash
CAROOT="$(pwd)/workmode" mkcert -uninstall
```
Then delete `workmode/rootCA.pem` and `workmode/rootCA-key.pem` if present, and run the setup above to create a fresh CA.
