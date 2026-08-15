FROM node:20-slim

# System deps: python3/pip for yt-dlp + curl_cffi, ffmpeg for media validation/merging
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp + curl_cffi (Chrome TLS impersonation) in an isolated venv to avoid
# Debian's externally-managed-environment restriction
RUN python3 -m venv /opt/ytdlp-venv \
    && /opt/ytdlp-venv/bin/pip install --no-cache-dir -U yt-dlp curl_cffi \
    && ln -s /opt/ytdlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "next start -p ${PORT:-3000}"]
