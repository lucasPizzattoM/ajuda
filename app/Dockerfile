FROM php:8.3-cli-alpine

WORKDIR /app
COPY server.php /app/server.php
COPY public /app/public

ENV PORTA=8080 \
    TZ=America/Sao_Paulo

EXPOSE 8080
USER nobody

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/saude || exit 1

CMD ["php", "/app/server.php"]
