# Alpha

AI chatbot PWA: OpenRouter backend, streaming chat, command running, file generation, offline support.

## Run
```bash
cd alpha
cp .env.example .env      # add OPENROUTER_API_KEY and ACCESS_KEY
npm install
npm start                 # http://localhost:3000
```
Needs Node 20.6+. Open it in Chrome or Safari and choose "Install app" / "Add to Home Screen".
PWA install needs HTTPS on a real server (put it behind Caddy, Nginx or Cloudflare).

## When credits run out
Alpha tries your chosen model first. On a 402 (no credits), 429 (rate limit) or provider error it
automatically falls back to `FREE_MODELS` (OpenRouter `:free` models), then to a local Ollama model
if `OLLAMA_URL` is set. Free model names change, so edit `FREE_MODELS` in `.env` when needed.

## Offline
The app shell is cached, chats are stored on the device, and messages sent offline are queued and
sent when the connection returns. AI replies always need the server to be reachable.

## Command running and files
Modes (top bar): Chat only, Agent: ask first (you approve each command), Agent: auto-run.
Tools: run_command, write_file, read_file, list_files, all inside `./workspace`.
Generated files appear as download links and in the Files drawer.

Safety: commands run as the server user and are not sandboxed. Alpha only enables them on localhost
or when `ACCESS_KEY` is set. For a public server, run it in Docker or as a low-privilege user.

## Deploy: GitHub + Render
```bash
cd alpha
git init && git add . && git commit -m "Alpha"
git branch -M main
git remote add origin https://github.com/YOUR_USER/alpha-ai.git
git push -u origin main
```
Then on render.com: New > Blueprint > pick the repo. Render reads `render.yaml`; enter
`OPENROUTER_API_KEY` and `ACCESS_KEY` when asked. Open the `onrender.com` URL (HTTPS, so it installs
as a PWA), then enter the same access key in Alpha's Settings.

Notes: the free plan sleeps after idle time and its disk is wiped on each deploy/restart, so files in
`workspace` are temporary (download what you need). A paid plan with a persistent disk mounted at
`/opt/render/project/src/workspace` keeps them. Never commit `.env`; it is already in `.gitignore`.

## Docker
```bash
cp .env.example .env     # set OPENROUTER_API_KEY and ACCESS_KEY (required in Docker)
docker compose up -d --build
```
Open http://localhost:3000. Generated files live in the `alpha-files` volume and survive restarts.
Logs: `docker compose logs -f`. Stop: `docker compose down`. Update: `git pull && docker compose up -d --build`.
The container includes Python 3, git, curl and zip, and runs as a non-root user. `render.yaml` now
deploys this same Dockerfile on Render.
