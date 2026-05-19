# Barrage — Server & Deployment Setup

## VM (Google Cloud)

- **Instance**: e2-small (2 vCPUs, 2GB RAM), Debian, region: Germany
- **Hostname on VM**: `germany-e2`
- **User**: `antonsplavnik`
- **Disk**: 30GB (upgraded from 10GB)
- Ephemeral external IP (changes on VM restart) — no static IP reserved to avoid extra cost

## DNS (ClouDNS)

- **Domain**: `game-show.cloud-ip.cc` (free tier, ClouDNS)
- **Dynamic DNS** — VM calls ClouDNS API to update A record to current IP
- Dynamic URL token is a secret — regenerate via ClouDNS dashboard if leaked
- ISP DNS can be slow to propagate; Google DNS (8.8.8.8) updates faster
- VM cannot ping itself via the domain (Google Cloud doesn't route external IP back to self)

### Cron Jobs (on VM)

```
@reboot wget -q --read-timeout=0.0 --waitretry=5 --tries=400 https://ipv4.cloudns.net/api/dynamicURL/?q=TOKEN -O /dev/null
*/5 * * * * wget -q --read-timeout=0.0 --waitretry=5 --tries=400 https://ipv4.cloudns.net/api/dynamicURL/?q=TOKEN -O /dev/null
```

- `@reboot` updates DNS on VM startup
- `*/5` keeps it updated every 5 minutes
- Cron entries MUST be single lines — line breaks silently break them
- URL and flags are case-sensitive (`-O` not `-o`, `dynamicURL` not `dynamicurl`)

## Caddy (HTTPS Reverse Proxy)

- Caddy handles HTTPS termination and auto-renews Let's Encrypt certificates
- Listens on ports 80 and 443, reverse proxies to Node on localhost:3000
- Config: `/etc/caddy/Caddyfile`
- Managed via systemd: `sudo systemctl restart caddy`

## PM2 (Process Manager)

- Server runs on **port 3000** (default) via user-level `pm2` (no sudo)
- Process name: `barrage`
- Caddy handles ports 80/443, so Node no longer needs root
- Auto-start configured: `pm2 save` + `pm2 startup`

## Firewall (Google Cloud)

- TCP ports 80 (HTTP) and 443 (HTTPS) allowed
- ICMP (ping) may not be allowed — doesn't affect game functionality

## Auto-Deploy (GitHub Actions)

- Workflow: `.github/workflows/deploy.yml`
- Triggers on push to `main`
- Uses `appleboy/ssh-action` to SSH into `game-show.cloud-ip.cc`
- Runs: `git pull origin main` → `npm install` → `pm2 restart barrage`
- Dedicated deploy key (`deploy-barrage`) stored in GitHub Secrets as `VM_SSH_KEY`
- VM has `~/.ssh/config` entry for `github.com` pointing to custom key name (`github`)

## SSH Access (Local Mac)

`~/.ssh/config`:
```
Host game
    HostName game-show.cloud-ip.cc
    User antonsplavnik
    IdentityFile ~/.ssh/game-server
```

Connect with: `ssh game`

## Reference Docs

Detailed reference files for each topic are in:
`~/Documents/Programming/_REFERENCE/VPS-Server-setup/`
- `dns-basics.md` — DNS concepts, A records
- `dynamic-dns.md` — ClouDNS setup and automation
- `cron.md` — Cron syntax, schedules, common mistakes
- `pm2.md` — PM2 commands, startup, sudo vs non-sudo
- `htop.md` — Reading htop, keyboard shortcuts, typical memory usage
- `google-cloud-firewall.md` — Firewall rules, ports
- `ports-and-multiple-servers.md` — Running multiple apps, nginx reverse proxy

## Notes

- e2-small has ~1.2-1.5GB free RAM after OS and one Node server
- Caddy owns privileged ports (80/443), so Node runs unprivileged on 3000
- DNS flush on Mac: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
- Mac may ignore custom DNS settings if router overrides via IPv6
