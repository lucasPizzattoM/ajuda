<?php
/*
 * Servidor da Lousa ao vivo.
 *
 * - Entrega o aplicativo (public/) e os documentos da biblioteca (/doc/ID).
 * - Guarda a biblioteca de documentos HTML em DADOS (um volume do Docker).
 * - Importar, editar e apagar documentos pede a senha SENHA_PROFESSOR.
 * - Repassa em tempo real, por WebSocket (/ws), os desenhos e cliques de quem está na mesma aula.
 *
 * Não precisa de nenhuma biblioteca: só PHP 8.1 ou mais novo (linha de comando).
 *
 *   SENHA_PROFESSOR=uma-senha-longa DADOS=/tmp/dados php server.php
 */
declare(strict_types=1);

const GUID_WS        = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MENSAGEM   = 1048576;   // 1 MB por mensagem ao vivo
const MAX_CABECALHO  = 16384;     // 16 KB de cabeçalho HTTP
const MAX_CORPO      = 20971520;  // 20 MB por documento importado
const MAX_SAIDA_WS   = 8388608;   // 8 MB esperando para sair numa conexão ao vivo
const MAX_CONEXOES   = 400;
const MAX_POR_SALA   = 30;
const MAX_DOCS       = 300;
const LIMITE_MSGS    = 1500;      // mensagens ao vivo por pessoa a cada JANELA segundos
const JANELA         = 10;
const PING_A_CADA    = 25;        // segundos
const TIMEOUT_WS     = 75;        // conexão ao vivo sem notícias por esse tempo é fechada
const TIMEOUT_HTTP   = 30;
const TOKEN_DIAS     = 30;        // por quanto tempo o login de professor vale
const MAX_FALHAS     = 10;        // senhas erradas por IP a cada JANELA_FALHAS segundos
const JANELA_FALHAS  = 900;
const LARGURA_PADRAO = 430;

final class Servidor
{
    /** @var resource */
    private $servidor;
    /** @var array<int, array<string, mixed>> */
    private array $c = [];
    /** @var array<string, array<int, true>> */
    private array $salas = [];
    /** @var array<string, int[]> */
    private array $falhas = [];
    private float $ultimaManutencao = 0.0;

    public function __construct(
        private int $porta,
        private string $publico,
        private string $aulas,
        private string $dados,
        private string $senha
    ) {
    }

    public function rodar(): void
    {
        $this->prepararBiblioteca();
        $ctx = stream_context_create(['socket' => ['backlog' => 128, 'tcp_nodelay' => true]]);
        $s = @stream_socket_server("tcp://0.0.0.0:{$this->porta}", $errno, $errstr,
            STREAM_SERVER_BIND | STREAM_SERVER_LISTEN, $ctx);
        if (!$s) {
            $this->log("Não consegui abrir a porta {$this->porta}: $errstr");
            exit(1);
        }
        stream_set_blocking($s, false);
        $this->servidor = $s;
        $this->log("Lousa ao vivo rodando na porta {$this->porta}");
        if ($this->senha === '') {
            $this->log('Aviso: SENHA_PROFESSOR não foi definida. Importar documentos está desligado.');
        } elseif (strlen($this->senha) < 8) {
            $this->log('Aviso: SENHA_PROFESSOR tem menos de 8 caracteres. Use uma senha mais longa.');
        }
        while (true) {
            $this->volta();
        }
    }

    private function volta(): void
    {
        $ler = [$this->servidor];
        $escrever = [];
        foreach ($this->c as $cl) {
            $ler[] = $cl['sock'];
            if ($cl['out'] !== '') {
                $escrever[] = $cl['sock'];
            }
        }
        $exc = null;
        $n = @stream_select($ler, $escrever, $exc, 1, 0);
        if ($n === false) {
            usleep(20000);
        } else {
            foreach ($ler as $s) {
                if ($s === $this->servidor) {
                    $this->aceitar();
                    continue;
                }
                $k = get_resource_id($s);
                if (!isset($this->c[$k])) {
                    continue;
                }
                $dados = @fread($s, 65536);
                if ($dados === false || ($dados === '' && feof($s))) {
                    $this->desconectar($k);
                    continue;
                }
                if ($dados === '') {
                    continue;
                }
                $this->c[$k]['in'] .= $dados;
                $this->c[$k]['visto'] = microtime(true);
                if ($this->c[$k]['ws']) {
                    $this->lerFrames($k);
                } elseif (!$this->c[$k]['fechar']) {
                    $this->lerHttp($k);
                }
            }
            foreach ($escrever as $s) {
                $k = get_resource_id($s);
                if (isset($this->c[$k])) {
                    $this->escrever($k);
                }
            }
        }
        $agora = microtime(true);
        if ($agora - $this->ultimaManutencao >= 1.0) {
            $this->ultimaManutencao = $agora;
            $this->manutencao($agora);
        }
    }

    private function aceitar(): void
    {
        for ($i = 0; $i < 32; $i++) {
            $s = @stream_socket_accept($this->servidor, 0, $peer);
            if (!$s) {
                return;
            }
            if (count($this->c) >= MAX_CONEXOES) {
                @fclose($s);
                continue;
            }
            stream_set_blocking($s, false);
            $agora = microtime(true);
            $this->c[get_resource_id($s)] = [
                'sock' => $s, 'in' => '', 'out' => '', 'ws' => false, 'fechar' => false, 'req' => null,
                'peer' => (string) preg_replace('/:\d+$/', '', (string) $peer),
                'frag' => null, 'sala' => null, 'id' => null, 'nome' => '', 'papel' => 'aluno',
                'visto' => $agora, 'ping' => $agora, 'janela' => $agora, 'qtd' => 0,
            ];
        }
    }

    /* ------------------------------ HTTP ------------------------------ */

    private function lerHttp(int $k): void
    {
        if ($this->c[$k]['req'] === null) {
            $buf = $this->c[$k]['in'];
            $fim = strpos($buf, "\r\n\r\n");
            if ($fim === false) {
                if (strlen($buf) > MAX_CABECALHO) {
                    $this->responderTexto($k, 431, 'Cabeçalho grande demais');
                }
                return;
            }
            $this->c[$k]['in'] = (string) substr($buf, $fim + 4);
            $linhas = explode("\r\n", substr($buf, 0, $fim));
            $req = explode(' ', (string) array_shift($linhas));
            if (count($req) < 3) {
                $this->responderTexto($k, 400, 'Pedido inválido');
                return;
            }
            $h = [];
            foreach ($linhas as $l) {
                $p = strpos($l, ':');
                if ($p) {
                    $h[strtolower(trim(substr($l, 0, $p)))] = trim(substr($l, $p + 1));
                }
            }
            $caminho = (string) (parse_url($req[1], PHP_URL_PATH) ?: '/');
            if ($caminho === '/ws') {
                $this->aceitarWs($k, $h);
                return;
            }
            if (isset($h['transfer-encoding'])) {
                $this->responderJson($k, 411, ['erro' => 'Envie o arquivo com Content-Length.']);
                return;
            }
            $tam = (int) ($h['content-length'] ?? 0);
            if ($tam < 0 || $tam > MAX_CORPO) {
                $this->responderJson($k, 413, ['erro' => 'O arquivo passa de 20 MB.']);
                return;
            }
            $this->c[$k]['req'] = ['metodo' => strtoupper($req[0]), 'caminho' => $caminho, 'h' => $h, 'tam' => $tam];
        }
        $req = $this->c[$k]['req'];
        if (strlen($this->c[$k]['in']) < $req['tam']) {
            return;
        }
        $corpo = (string) substr($this->c[$k]['in'], 0, $req['tam']);
        $this->c[$k]['in'] = '';
        $this->rotear($k, $req['metodo'], $req['caminho'], $req['h'], $corpo);
    }

    /** @param array<string, string> $h */
    private function rotear(int $k, string $m, string $p, array $h, string $corpo): void
    {
        $leitura = $m === 'GET' || $m === 'HEAD';
        $soCab = $m === 'HEAD';

        if ($p === '/' || $p === '/index.html') {
            $leitura ? $this->servirArquivo($k, 'index.html', $soCab) : $this->metodoErrado($k);
            return;
        }
        if (preg_match('#^/([a-z0-9-]+\.(?:js|css|txt|svg|png|ico|webp))$#', $p, $mm) && is_file($this->publico . '/' . $mm[1])) {
            $leitura ? $this->servirArquivo($k, $mm[1], $soCab) : $this->metodoErrado($k);
            return;
        }
        if ($p === '/modelo.html') {
            $leitura ? $this->servirModelo($k, $soCab) : $this->metodoErrado($k);
            return;
        }
        if ($p === '/saude') {
            $this->responderTexto($k, 200, "ok\n", $soCab);
            return;
        }
        if (preg_match('#^/doc/([a-z0-9]{10})$#', $p, $mm)) {
            $leitura ? $this->servirDoc($k, $mm[1], $soCab) : $this->metodoErrado($k);
            return;
        }
        if ($p === '/api/docs') {
            if ($m === 'GET') {
                $this->responderJson($k, 200, ['docs' => $this->lerBiblioteca()]);
            } elseif ($m === 'POST') {
                $this->importar($k, $h, $corpo);
            } else {
                $this->metodoErrado($k);
            }
            return;
        }
        if (preg_match('#^/api/docs/([a-z0-9]{10})$#', $p, $mm)) {
            if ($m === 'POST') {
                $this->editar($k, $h, $mm[1], $corpo);
            } elseif ($m === 'DELETE') {
                $this->apagar($k, $h, $mm[1]);
            } else {
                $this->metodoErrado($k);
            }
            return;
        }
        if ($p === '/api/login') {
            $m === 'POST' ? $this->login($k, $h, $corpo) : $this->metodoErrado($k);
            return;
        }
        if ($p === '/api/sessao') {
            if ($this->autorizado($h)) {
                $this->responderJson($k, 200, ['ok' => true]);
            } else {
                $this->responderJson($k, 401, ['erro' => 'Sessão de professor expirada.']);
            }
            return;
        }
        $this->responderTexto($k, 404, 'Não encontrado', $soCab);
    }

    private function servirArquivo(int $k, string $nome, bool $soCab): void
    {
        $tipos = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8',
            'css' => 'text/css; charset=utf-8', 'txt' => 'text/plain; charset=utf-8', 'svg' => 'image/svg+xml', 'png' => 'image/png',
            'ico' => 'image/x-icon', 'webp' => 'image/webp'];
        $conteudo = @file_get_contents($this->publico . '/' . $nome);
        if ($conteudo === false) {
            $this->responderTexto($k, 500, 'Arquivo não encontrado no servidor');
            return;
        }
        $ext = (string) pathinfo($nome, PATHINFO_EXTENSION);
        $this->responder($k, 200, $tipos[$ext] ?? 'application/octet-stream', $conteudo, $soCab);
    }

    /* O modelo de aula, para baixar ou anexar ao prompt. */
    private function servirModelo(int $k, bool $soCab): void
    {
        $html = @file_get_contents($this->aulas . '/modelo.html');
        if ($html === false) {
            $this->responderTexto($k, 404, 'Modelo não encontrado', $soCab);
            return;
        }
        $this->responder($k, 200, 'text/html; charset=utf-8', $html, $soCab, [
            'Content-Disposition' => 'attachment; filename="modelo-de-aula.html"',
            'Content-Security-Policy' => 'sandbox allow-scripts',
        ]);
    }

    private function servirDoc(int $k, string $id, bool $soCab): void
    {
        $html = @file_get_contents($this->arquivoDoc($id));
        $codigo = 200;
        if ($html === false) {
            $codigo = 404;
            $html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Documento não encontrado</title></head>'
                . '<body style="font:16px/1.5 system-ui,sans-serif;padding:2rem;margin:0">'
                . '<h1 style="font-size:1.4rem">Esse documento não existe mais.</h1>'
                . '<p>Ele pode ter sido apagado da biblioteca. Escolha outro em Documentos.</p></body></html>';
        }
        $temCharset = (bool) preg_match('/<meta[^>]+charset/i', substr($html, 0, 4096));
        $this->responder($k, $codigo, 'text/html' . ($temCharset ? '' : '; charset=utf-8'), $this->injetarPonte($html), $soCab, [
            /* O documento roda isolado: não enxerga o login nem os dados do aplicativo. */
            'Content-Security-Policy' => 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals',
        ]);
    }

    private function injetarPonte(string $html): string
    {
        $tag = '<script src="/ponte.js"></script>';
        foreach (['/<head\b[^>]*>/i', '/<html\b[^>]*>/i'] as $re) {
            if (preg_match($re, $html, $m, PREG_OFFSET_CAPTURE)) {
                $pos = $m[0][1] + strlen($m[0][0]);
                return substr($html, 0, $pos) . $tag . substr($html, $pos);
            }
        }
        if (preg_match('/^\s*<!doctype[^>]*>/i', $html, $m)) {
            return $m[0] . $tag . substr($html, strlen($m[0]));
        }
        return $tag . $html;
    }

    private function metodoErrado(int $k): void
    {
        $this->responderJson($k, 405, ['erro' => 'Método não permitido']);
    }

    private function responderTexto(int $k, int $codigo, string $texto, bool $soCab = false): void
    {
        $this->responder($k, $codigo, 'text/plain; charset=utf-8', $texto, $soCab);
    }

    /** @param array<string, mixed> $dados */
    private function responderJson(int $k, int $codigo, array $dados): void
    {
        $json = json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $this->responder($k, $codigo, 'application/json; charset=utf-8', $json === false ? '{}' : $json);
    }

    /** @param array<string, string> $extra */
    private function responder(int $k, int $codigo, string $tipo, string $corpo, bool $soCab = false, array $extra = []): void
    {
        $textos = [200 => 'OK', 201 => 'Created', 400 => 'Bad Request', 401 => 'Unauthorized', 403 => 'Forbidden',
            404 => 'Not Found', 405 => 'Method Not Allowed', 411 => 'Length Required', 413 => 'Payload Too Large',
            429 => 'Too Many Requests', 431 => 'Request Header Fields Too Large', 500 => 'Internal Server Error',
            503 => 'Service Unavailable'];
        $r = "HTTP/1.1 $codigo " . ($textos[$codigo] ?? 'OK') . "\r\n"
            . "Content-Type: $tipo\r\n"
            . 'Content-Length: ' . strlen($corpo) . "\r\n"
            . "Cache-Control: no-cache\r\n"
            . "X-Content-Type-Options: nosniff\r\n"
            . "Referrer-Policy: same-origin\r\n";
        foreach ($extra as $nome => $valor) {
            $r .= "$nome: $valor\r\n";
        }
        $r .= "Connection: close\r\n\r\n" . ($soCab ? '' : $corpo);
        $this->c[$k]['fechar'] = true;
        $this->enfileirar($k, $r);
    }

    /* --------------------------- biblioteca --------------------------- */

    private function arquivoDoc(string $id): string
    {
        return $this->dados . '/docs/' . $id . '.html';
    }

    private function prepararBiblioteca(): void
    {
        $pasta = $this->dados . '/docs';
        if (!is_dir($pasta) && !@mkdir($pasta, 0775, true)) {
            $this->log("Não consegui criar a pasta $pasta. Confira o volume de dados.");
            return;
        }
        /* As aulas que vêm com o aplicativo (pasta aulas/) entram na biblioteca uma vez cada.
           Se você apagar uma delas, ela não volta. */
        $existia = is_file($this->dados . '/biblioteca.json');
        $arqSemeados = $this->dados . '/semeados.json';
        $semeados = json_decode((string) @file_get_contents($arqSemeados), true);
        if (!is_array($semeados)) {
            /* Instalações da versão anterior já tinham recebido a aula de funções. */
            $semeados = $existia ? ['funcoes.html'] : [];
        }
        $lista = $existia ? $this->lerBiblioteca() : [];
        $novos = 0;
        foreach (glob($this->aulas . '/*.html') ?: [] as $arq) {
            $nome = basename($arq);
            if (in_array($nome, $semeados, true)) {
                continue;
            }
            $html = (string) file_get_contents($arq);
            $id = $this->novoId();
            if (@file_put_contents($this->arquivoDoc($id), $html) === false) {
                continue;
            }
            $lista[] = ['id' => $id, 'titulo' => $this->tituloDe($html, basename($arq, '.html')),
                'largura' => LARGURA_PADRAO, 'tamanho' => strlen($html), 'criado' => time(), 'origem' => $nome];
            $semeados[] = $nome;
            $novos++;
        }
        if (($novos > 0 || !$existia) && $this->salvarBiblioteca($lista)) {
            $this->log($existia ? "Biblioteca: $novos aula(s) nova(s) do aplicativo." : 'Biblioteca criada com ' . count($lista) . ' documento(s).');
        }
        @file_put_contents($arqSemeados, json_encode(array_values($semeados)));
    }

    /** @return array<int, array<string, mixed>> */
    private function lerBiblioteca(): array
    {
        $j = @file_get_contents($this->dados . '/biblioteca.json');
        $lista = $j === false ? [] : json_decode($j, true);
        if (!is_array($lista)) {
            return [];
        }
        return array_values(array_filter($lista, fn($d) => is_array($d) && isset($d['id'])
            && is_string($d['id']) && preg_match('/^[a-z0-9]{10}$/', $d['id'])));
    }

    /** @param array<int, array<string, mixed>> $lista */
    private function salvarBiblioteca(array $lista): bool
    {
        $arq = $this->dados . '/biblioteca.json';
        $tmp = $arq . '.tmp';
        $json = json_encode(array_values($lista), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        if ($json === false || @file_put_contents($tmp, $json) === false || !@rename($tmp, $arq)) {
            $this->log("Não consegui gravar $arq");
            return false;
        }
        return true;
    }

    /** @param array<string, string> $h */
    private function importar(int $k, array $h, string $corpo): void
    {
        if (!$this->exigirLogin($k, $h)) {
            return;
        }
        if (trim($corpo) === '') {
            $this->responderJson($k, 400, ['erro' => 'O arquivo está vazio.']);
            return;
        }
        $lista = $this->lerBiblioteca();
        if (count($lista) >= MAX_DOCS) {
            $this->responderJson($k, 400, ['erro' => 'A biblioteca chegou a ' . MAX_DOCS . ' documentos. Apague alguns antes de importar.']);
            return;
        }
        $titulo = $this->limparTexto(rawurldecode($h['x-titulo'] ?? ''), 120);
        if ($titulo === '') {
            $titulo = $this->tituloDe($corpo, 'Documento sem título');
        }
        $doc = ['id' => $this->novoId(), 'titulo' => $titulo, 'largura' => $this->limparLargura($h['x-largura'] ?? null),
            'tamanho' => strlen($corpo), 'criado' => time()];
        if (@file_put_contents($this->arquivoDoc($doc['id']), $corpo) === false) {
            $this->responderJson($k, 500, ['erro' => 'Não consegui salvar o arquivo no servidor. Confira o volume de dados.']);
            return;
        }
        array_unshift($lista, $doc);
        if (!$this->salvarBiblioteca($lista)) {
            @unlink($this->arquivoDoc($doc['id']));
            $this->responderJson($k, 500, ['erro' => 'Não consegui atualizar a biblioteca no servidor.']);
            return;
        }
        $this->log("Documento importado: {$doc['titulo']} ({$doc['id']}, " . round($doc['tamanho'] / 1024) . ' KB)');
        $this->responderJson($k, 201, ['doc' => $doc]);
    }

    /** @param array<string, string> $h */
    private function editar(int $k, array $h, string $id, string $corpo): void
    {
        if (!$this->exigirLogin($k, $h)) {
            return;
        }
        $d = json_decode($corpo, true);
        if (!is_array($d)) {
            $this->responderJson($k, 400, ['erro' => 'Pedido inválido.']);
            return;
        }
        $lista = $this->lerBiblioteca();
        foreach ($lista as $i => $doc) {
            if ($doc['id'] !== $id) {
                continue;
            }
            if (isset($d['titulo'])) {
                $t = $this->limparTexto((string) $d['titulo'], 120);
                if ($t === '') {
                    $this->responderJson($k, 400, ['erro' => 'Dê um título para o documento.']);
                    return;
                }
                $lista[$i]['titulo'] = $t;
            }
            if (isset($d['largura'])) {
                $lista[$i]['largura'] = $this->limparLargura($d['largura']);
            }
            if (!$this->salvarBiblioteca($lista)) {
                $this->responderJson($k, 500, ['erro' => 'Não consegui atualizar a biblioteca no servidor.']);
                return;
            }
            $this->responderJson($k, 200, ['doc' => $lista[$i]]);
            return;
        }
        $this->responderJson($k, 404, ['erro' => 'Esse documento não existe mais.']);
    }

    /** @param array<string, string> $h */
    private function apagar(int $k, array $h, string $id): void
    {
        if (!$this->exigirLogin($k, $h)) {
            return;
        }
        $lista = $this->lerBiblioteca();
        $nova = array_values(array_filter($lista, fn($d) => $d['id'] !== $id));
        if (count($nova) === count($lista)) {
            $this->responderJson($k, 404, ['erro' => 'Esse documento não existe mais.']);
            return;
        }
        if (!$this->salvarBiblioteca($nova)) {
            $this->responderJson($k, 500, ['erro' => 'Não consegui atualizar a biblioteca no servidor.']);
            return;
        }
        @unlink($this->arquivoDoc($id));
        $this->log("Documento apagado: $id");
        $this->responderJson($k, 200, ['ok' => true]);
    }

    private function tituloDe(string $html, string $padrao): string
    {
        if (preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $m)) {
            $t = $this->limparTexto(html_entity_decode(strip_tags($m[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8'), 120);
            if ($t !== '') {
                return $t;
            }
        }
        return $this->limparTexto($padrao, 120) ?: 'Documento sem título';
    }

    private function limparTexto(string $t, int $max): string
    {
        if (!preg_match('//u', $t)) {          // não é UTF-8 válido: trata como Latin-1
            $t = function_exists('mb_convert_encoding') ? (string) mb_convert_encoding($t, 'UTF-8', 'ISO-8859-1') : '';
        }
        $t = trim((string) preg_replace('/\s+/u', ' ', (string) preg_replace('/[\x00-\x1F\x7F]/u', ' ', $t)));
        preg_match('/^.{0,' . $max . '}/us', $t, $m);
        return trim($m[0] ?? '');
    }

    private function limparLargura(mixed $v): int
    {
        $n = (int) $v;
        return $n >= 320 && $n <= 1600 ? $n : LARGURA_PADRAO;
    }

    private function novoId(): string
    {
        $abc = 'abcdefghijkmnpqrstuvwxyz23456789';
        do {
            $id = '';
            for ($i = 0; $i < 10; $i++) {
                $id .= $abc[random_int(0, strlen($abc) - 1)];
            }
        } while (is_file($this->arquivoDoc($id)));
        return $id;
    }

    /* ------------------------- login do professor ------------------------- */

    /** @param array<string, string> $h */
    private function login(int $k, array $h, string $corpo): void
    {
        if ($this->senha === '') {
            $this->responderJson($k, 503, ['erro' => 'A importação está desligada. Defina SENHA_PROFESSOR no arquivo .env da VPS e reinicie.']);
            return;
        }
        $ip = $this->ipDe($k, $h);
        $agora = time();
        $this->falhas[$ip] = array_values(array_filter($this->falhas[$ip] ?? [], fn($t) => $agora - $t < JANELA_FALHAS));
        if (count($this->falhas[$ip]) >= MAX_FALHAS) {
            $this->responderJson($k, 429, ['erro' => 'Muitas tentativas erradas. Espere 15 minutos e tente de novo.']);
            return;
        }
        $d = json_decode($corpo, true);
        $senha = is_array($d) && is_string($d['senha'] ?? null) ? $d['senha'] : '';
        if (!hash_equals($this->senha, $senha)) {
            $this->falhas[$ip][] = $agora;
            $this->log("Senha de professor errada ($ip)");
            $this->responderJson($k, 401, ['erro' => 'Senha incorreta.']);
            return;
        }
        unset($this->falhas[$ip]);
        $exp = $agora + TOKEN_DIAS * 86400;
        $this->responderJson($k, 200, ['token' => $exp . '.' . hash_hmac('sha256', 'aula:' . $exp, $this->senha)]);
    }

    /** @param array<string, string> $h */
    private function autorizado(array $h): bool
    {
        if ($this->senha === '') {
            return false;
        }
        if (!preg_match('/^Bearer\s+(\d{9,12})\.([a-f0-9]{64})$/', $h['authorization'] ?? '', $m)) {
            return false;
        }
        return (int) $m[1] >= time() && hash_equals(hash_hmac('sha256', 'aula:' . $m[1], $this->senha), $m[2]);
    }

    /** @param array<string, string> $h */
    private function exigirLogin(int $k, array $h): bool
    {
        if ($this->autorizado($h)) {
            return true;
        }
        $this->responderJson($k, 401, ['erro' => 'Entre com a senha de professor para mexer na biblioteca.']);
        return false;
    }

    /** @param array<string, string> $h */
    private function ipDe(int $k, array $h): string
    {
        $xff = trim(explode(',', $h['x-forwarded-for'] ?? '')[0]);
        return $xff !== '' ? substr($xff, 0, 64) : (string) $this->c[$k]['peer'];
    }

    /* ---------------------------- WebSocket ---------------------------- */

    /** @param array<string, string> $h */
    private function aceitarWs(int $k, array $h): void
    {
        $chave = $h['sec-websocket-key'] ?? '';
        if (strtolower($h['upgrade'] ?? '') !== 'websocket' || $chave === ''
            || ($h['sec-websocket-version'] ?? '') !== '13') {
            $this->responderTexto($k, 400, 'Esperava uma conexão WebSocket');
            return;
        }
        /* Só aceita conexões vindas da própria página (mesmo endereço). */
        $origem = $h['origin'] ?? '';
        if ($origem !== '') {
            $hostOrigem = strtolower((string) parse_url($origem, PHP_URL_HOST));
            $hostPedido = strtolower((string) preg_replace('/:\d+$/', '', $h['host'] ?? ''));
            if ($hostOrigem !== $hostPedido) {
                $this->responderTexto($k, 403, 'Origem não permitida');
                return;
            }
        }
        $aceite = base64_encode(sha1($chave . GUID_WS, true));
        $this->enfileirar($k, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
            . "Connection: Upgrade\r\nSec-WebSocket-Accept: $aceite\r\n\r\n");
        if (!isset($this->c[$k])) {
            return;
        }
        $this->c[$k]['ws'] = true;
        if ($this->c[$k]['in'] !== '') {
            $this->lerFrames($k);
        }
    }

    private function lerFrames(int $k): void
    {
        while (isset($this->c[$k]) && !$this->c[$k]['fechar']) {
            $b = $this->c[$k]['in'];
            $tam = strlen($b);
            if ($tam < 2) {
                return;
            }
            $b0 = ord($b[0]);
            $b1 = ord($b[1]);
            $fin = ($b0 & 0x80) !== 0;
            $op = $b0 & 0x0F;
            $pl = $b1 & 0x7F;
            $pos = 2;
            if (($b0 & 0x70) !== 0 || ($b1 & 0x80) === 0) {
                $this->fecharWs($k, 1002);   // bits reservados ou mensagem sem máscara
                return;
            }
            if ($pl === 126) {
                if ($tam < 4) {
                    return;
                }
                $pl = unpack('n', substr($b, 2, 2))[1];
                $pos = 4;
            } elseif ($pl === 127) {
                if ($tam < 10) {
                    return;
                }
                $pl = unpack('J', substr($b, 2, 8))[1];
                $pos = 10;
            }
            if ($pl < 0 || $pl > MAX_MENSAGEM) {
                $this->fecharWs($k, 1009);
                return;
            }
            if ($tam < $pos + 4 + $pl) {
                return;
            }
            $mascara = substr($b, $pos, 4);
            $dados = (string) substr($b, $pos + 4, $pl);
            $this->c[$k]['in'] = (string) substr($b, $pos + 4 + $pl);
            if ($pl > 0) {
                $dados ^= substr(str_repeat($mascara, intdiv($pl, 4) + 1), 0, $pl);
            }

            switch ($op) {
                case 0x8: // fechar
                    $this->sairDaSala($k);
                    $this->fecharWs($k, strlen($dados) >= 2 ? unpack('n', substr($dados, 0, 2))[1] : 1000);
                    return;
                case 0x9: // ping
                    $this->enfileirar($k, $this->frame($dados, 0xA));
                    break;
                case 0xA: // pong
                    break;
                case 0x1: // texto
                    if ($this->c[$k]['frag'] !== null) {
                        $this->fecharWs($k, 1002);
                        return;
                    }
                    if ($fin) {
                        $this->texto($k, $dados);
                    } else {
                        $this->c[$k]['frag'] = $dados;
                    }
                    break;
                case 0x0: // continuação
                    if ($this->c[$k]['frag'] === null) {
                        $this->fecharWs($k, 1002);
                        return;
                    }
                    $this->c[$k]['frag'] .= $dados;
                    if (strlen($this->c[$k]['frag']) > MAX_MENSAGEM) {
                        $this->fecharWs($k, 1009);
                        return;
                    }
                    if ($fin) {
                        $txt = $this->c[$k]['frag'];
                        $this->c[$k]['frag'] = null;
                        $this->texto($k, $txt);
                    }
                    break;
                default: // binário e outros: não usamos
                    $this->fecharWs($k, 1003);
                    return;
            }
        }
    }

    private function frame(string $dados, int $op = 0x1): string
    {
        $n = strlen($dados);
        $cab = chr(0x80 | $op);
        if ($n < 126) {
            $cab .= chr($n);
        } elseif ($n < 65536) {
            $cab .= chr(126) . pack('n', $n);
        } else {
            $cab .= chr(127) . pack('J', $n);
        }
        return $cab . $dados;
    }

    private function fecharWs(int $k, int $codigo): void
    {
        if (!isset($this->c[$k])) {
            return;
        }
        $this->enfileirar($k, $this->frame(pack('n', $codigo), 0x8));
        if (isset($this->c[$k])) {
            $this->c[$k]['fechar'] = true;
            if ($this->c[$k]['out'] === '') {
                $this->desconectar($k);
            }
        }
    }

    /* ------------------------------ salas ------------------------------ */

    private function texto(int $k, string $txt): void
    {
        $d = json_decode($txt, false, 64);
        if (!($d instanceof stdClass) || !isset($d->tipo) || !is_string($d->tipo)) {
            return;
        }
        switch ($d->tipo) {
            case 'pulso':
                $this->enviarJson($k, ['tipo' => 'pulso']);
                return;
            case 'entrar':
                $this->entrar($k, $d);
                return;
            case 'msg':
                $sala = $this->c[$k]['sala'];
                if ($sala === null || !isset($d->m) || !($d->m instanceof stdClass) || !$this->dentroDoLimite($k)) {
                    return;
                }
                $json = json_encode(['tipo' => 'msg', 'm' => $d->m], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if ($json !== false) {
                    $this->paraSala($sala, $json, $k);
                }
                return;
        }
    }

    private function entrar(int $k, stdClass $d): void
    {
        $sala = is_string($d->sala ?? null) ? $d->sala : '';
        $id = is_string($d->id ?? null) ? $d->id : '';
        if (!preg_match('/^[A-Z0-9]{5}$/', $sala) || !preg_match('/^[a-z0-9]{6,16}$/', $id)) {
            $this->enviarJson($k, ['tipo' => 'erro', 'texto' => 'Código de aula inválido.']);
            return;
        }
        if ($this->c[$k]['sala'] !== null) {
            $this->sairDaSala($k);
        }
        /* A mesma pessoa reconectando: a conexão antiga sai. */
        foreach (array_keys($this->salas[$sala] ?? []) as $outro) {
            if ($outro !== $k && isset($this->c[$outro]) && $this->c[$outro]['id'] === $id) {
                $this->desconectar($outro);
            }
        }
        if (count($this->salas[$sala] ?? []) >= MAX_POR_SALA) {
            $this->enviarJson($k, ['tipo' => 'erro', 'texto' => 'Essa aula já está cheia.']);
            return;
        }
        $this->c[$k]['sala'] = $sala;
        $this->c[$k]['id'] = $id;
        $this->c[$k]['nome'] = $this->limparNome($d->nome ?? '');
        $this->c[$k]['papel'] = (($d->papel ?? '') === 'professor') ? 'professor' : 'aluno';
        $this->salas[$sala][$k] = true;
        $this->log("{$this->c[$k]['nome']} entrou na sala $sala ({$this->c[$k]['papel']}), "
            . count($this->salas[$sala]) . ' na sala');
        $this->avisarPessoas($sala);
    }

    private function sairDaSala(int $k): void
    {
        $sala = $this->c[$k]['sala'] ?? null;
        if ($sala === null) {
            return;
        }
        $this->c[$k]['sala'] = null;
        unset($this->salas[$sala][$k]);
        $this->log("{$this->c[$k]['nome']} saiu da sala $sala");
        if (empty($this->salas[$sala])) {
            unset($this->salas[$sala]);
        } else {
            $this->avisarPessoas($sala);
        }
    }

    private function avisarPessoas(string $sala): void
    {
        $lista = [];
        foreach (array_keys($this->salas[$sala] ?? []) as $k) {
            if (isset($this->c[$k])) {
                $lista[] = ['id' => $this->c[$k]['id'], 'nome' => $this->c[$k]['nome'], 'papel' => $this->c[$k]['papel']];
            }
        }
        $json = json_encode(['tipo' => 'pessoas', 'lista' => $lista], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json !== false) {
            $this->paraSala($sala, $json, null);
        }
    }

    private function paraSala(string $sala, string $json, ?int $exceto): void
    {
        $f = $this->frame($json);
        foreach (array_keys($this->salas[$sala] ?? []) as $k) {
            if ($k !== $exceto) {
                $this->enfileirar($k, $f);
            }
        }
    }

    /** @param array<string, mixed> $dados */
    private function enviarJson(int $k, array $dados): void
    {
        $json = json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json !== false) {
            $this->enfileirar($k, $this->frame($json));
        }
    }

    private function dentroDoLimite(int $k): bool
    {
        $agora = microtime(true);
        if ($agora - $this->c[$k]['janela'] > JANELA) {
            $this->c[$k]['janela'] = $agora;
            $this->c[$k]['qtd'] = 0;
        }
        return ++$this->c[$k]['qtd'] <= LIMITE_MSGS;
    }

    private function limparNome(mixed $nome): string
    {
        $nome = $this->limparTexto(is_string($nome) ? $nome : '', 20);
        return $nome !== '' ? $nome : 'Visitante';
    }

    /* ----------------------------- conexões ----------------------------- */

    private function enfileirar(int $k, string $bytes): void
    {
        if (!isset($this->c[$k])) {
            return;
        }
        $this->c[$k]['out'] .= $bytes;
        if ($this->c[$k]['ws'] && strlen($this->c[$k]['out']) > MAX_SAIDA_WS) {
            $this->desconectar($k);
            return;
        }
        $this->escrever($k);
    }

    private function escrever(int $k): void
    {
        $out = $this->c[$k]['out'];
        if ($out !== '') {
            $n = @fwrite($this->c[$k]['sock'], $out);
            if ($n === false) {
                $this->desconectar($k);
                return;
            }
            if ($n > 0) {
                $this->c[$k]['visto'] = microtime(true);
            }
            $this->c[$k]['out'] = (string) substr($out, $n);
        }
        if ($this->c[$k]['out'] === '' && $this->c[$k]['fechar']) {
            $this->desconectar($k);
        }
    }

    private function desconectar(int $k): void
    {
        if (!isset($this->c[$k])) {
            return;
        }
        $s = $this->c[$k]['sock'];
        $this->sairDaSala($k);
        unset($this->c[$k]);
        @fclose($s);
    }

    private function manutencao(float $agora): void
    {
        foreach (array_keys($this->c) as $k) {
            if (!isset($this->c[$k])) {
                continue;
            }
            $cl = $this->c[$k];
            $limite = $cl['ws'] ? TIMEOUT_WS : TIMEOUT_HTTP;
            if ($agora - $cl['visto'] > $limite) {
                $this->desconectar($k);
                continue;
            }
            if ($cl['ws'] && !$cl['fechar'] && $agora - $cl['ping'] > PING_A_CADA) {
                $this->c[$k]['ping'] = $agora;
                $this->enfileirar($k, $this->frame('', 0x9));
            }
        }
        foreach ($this->falhas as $ip => $ts) {
            if (!$ts || time() - max($ts) > JANELA_FALHAS) {
                unset($this->falhas[$ip]);
            }
        }
    }

    private function log(string $msg): void
    {
        fwrite(STDOUT, date('Y-m-d H:i:s') . ' ' . $msg . "\n");
    }
}

date_default_timezone_set(getenv('TZ') ?: 'America/Sao_Paulo');
(new Servidor(
    (int) (getenv('PORTA') ?: 8080),
    __DIR__ . '/public',
    __DIR__ . '/aulas',
    rtrim((string) (getenv('DADOS') ?: __DIR__ . '/dados'), '/'),
    (string) getenv('SENHA_PROFESSOR')
))->rodar();
