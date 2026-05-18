# HTTPS Setup — nginx + Let's Encrypt

SSH into the VM first: `ssh game`

## 1. Google Cloud Firewall

In the GCP console, add a firewall rule to allow TCP port 443 (same as the existing port 80 rule).

## 2. Install nginx and certbot

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 3. Move Node off port 80

Check how pm2 is starting the app:
```bash
sudo pm2 show barrage
```

If `PORT=80` is set, restart without it (the app defaults to 3000):
```bash
sudo pm2 stop barrage
sudo PORT=3000 pm2 start barrage  # or edit your pm2 ecosystem config
sudo pm2 save
```

## 4. Configure nginx

```bash
sudo nano /etc/nginx/sites-available/barrage
```

Paste:
```nginx
server {
    listen 80;
    server_name game-show.cloud-ip.cc;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Enable and restart:
```bash
sudo ln -s /etc/nginx/sites-available/barrage /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## 5. Get the SSL certificate (Let's Encrypt via certbot)

```bash
sudo certbot --nginx -d game-show.cloud-ip.cc
```

Certbot will ask for your email, auto-edit the nginx config to add HTTPS, and set up auto-renewal.

## 6. Verify

- `http://game-show.cloud-ip.cc` should redirect to `https://`
- `https://game-show.cloud-ip.cc` should load the game
- On Android Chrome, after a couple of visits you should see an "Add to Home Screen" install prompt

## Notes

- Cert renewal is automatic (certbot installs a cron/systemd timer)
- If the VM IP changes, the cert is unaffected — it's tied to the domain name
- No code changes are needed in the repo
