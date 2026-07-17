FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run gen

ENV STORAGE=sqlite \
    SQLITE_PATH=/data/tinker.db \
    PORT=8080
VOLUME /data
EXPOSE 8080

CMD ["bun", "server/server.ts"]
