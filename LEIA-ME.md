# Aula ao vivo: funções afim e quadrática

Página de estudo com desenho em tempo real entre professor e aluno.
Roda numa VPS com Docker: um container PHP entrega a página e repassa os desenhos.
Quem recebe o subdomínio e cuida do HTTPS é o Traefik que já roda na VPS
(o mesmo que atende o n8n e o leads).

| Arquivo              | O que é                                                   |
|----------------------|-----------------------------------------------------------|
| `index.html`         | a página da aula                                          |
| `server.php`         | servidor da aula (PHP puro, sem bibliotecas)              |
| `Dockerfile`         | monta o container do PHP                                  |
| `docker-compose.yml` | sobe o PHP e avisa o Traefik qual subdomínio é dele       |
| `.env`               | o seu subdomínio                                          |

## 1. Aponte o subdomínio para a VPS

No hPanel da Hostinger: **Domínios → seu domínio → DNS / Nameservers**.

- Crie um registro **A**: nome `aula` (ou o que preferir), aponta para o **IP da VPS**, TTL 300.
- Se você já tinha criado esse subdomínio na hospedagem comum, apague o subdomínio de lá
  (ou o registro A antigo dele). Senão ele continua indo para o lugar errado.

Pode levar de alguns minutos a algumas horas para valer.

## 2. Baixe o projeto na VPS e suba os containers

No terminal da VPS (o terminal do navegador do hPanel serve):

```
git clone https://github.com/lucasPizzattoM/ajuda.git
cd ajuda
nano .env                 # troque aula.seudominio.com pelo seu subdomínio, Ctrl+O salva, Ctrl+X sai
docker compose up -d --build
```

Se o comando `docker` não existir, instale antes: `curl -fsSL https://get.docker.com | sh`

O HTTPS sai sozinho pelo Traefik (Let's Encrypt) assim que o DNS do subdomínio estiver
apontando para a VPS. Pode levar um minuto depois de subir.

## 3. Teste

- Abra `https://seu-subdominio/saude`. Tem que aparecer `ok`.
- Abra `https://seu-subdominio`, toque em **Ao vivo**, escreva seu nome e **Criar aula**.
- Toque em **Copiar** e mande o link para a outra pessoa. Ela abre, escreve o nome e toca em **Entrar**.

## Dia a dia

| Para…                         | Rode, dentro da pasta `ajuda`                             |
|-------------------------------|-----------------------------------------------------------|
| trazer mudanças do GitHub     | `git pull && docker compose up -d --build`                |
| ver quem entrou e saiu        | `docker compose logs -f app`                              |
| desligar                      | `docker compose down`                                     |
| ligar de novo                 | `docker compose up -d`                                    |

Os containers voltam sozinhos se a VPS reiniciar.

O `.env` da VPS tem o seu subdomínio. Não envie outro `.env` para o GitHub depois disso,
senão o `git pull` reclama que o arquivo foi mudado nos dois lugares.

## Problemas comuns

- **O site não abre com HTTPS logo depois de subir:** o Traefik só consegue o certificado depois
  que o DNS do subdomínio aponta para a VPS. Veja `docker logs traefik-traefik-1 --tail 30`.
- **Fica em "Sem conexão. Tentando de novo…":** confira se o app está rodando
  (`docker compose ps`) e veja `docker compose logs app`. A página tenta reconectar sozinha.
- **Qualquer pessoa pode entrar?** Só quem tiver o código de 5 letras da aula. Mande o link só
  para quem vai participar.
