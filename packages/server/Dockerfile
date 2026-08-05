# Here so that "move the server to a VPS" is a build-and-run, not a project.
# Unused while the server lives on the Windows PC.
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
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

CMD ["npm", "run", "start", "-w", "@everything/server"]
