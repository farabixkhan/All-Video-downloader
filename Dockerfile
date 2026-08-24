FROM node:22-slim

# System deps: python3/pip for yt-dlp, ffmpeg for media validation/merging,
# unzip/curl for the Deno installer, git + canvas build deps for the
# optional YouTube PO-token provider below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg curl unzip git ca-certificates \
    build-essential pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
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

# OPTIONAL: YouTube PO-Token provider (bgutil-ytdlp-pot-provider, script
# mode). yt-dlp only calls this when its own logic decides a specific
# client/format actually requires a proof-of-origin token — normal public,
# no-cookie extraction is completely unaffected and always tried first.
# Best-effort: if this step fails for any reason (network hiccup, native
# `canvas` build issue, etc.) the build continues WITHOUT it rather than
# failing the whole deploy, since it's a fallback, not a requirement.
RUN ( git clone --depth 1 --branch 1.3.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /root/bgutil-ytdlp-pot-provider \
      && cd /root/bgutil-ytdlp-pot-provider/server \
      && npm ci \
      && npx tsc \
      && /opt/ytdlp-venv/bin/pip install --no-cache-dir bgutil-ytdlp-pot-provider ) \
    || echo "WARN: optional YouTube PO-token provider setup failed — continuing without it (public extraction is unaffected)"

WORKDIR /app

# Install with devDependencies included (NODE_ENV NOT set yet — setting it
# to "production" before `npm install` would make npm skip the
# typescript/tailwind/etc. devDependencies that the build step needs).
COPY package.json package-lock.json* ./
RUN npm install

# NOW switch to production — required for `next build` itself (an unset/
# non-standard NODE_ENV during the build step caused a build error in
# testing), and also correct for the runtime `next start`.
ENV NODE_ENV=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["sh", "-c", "npx next start -p ${PORT:-3000}"]
