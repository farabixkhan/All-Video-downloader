FROM node:22-slim

# System deps: python3/pip for yt-dlp, ffmpeg for media validation/merging,
# unzip/curl for the Deno installer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Deno — yt-dlp's recommended JS runtime for solving modern YouTube
# JS challenges (EJS). Falls back gracefully if unavailable; Node 22+
# above is the secondary supported runtime.
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y \
    && ln -s /root/.deno/bin/deno /usr/local/bin/deno

# yt-dlp[default] (includes yt-dlp-ejs) + curl_cffi (Chrome TLS
# impersonation), in an isolated venv to avoid Debian's
# externally-managed-environment restriction.
RUN python3 -m venv /opt/ytdlp-venv \
    && /opt/ytdlp-venv/bin/pip install --no-cache-dir -U "yt-dlp[default]" curl_cffi \
    && ln -s /opt/ytdlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

# IMPORTANT: do NOT set NODE_ENV=production before `npm install` — that
# makes npm skip devDependencies (typescript/tailwind/etc.), which are
# required to build. Install first (default NODE_ENV in a fresh Docker
# build is unset/clean, so this is safe), THEN build, THEN switch to
# production only for the runtime `next start`.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "npx next start -p ${PORT:-3000}"]
