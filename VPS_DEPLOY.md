# VPS deploy: pull from GitHub and update Docker Compose

Use this checklist on the VPS after pushing changes from your machine. The production stack **must** use `docker-compose.dockeruser.yml`. Running plain `docker compose` without `-f` loads `docker-compose.yml` (local dev only: **db** + **minio**, no **app**) and will not rebuild the application and can leave orphan containers.

---

## One-time setup (first time on this server)

Run as the same Linux user that will own the project (e.g. `dockeruser`).

### 1. Install Git and Docker (if needed)

```bash
sudo apt update
sudo apt install -y git
# Docker: follow https://docs.docker.com/engine/install/ubuntu/ if not installed
```

### 2. Clone the repository (if it is not on the VPS yet)

```bash
cd ~
git clone https://github.com/Nelson211-0ss/askmakchatbot.git
cd ~/askmakchatbot
```

Use your real GitHub URL. For a private repo, use SSH (`git@github.com:...`) or HTTPS with a [personal access token](https://github.com/settings/tokens).

### 3. Docker network and data directories

```bash
docker network create dockeruser_network
mkdir -p "${HOME}/docker-volumes/askmak/pgdata" "${HOME}/docker-volumes/askmak/minio"
```

### 4. Environment file

```bash
cd ~/askmakchatbot
cp .env.example .env   # if you use an example file; otherwise create .env
nano .env              # set JWT, API keys, TRUST_PROXY, CORS_ORIGIN, etc.
```

Ensure `.env` exists next to `docker-compose.dockeruser.yml`. The compose file loads it for the **app** service.

#### Email signup verification (Gmail SMTP)

Signup emails are optional in dev but **`NODE_ENV=production` requires SMTP** (`SMTP_HOST`, `SMTP_FROM`, etc.) or registration returns HTTP 503. Git never updates `.env` on the server — copy these from your trusted machine into the VPS file.

1. SSH in and edit the repo `.env`:
   ```bash
   nano ~/askmakchatbot/.env
   ```
2. Set (use a **[Google App Password](https://myaccount.google.com/apppasswords)** — not your normal Gmail password; 2‑Step Verification must be on). Put the whole `From` value in **one** pair of quotes (Docker Compose chokes on `"Name" <a@b.com>` split across quotes):
   ```env
   NODE_ENV=production

   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=youraccount@gmail.com
   SMTP_PASS="xxxx xxxx xxxx xxxx"
   SMTP_FROM="AskMak <youraccount@gmail.com>"
   ```
   Do **not** set `VERIFICATION_EMAIL=false` on production — that means “never send mail, log codes instead.” Omit that line entirely.
3. Recreate only the **app** container so it picks up `.env`:
   ```bash
   cd ~/askmakchatbot
   docker compose -f docker-compose.dockeruser.yml up -d --force-recreate app
   ```
   Check sends: `docker compose -f docker-compose.dockeruser.yml logs -f --tail=30 app`

**Alternative:** copy your local `.env` fragment with `scp` (replace user/host/path):

```bash
scp .env dockeruser@YOUR_VPS_IP:~/askmakchatbot/.env
```

Prefer editing on the VPS so production keeps its own JWT/DB values and you only paste the SMTP lines.

**Password reset:** forgot-password emails use the same SMTP. For databases created **before** the reset-link feature shipped, run the migration once (repo root):  
`docker compose -f docker-compose.dockeruser.yml run --rm app npm run db:apply-password-reset`  
(or execute `backend/db/password_reset_columns.sql` manually against Postgres).

### 5. First full stack start

```bash
cd ~/askmakchatbot
docker compose -f docker-compose.dockeruser.yml pull
docker compose -f docker-compose.dockeruser.yml up -d --build
```

### 6. MinIO buckets (first deploy or empty MinIO only)

```bash
cd ~/askmakchatbot
docker compose -f docker-compose.dockeruser.yml run --rm app npm run setup-minio
```

---

## Every deploy: pull code and refresh containers

SSH in, go to the repo, update Git, then Compose with the **VPS** file.

### 1. SSH to the VPS

```bash
ssh dockeruser@YOUR_VPS_IP
```

### 2. Go to the project

```bash
cd ~/askmakchatbot
```

### 3. Fetch latest code from GitHub

Check branch (default is often `main`):

```bash
git branch
git status
```

Pull:

```bash
git pull origin main
```

If your default branch is not `main`, replace it (e.g. `master`).

If Git refuses to pull because of local edits you do not need:

```bash
git fetch origin
git reset --hard origin/main
```

### 4. Pull images, rebuild app, restart stack

```bash
cd ~/askmakchatbot
docker compose -f docker-compose.dockeruser.yml pull
docker compose -f docker-compose.dockeruser.yml up -d --build --remove-orphans
```

- **`pull`** — refreshes pinned images (Postgres, MinIO).
- **`up -d --build`** — rebuilds the **app** image from the repo and recreates containers as needed.
- **`--remove-orphans`** — removes containers for services no longer in this compose file (helps after switching from the wrong compose file).

### 5. Verify

```bash
docker compose -f docker-compose.dockeruser.yml ps
docker compose -f docker-compose.dockeruser.yml logs -f --tail=50
```

Press `Ctrl+C` to stop following logs.

---

## Host ports (reference)

| Service   | Host binding        | Role        |
|----------|---------------------|------------|
| **app**  | `127.0.0.1:4500`    | HTTP (e.g. nginx → here) |
| **db**   | `127.0.0.1:4520`    | PostgreSQL |
| **minio**| `127.0.0.1:4900`   | S3 API     |
| **minio**| `127.0.0.1:4901`   | Console    |

---

## Troubleshooting

### “Orphan containers” warning

You previously ran `docker compose` without `-f docker-compose.dockeruser.yml`. Always use the `-f` file on the VPS (see step 4 in **Every deploy**). `--remove-orphans` cleans up after you standardize.

### Wrong database or empty app after deploy

Do not manage the same project with **`docker-compose.yml`** and **`docker-compose.dockeruser.yml`** on the VPS. Use **only** `docker-compose.dockeruser.yml` so Postgres and MinIO use `~/docker-volumes/askmak/` and the **app** shares the correct network.

### Database migrations or schema changes

After `git pull`, run whatever migration or SQL steps your project documents (if any). Init scripts under `backend/db/` only run when the Postgres data directory is first initialized; existing volumes skip them.

---

## Quick copy-paste (routine update)

Replace `main` if your branch differs.

```bash
ssh dockeruser@YOUR_VPS_IP
cd ~/askmakchatbot
git pull origin main
docker compose -f docker-compose.dockeruser.yml pull
docker compose -f docker-compose.dockeruser.yml up -d --build --remove-orphans
docker compose -f docker-compose.dockeruser.yml ps
```
