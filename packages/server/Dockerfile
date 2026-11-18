# STALE: an image built from this does not run the app as it is today.
#
# It was written when the server was packages/shared and packages/server and
# nothing else, and has not been run since. What it leaves out:
#
#   - packages/modules/ (manga, voice, integrations, weather, trips, calendar,
#     blueprints, code, vault, push), which the server loads at boot;
#   - the built PWA (packages/web/dist), which the server serves;
#   - Suwayomi, which manga needs beside it as a container of its own.
#
# Kept as the starting point for the Docker goal in CLAUDE.md ("Where this is
# heading"), which lists the server code that still assumes Windows. Bring
# this up to date and run it before relying on it.
FROM node:24-slim

WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
RUN npm install --omit=dev --workspace @everything/server --include-workspace-root

COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# The database lives on a volume, not in the image.
VOLUME /data
ENV DATABASE_URL=file:/data/everything.db
# Every interface: a container is reached from outside it, never on loopback.
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

CMD ["npm", "run", "start", "-w", "@everything/server"]
