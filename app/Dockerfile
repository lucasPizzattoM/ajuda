FROM php:8.3-cli-alpine

WORKDIR /app
COPY server.php /app/server.php
COPY public /app/public
COPY aulas /app/aulas

# Pasta da biblioteca (vira um volume do Docker no docker-compose.yml)
RUN mkdir -p /dados && chown nobody:nobody /dados

ENV PORTA=8080 \
    DADOS=/dados \
    TZ=America/Sao_Paulo

EXPOSE 8080
USER nobody

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/saude || exit 1

CMD ["php", "/app/server.php"]
