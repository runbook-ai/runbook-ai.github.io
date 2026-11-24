# ---- Build stage not needed (zero npm deps) ----
FROM node:22-alpine

# Run as non-root for security
RUN addgroup -S proxy && adduser -S proxy -G proxy

WORKDIR /app

COPY package.json server.js relay.js ./

# No npm install — zero dependencies

USER proxy

EXPOSE 8082

ENV PORT=8082

CMD ["node", "server.js"]
