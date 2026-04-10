FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --production
COPY src/ ./src/
EXPOSE 7777
CMD ["bun", "run", "src/server.ts"]
