# Aula ao vivo: funções afim e quadrática

Página de estudo com desenho em tempo real entre professor e aluno.
Roda numa VPS com Docker: um container PHP entrega a página e repassa os desenhos,
e um container Caddy cuida do HTTPS do subdomínio.

```
aula-funcoes/
├── .env                 ← coloque aqui o seu subdomínio
├── docker-compose.yml
├── Caddyfile            ← HTTPS automático + encaminhamento para o app
└── app/
    ├── Dockerfile
    ├── server.php       ← servidor da aula (PHP puro, sem bibliotecas)
    └── public/
        └── index.html   ← a página
```

## 1. Aponte o subdomínio para a VPS

No hPanel da Hostinger: **Domínios → seu domínio → DNS / Nameservers**.

- Crie um registro **A**: nome `aula` (ou o que preferir), aponta para o **IP da VPS**, TTL 300.
- Se você já tinha criado esse subdomínio na hospedagem comum, apague o subdomínio de lá
  (ou o registro A antigo dele). Senão ele continua indo para o lugar errado.

Pode levar de alguns minutos a algumas horas para valer. Para conferir, no seu computador:

```
ping aula.seudominio.com
```

O IP que aparecer tem que ser o da VPS.

## 2. Mande os arquivos para a VPS

No seu computador (Windows, Mac ou Linux), na pasta onde está o arquivo baixado:

```
scp aula-funcoes.tar.gz root@IP_DA_VPS:/root/
```

## 3. Suba os containers

Entre na VPS (`ssh root@IP_DA_VPS`, ou o terminal do navegador no hPanel) e rode:

```
tar xzf aula-funcoes.tar.gz
cd aula-funcoes
nano .env                 # troque aula.seudominio.com pelo seu subdomínio, salve com Ctrl+O e saia com Ctrl+X
docker compose up -d --build
```

Se o comando `docker` não existir, instale antes:

```
curl -fsSL https://get.docker.com | sh
```

As portas **80** e **443** precisam estar liberadas. Se você ligou o firewall da VPS no hPanel,
libere as duas lá. Se usa `ufw` na VPS: `ufw allow 80,443/tcp`.

## 4. Teste

- Abra `https://aula.seudominio.com/saude`. Tem que aparecer `ok`.
- Abra `https://aula.seudominio.com`, toque em **Ao vivo**, escreva seu nome e **Criar aula**.
- Toque em **Copiar** e mande o link para a outra pessoa. Ela abre, escreve o nome e toca em **Entrar**.

## Dia a dia

| Para…                         | Rode, dentro da pasta `aula-funcoes`        |
|-------------------------------|---------------------------------------------|
| ver quem entrou e saiu        | `docker compose logs -f app`                |
| aplicar uma mudança na página | edite `app/public/index.html` e rode `docker compose up -d --build` |
| desligar                      | `docker compose down`                       |
| ligar de novo                 | `docker compose up -d`                      |

Os containers voltam sozinhos se a VPS reiniciar.

## Se a VPS já tem outro site nas portas 80 e 443

Aí o Caddy não consegue subir, porque as portas já têm dono. Nesse caso, rode só o app e
use o servidor web que já existe:

1. No `docker-compose.yml`, troque o `expose` do serviço `app` por:

   ```yaml
       ports:
         - "127.0.0.1:8080:8080"
   ```

2. Suba só o app: `docker compose up -d --build app`
3. No nginx que já existe, crie o site do subdomínio com:

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host;
   }
   location /ws {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_read_timeout 3600s;
   }
   ```

   e gere o HTTPS como você já faz para os outros sites (por exemplo, com `certbot --nginx`).

## Problemas comuns

- **O site não abre com HTTPS logo depois de subir:** o Caddy só consegue o certificado depois
  que o DNS do subdomínio aponta para a VPS. Confira com `ping` e veja `docker compose logs caddy`.
- **Fica em "Sem conexão. Tentando de novo…":** confira se o app está rodando
  (`docker compose ps`) e veja `docker compose logs app`. A página tenta reconectar sozinha.
- **Qualquer pessoa pode entrar?** Só quem tiver o código de 5 letras da aula. Mande o link só
  para quem vai participar.
