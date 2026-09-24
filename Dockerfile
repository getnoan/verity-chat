# verity-chat — the grounded site-chat service (serves its own embed at /widget.js)
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "site-web/server.mjs"]
