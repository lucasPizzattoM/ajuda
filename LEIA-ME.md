# Lousa ao vivo

Plataforma para dar aula em cima de documentos HTML: o professor abre uma aula da
biblioteca, todos desenham por cima ao mesmo tempo, e a rolagem, as respostas abertas e os
campos de cada documento ficam iguais em todos os aparelhos.

```
docker-compose.yml        sobe o app e avisa o Traefik qual subdomínio é dele
app/
├── Dockerfile
├── server.php            servidor (PHP puro): app, biblioteca, login e aula ao vivo
├── public/               o aplicativo
│   ├── index.html
│   ├── app.css
│   ├── app.js
│   ├── ponte.js          vai dentro de cada documento e conversa com o app
│   └── prompt-aula.txt   prompt padrão para criar aulas com o Claude
└── aulas/                entram na biblioteca uma vez cada (se apagar, não voltam)
    ├── funcoes.html      aula de funções afim e quadrática
    └── modelo.html       modelo de aula com todos os componentes
```

A biblioteca fica no volume `dados` do Docker. Ela não se perde com `git pull`, reinício ou
nova versão do app.

## Instalar ou atualizar na VPS

1. Coloque a senha de professor no `.env` da VPS (nunca no GitHub):

   ```
   nano .env
   ```

   e acrescente uma linha:

   ```
   SENHA_PROFESSOR=uma-senha-longa-que-so-voce-sabe
   ```

   Salve com Ctrl+O e saia com Ctrl+X. O arquivo fica com duas linhas: `DOMINIO=...` e `SENHA_PROFESSOR=...`.

2. Traga a versão nova e suba:

   ```
   git pull
   docker compose up -d --build
   ```

3. Abra o seu subdomínio. Na primeira vez, a biblioteca já vem com a aula de funções.

## Importar um documento

1. Toque em **Documentos** → **Importar ou apagar documentos** e digite a senha de professor.
   O login vale por 30 dias naquele navegador.
2. Toque em **Importar arquivo HTML** (ou arraste o arquivo) e escolha o `.html`.
3. Confira o título e escolha para que tela o documento foi pensado:
   - **Celular (430 px)**: páginas em uma coluna, como a aula de funções. Fica bom em todo aparelho.
   - **Tablet (768 px)** ou **Computador (1100 px)**: páginas mais largas. No celular aparecem menores.
4. Toque em **Importar**. O documento abre na hora. Se você estiver numa aula ao vivo, abre para todos.

No modo professor, cada documento da lista tem os botões de editar (título e largura) e apagar.

## Criar aulas com o Claude

1. Em **Documentos**, toque em **Criar aula com o Claude**.
2. Preencha matéria, tema, para quem e o modelo de aula (aula completa, revisão para prova,
   lista de exercícios, laboratório, linha do tempo, comparação, estudo de caso, leitura guiada,
   vocabulário, quiz ou outro que você escrever). O que ficar vazio vai entre colchetes.
3. Toque em **Copiar prompt** e cole numa conversa com o Claude.
4. Salve o arquivo `.html` que ele criar e importe em **Documentos**.

Com **Incluir o código do modelo** marcado (o padrão), o prompt leva junto o `modelo.html`, e todas
as aulas saem com o mesmo visual. **Ver o modelo** abre o modelo na Lousa e **Baixar o modelo**
salva o arquivo para editar à mão.

Para mudar o prompt de todo mundo, edite `app/public/prompt-aula.txt` e faça `git pull` na VPS.
Os campos são `{{MATERIA}}`, `{{TEMA}}`, `{{PUBLICO}}`, `{{MODELO}}` e `{{OBSERVACOES}}`.
Para mudar o visual padrão das aulas novas, edite `app/aulas/modelo.html`.

## Dar aula ao vivo

1. Abra o documento, toque em **Ao vivo**, escreva seu nome e **Criar aula**.
2. Toque em **Copiar** e mande o link. Quem entra recebe o documento, os desenhos e o que já foi aberto.
3. Para trocar de documento, use **Documentos**. Todos trocam juntos, e os desenhos de cada documento
   ficam guardados: voltando para um documento, eles reaparecem.

## Como fazer documentos que funcionam bem

Qualquer página HTML de um arquivo só funciona. O jeito mais fácil é partir do `modelo.html`
(ou do prompt, que já traz estas regras). Para ficar melhor ainda:

- **Um arquivo só.** Coloque CSS e JavaScript dentro do HTML. Imagens podem ir como `data:` ou
  vir de outro site por `https://`. Caminhos relativos (`img/foto.png`) não funcionam.
- **Página que rola.** Evite seções com `height: 100vh` e menus fixos: o app mostra a página inteira
  de uma vez e quem rola é o app.
- **Sincronizado sem fazer nada:** respostas em `<details>`, campos (`<input>`, sliders, `<select>`,
  caixas de marcar), botões (`<button>`) e links internos (`#parte2`).
- **Estado extra para quem entra no meio da aula (opcional).** Se o documento guarda algo que não
  está em campos (por exemplo, qual modo está escolhido), defina:

  ```js
  window.aulaEstado = {
    obter: function(){ return { modo: modoAtual }; },
    aplicar: function(estado){ trocarModo(estado.modo); }
  };
  ```

  A aula de funções (`app/aulas/funcoes.html`) usa isso no laboratório.

Os documentos rodam isolados: não conseguem ler o login de professor nem mexer no app.

## Dia a dia

| Para…                          | Rode, dentro da pasta do projeto            |
|--------------------------------|---------------------------------------------|
| atualizar a página do app      | `git pull` (vale na hora, é só recarregar)  |
| atualizar o `server.php`       | `git pull && docker compose restart app`    |
| atualizar o `Dockerfile`       | `git pull && docker compose up -d --build`  |
| ver quem entrou e o que foi importado | `docker compose logs -f app`         |
| trocar a senha de professor    | edite o `.env` e rode `docker compose up -d` |
| fazer cópia da biblioteca      | `docker compose cp app:/dados ./copia-biblioteca` |

Trocar a senha desconecta todos os logins de professor.

## Problemas comuns

- **"A importação está desligada":** falta `SENHA_PROFESSOR` no `.env`. Acrescente e rode `docker compose up -d`.
- **"Muitas tentativas erradas":** depois de 10 senhas erradas, aquele endereço espera 15 minutos.
- **"Não consegui salvar o arquivo no servidor":** o volume de dados não está montado.
  Confira com `docker compose config` se aparece `dados:/dados`.
- **Fica em "Sem conexão. Tentando de novo…":** veja `docker compose ps` e `docker compose logs app`.
  A página tenta reconectar sozinha.
- **O site não abre com HTTPS:** veja `docker logs traefik-traefik-1 --tail 30`.
