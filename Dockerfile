# Planning Poker - Node.js + Socket.IO server
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching).
# Copy package-lock.json too if it exists; use `npm install` since a
# lockfile may not be present in this repo.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the application source
COPY . .

ENV PORT=3000
EXPOSE 3000

# Basic health check against the app's /healthz endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz', res => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
